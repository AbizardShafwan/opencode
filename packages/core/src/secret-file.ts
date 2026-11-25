export * as SecretFile from "./secret-file.js"

import { ToolFailure } from "@opencode/ai"
import { SessionEvent } from "@opencode/schema/session-event"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { comparablePath } from "@opencode/util/path"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import path from "path"
import { Clock, Context, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { Bus } from "./bus.js"
import { KV } from "./kv.js"

/**
 * Secret files written by a verified host's `request_secret(delivery: "file")`. Registered paths are kept
 * in KV for a bounded time so the read, grep and shell tools can refuse to surface their contents.
 *
 * This is application-level accident prevention, not an OS sandbox: a determined command can still
 * read the file through means these checks do not recognize.
 */

const PREFIX = "secret.file/"
export const TTL = Duration.hours(1)

const Entry = Schema.Struct({
  path: Schema.String,
  realpath: Schema.String,
  sessionID: Schema.String,
  expiresAt: Schema.Number,
})
type Entry = typeof Entry.Type
const decodeEntry = Schema.decodeUnknownOption(Entry)

export const PROTECTED_MESSAGE =
  "This file holds a secret delivered by the host. Do not read, search or print secret files directly; pass the path only to the command that consumes it."

export interface Interface {
  /** Protect a delivered secret file for the bounded TTL. */
  readonly register: (file: string, sessionID: string) => Effect.Effect<void>
  /** Whether a path, or the file it resolves to through symlinks, is an active secret file. */
  readonly isProtected: (file: string) => Effect.Effect<boolean>
  /** Fails with a model-facing ToolFailure when the path is an active secret file. */
  readonly assertReadable: (file: string) => Effect.Effect<void, ToolFailure>
  /** Every active secret file, by both its registered and resolved paths. */
  readonly active: () => Effect.Effect<ReadonlyArray<Entry>>
  /** Active secret files whose registered or resolved path appears in a command string. */
  readonly matchPathsInCommand: (command: string) => Effect.Effect<ReadonlyArray<Entry>>
  /** Best-effort exact contents of secret files, for scrubbing output; unreadable files are skipped. */
  readonly readSecretBytes: (entries: ReadonlyArray<Entry>) => Effect.Effect<ReadonlyArray<string>>
  /** Removes all secret-file registrations owned by a session (and prunes expired rows encountered). */
  readonly clearSession: (sessionID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SecretFile") {}

export function normalizeKeyPath(resolved: string, platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") return resolved
  return comparablePath(resolved).toLowerCase()
}

const key = (resolved: string) =>
  `${PREFIX}${createHash("sha256").update(normalizeKeyPath(resolved)).digest("hex")}`

// A missing or unreadable path falls back to its lexical resolution, so lookups never fail.
const resolve = (file: string) => {
  const lexical = path.resolve(FSUtil.windowsPath(file))
  return Effect.try(() => realpathSync.native(lexical)).pipe(Effect.orElseSucceed(() => lexical))
}

function windowsCommandCandidates(file: string) {
  const forward = file.replaceAll("\\", "/").toLowerCase()
  const match = /^([a-z]):\/(.*)$/.exec(forward)
  if (!match) return [forward]
  const drive = match[1]
  const rest = match[2]
  return [forward, `/${drive}/${rest}`, `/${drive}:/${rest}`, `/cygdrive/${drive}/${rest}`, `/mnt/${drive}/${rest}`]
}

export function matchesCommandPath(
  command: string,
  entry: Pick<Entry, "path" | "realpath">,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "win32") return command.includes(entry.path) || command.includes(entry.realpath)
  const normalizedCommand = command.replaceAll("\\", "/").toLowerCase()
  const unescapedCommand = command
    .replaceAll("\\ ", " ")
    .replaceAll("\\\\", "/")
    .replaceAll("\\", "/")
    .toLowerCase()
  return [entry.path, entry.realpath]
    .flatMap(windowsCommandCandidates)
    .some((candidate) => normalizedCommand.includes(candidate) || unescapedCommand.includes(candidate))
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const bus = yield* Bus.Service

    const lookup = Effect.fnUntraced(function* (storageKey: string) {
      const entry = decodeEntry(yield* kv.get(storageKey))
      if (Option.isNone(entry)) return undefined
      if (entry.value.expiresAt > (yield* Clock.currentTimeMillis)) return entry.value
      yield* kv.remove(storageKey)
      return undefined
    })

    const register = Effect.fn("SecretFile.register")(function* (file: string, sessionID: string) {
      const lexical = path.resolve(FSUtil.windowsPath(file))
      const resolved = yield* resolve(file)
      const expiresAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(TTL)
      yield* kv.set(key(resolved), { path: lexical, realpath: resolved, sessionID, expiresAt })
    })

    const isProtected = Effect.fn("SecretFile.isProtected")(function* (file: string) {
      return (yield* lookup(key(yield* resolve(file)))) !== undefined
    })

    const assertReadable = Effect.fn("SecretFile.assertReadable")(function* (file: string) {
      if (yield* isProtected(file)) return yield* new ToolFailure({ message: PROTECTED_MESSAGE })
    })

    const active = Effect.fn("SecretFile.active")(function* () {
      // TTL-bounded: entries expire within an hour, so the set stays small and one page suffices in practice.
      const entries = new Array<Entry>()
      let after: string | undefined
      do {
        const page = yield* kv.scan({ prefix: PREFIX, after, limit: 1000 })
        for (const item of page.entries) {
          const entry = yield* lookup(item.key)
          if (entry) entries.push(entry)
        }
        after = page.next
      } while (after !== undefined)
      return entries
    })

    const matchPathsInCommand = Effect.fn("SecretFile.matchPathsInCommand")(function* (command: string) {
      return (yield* active()).filter((entry) => matchesCommandPath(command, entry))
    })

    const readSecretBytes = Effect.fn("SecretFile.readSecretBytes")(function* (entries: ReadonlyArray<Entry>) {
      // Check stat before opening so FIFOs, sockets, and device nodes are never blocked on or drained
      // before the target command reads them. Regular files remain covered by application scrubbing,
      // while OS-level sandboxing of child commands is out of scope here.
      const contents = yield* Effect.forEach(entries, (entry) =>
        Effect.promise(async () => {
          const info = await stat(entry.realpath).catch(() => undefined)
          if (!info?.isFile()) return ""
          return readFile(entry.realpath, "utf8").catch(() => "")
        }),
      )
      return contents.filter((content) => content.length > 0)
    })

    const clearSession = Effect.fn("SecretFile.clearSession")(function* (sessionID: string) {
      const now = yield* Clock.currentTimeMillis
      let after: string | undefined
      do {
        const page = yield* kv.scan({ prefix: PREFIX, after, limit: 1000 })
        for (const item of page.entries) {
          const decoded = decodeEntry(item.value)
          if (Option.isNone(decoded) || decoded.value.expiresAt <= now || decoded.value.sessionID === sessionID)
            yield* kv.remove(item.key)
        }
        after = page.next
      } while (after !== undefined)
    })

    yield* bus.subscribe().pipe(
      Stream.filter(
        (event): event is SessionEvent.Deleted | SessionEvent.Archived =>
          event.type === SessionEvent.Deleted.type || event.type === SessionEvent.Archived.type,
      ),
      Stream.runForEach((event) =>
        clearSession(event.data.sessionID).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to clear secret files for session", {
              sessionID: event.data.sessionID,
              cause,
            }),
          ),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    return Service.of({ register, isProtected, assertReadable, active, matchPathsInCommand, readSecretBytes, clearSession })
  }),
)

/** Replaces every exact occurrence of each secret, including its trimmed form, with a placeholder. */
export function scrub(text: string, secrets: ReadonlyArray<string>) {
  return secrets
    .flatMap((secret) => [secret, secret.trim()])
    .filter((secret) => secret.length > 0)
    .toSorted((left, right) => right.length - left.length)
    .reduce((current, secret) => current.replaceAll(secret, "[REDACTED]"), text)
}

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node, Bus.node] })
