export * as SessionExternalWait from "./external-wait.js"

import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionEvent } from "@opencode/schema/session-event"
import { Clock, Context, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { Bus } from "../bus.js"
import { KV } from "../kv.js"
import type { SessionSchema } from "./schema.js"

/**
 * Bounded, KV-persisted external wait leases owned by a verified host (such as PR watches,
 * async delegated tasks, or explicit `t3_background_wait` calls). Kept separate from `Job.Info`
 * so the wire schema stays unchanged while `SessionBackground` and `GoalPlugin` can observe
 * active external waits with mandatory TTL expiration and MCP liveness checks.
 */

const PREFIX = "external.wait/"
export const DEFAULT_TTL = Duration.minutes(30)
export const MAX_TTL = Duration.hours(24)

const currentBoot = crypto.randomUUID()

export const Entry = Schema.Struct({
  waitID: Schema.String,
  sessionID: Schema.String,
  source: Schema.String,
  server: Schema.String,
  description: Schema.String,
  expiresAt: Schema.Number,
  boot: Schema.String,
})
export type Entry = typeof Entry.Type

const decodeEntry = Schema.decodeUnknownOption(Entry)

export interface RegisterInput {
  readonly sessionID: SessionSchema.ID
  readonly waitID: string
  readonly source: string
  readonly server: string
  readonly description: string
  readonly ttlMs?: number
}

export interface ListOptions {
  /** Verifies that the owning MCP server connection is still live. */
  readonly isServerLive?: (server: string) => Effect.Effect<boolean>
}

export interface Interface {
  readonly register: (input: RegisterInput) => Effect.Effect<Entry>
  readonly clear: (sessionID: SessionSchema.ID, waitID: string) => Effect.Effect<void>
  readonly clearByPrefix: (sessionID: SessionSchema.ID, waitPrefix: string) => Effect.Effect<void>
  readonly clearSession: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly list: (sessionID: SessionSchema.ID, options?: ListOptions) => Effect.Effect<ReadonlyArray<Entry>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionExternalWait") {}

const storageKey = (sessionID: string, waitID: string) => `${PREFIX}${sessionID}/${waitID}`
const sessionPrefix = (sessionID: string) => `${PREFIX}${sessionID}/`

function clampTtl(ttlMs?: number) {
  const fallback = Duration.toMillis(DEFAULT_TTL)
  if (ttlMs === undefined || !Number.isFinite(ttlMs) || ttlMs <= 0) return fallback
  return Math.min(Math.round(ttlMs), Duration.toMillis(MAX_TTL))
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const bus = yield* Bus.Service

    const scanSession = Effect.fnUntraced(function* (sessionID: string) {
      const entries = new Array<{ readonly key: string; readonly entry: Entry }>()
      let after: string | undefined
      const prefix = sessionPrefix(sessionID)
      do {
        const page = yield* kv.scan({ prefix, after, limit: 1000 })
        for (const item of page.entries) {
          const decoded = decodeEntry(item.value)
          if (Option.isNone(decoded)) {
            yield* kv.remove(item.key)
            continue
          }
          entries.push({ key: item.key, entry: decoded.value })
        }
        after = page.next
      } while (after !== undefined)
      return entries
    })

    const register = Effect.fn("SessionExternalWait.register")(function* (input: RegisterInput) {
      const now = yield* Clock.currentTimeMillis
      const entry: Entry = {
        waitID: input.waitID,
        sessionID: input.sessionID,
        source: input.source,
        server: input.server,
        description: input.description,
        expiresAt: now + clampTtl(input.ttlMs),
        boot: currentBoot,
      }
      yield* kv.set(storageKey(input.sessionID, input.waitID), entry)
      return entry
    })

    const clear = Effect.fn("SessionExternalWait.clear")(function* (sessionID: SessionSchema.ID, waitID: string) {
      yield* kv.remove(storageKey(sessionID, waitID))
    })

    const clearByPrefix = Effect.fn("SessionExternalWait.clearByPrefix")(function* (
      sessionID: SessionSchema.ID,
      waitPrefix: string,
    ) {
      const items = yield* scanSession(sessionID)
      for (const item of items) {
        if (item.entry.waitID.startsWith(waitPrefix)) yield* kv.remove(item.key)
      }
    })

    const clearSession = Effect.fn("SessionExternalWait.clearSession")(function* (sessionID: SessionSchema.ID) {
      const items = yield* scanSession(sessionID)
      for (const item of items) {
        yield* kv.remove(item.key)
      }
    })

    const list = Effect.fn("SessionExternalWait.list")(function* (
      sessionID: SessionSchema.ID,
      options?: ListOptions,
    ) {
      const now = yield* Clock.currentTimeMillis
      const items = yield* scanSession(sessionID)
      const active = new Array<Entry>()
      for (const item of items) {
        // Expire leases past TTL or left behind from an earlier server boot without re-confirmation.
        if (item.entry.expiresAt <= now || item.entry.boot !== currentBoot) {
          yield* kv.remove(item.key)
          continue
        }
        if (options?.isServerLive && !(yield* options.isServerLive(item.entry.server))) continue
        active.push(item.entry)
      }
      return active
    })

    yield* bus.subscribe().pipe(
      Stream.filter(
        (event): event is SessionEvent.Deleted | SessionEvent.Archived =>
          event.type === SessionEvent.Deleted.type || event.type === SessionEvent.Archived.type,
      ),
      Stream.runForEach((event) =>
        clearSession(event.data.sessionID).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to clear external waits for session", {
              sessionID: event.data.sessionID,
              cause,
            }),
          ),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    return Service.of({ register, clear, clearByPrefix, clearSession, list })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node, Bus.node] })
