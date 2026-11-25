export * as SessionExternalWait from "./external-wait.js"

import { makeGlobalNode } from "@opencode/util/effect/app-node"
import type { Location } from "@opencode/schema/location"
import { SessionEvent } from "@opencode/schema/session-event"
import { Clock, Context, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { Bus } from "../bus.js"
import { KV } from "../kv.js"
import type { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

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
  readonly location?: Location.Ref
}

export interface ChangeOptions {
  readonly location?: Location.Ref
}

export interface ListOptions {
  /** Verifies that the owning MCP server connection is still live. */
  readonly isServerLive?: (server: string) => Effect.Effect<boolean>
}

export interface Interface {
  readonly register: (input: RegisterInput) => Effect.Effect<Entry>
  readonly clear: (sessionID: SessionSchema.ID, waitID: string, options?: ChangeOptions) => Effect.Effect<void>
  readonly clearByPrefix: (
    sessionID: SessionSchema.ID,
    waitPrefix: string,
    options?: ChangeOptions,
  ) => Effect.Effect<void>
  readonly clearSession: (sessionID: SessionSchema.ID, options?: ChangeOptions) => Effect.Effect<void>
  readonly list: (sessionID: SessionSchema.ID, options?: ListOptions) => Effect.Effect<ReadonlyArray<Entry>>
  readonly listAll: (options?: ListOptions) => Effect.Effect<ReadonlyArray<Entry>>
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
    const store = yield* Effect.serviceOption(SessionStore.Service)

    const resolveLocation = (sessionID: SessionSchema.ID, explicit?: Location.Ref) => {
      if (explicit) return Effect.succeed(explicit)
      if (Option.isNone(store)) return Effect.succeed(undefined)
      return store.value.get(sessionID).pipe(
        Effect.map((session) => session?.location),
        Effect.orElseSucceed(() => undefined),
      )
    }

    const notifyChanged = (sessionID: SessionSchema.ID, explicit?: Location.Ref) =>
      Effect.gen(function* () {
        const location = yield* resolveLocation(sessionID, explicit)
        yield* bus.publish(
          SessionEvent.ExternalWait.Changed,
          { sessionID },
          location ? { location } : undefined,
        )
      })

    const scanPrefix = Effect.fnUntraced(function* (prefix: string) {
      const entries = new Array<{ readonly key: string; readonly entry: Entry }>()
      let after: string | undefined
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

    const scanSession = (sessionID: string) => scanPrefix(sessionPrefix(sessionID))

    const filterActive = Effect.fnUntraced(function* (
      items: ReadonlyArray<{ readonly key: string; readonly entry: Entry }>,
      options?: ListOptions,
    ) {
      const now = yield* Clock.currentTimeMillis
      const results = yield* Effect.forEach(items, (item) =>
        Effect.gen(function* () {
          // Expire leases past TTL or left behind from an earlier server boot without re-confirmation.
          if (item.entry.expiresAt <= now || item.entry.boot !== currentBoot) {
            yield* kv.remove(item.key)
            return undefined
          }
          if (options?.isServerLive && !(yield* options.isServerLive(item.entry.server))) return undefined
          return item.entry
        }),
      )
      return results.filter((entry): entry is Entry => entry !== undefined)
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
      yield* notifyChanged(input.sessionID, input.location)
      return entry
    })

    const clear = Effect.fn("SessionExternalWait.clear")(function* (
      sessionID: SessionSchema.ID,
      waitID: string,
      options?: ChangeOptions,
    ) {
      const key = storageKey(sessionID, waitID)
      if ((yield* kv.get(key)) === undefined) return
      yield* kv.remove(key)
      yield* notifyChanged(sessionID, options?.location)
    })

    const clearByPrefix = Effect.fn("SessionExternalWait.clearByPrefix")(function* (
      sessionID: SessionSchema.ID,
      waitPrefix: string,
      options?: ChangeOptions,
    ) {
      const items = (yield* scanSession(sessionID)).filter((item) => item.entry.waitID.startsWith(waitPrefix))
      if (items.length === 0) return
      yield* Effect.forEach(items, (item) => kv.remove(item.key), { discard: true })
      yield* notifyChanged(sessionID, options?.location)
    })

    const clearSession = Effect.fn("SessionExternalWait.clearSession")(function* (
      sessionID: SessionSchema.ID,
      options?: ChangeOptions,
    ) {
      const items = yield* scanSession(sessionID)
      if (items.length === 0) return
      yield* Effect.forEach(items, (item) => kv.remove(item.key), { discard: true })
      yield* notifyChanged(sessionID, options?.location)
    })

    const list = Effect.fn("SessionExternalWait.list")(function* (
      sessionID: SessionSchema.ID,
      options?: ListOptions,
    ) {
      return yield* filterActive(yield* scanSession(sessionID), options)
    })

    const listAll = Effect.fn("SessionExternalWait.listAll")(function* (options?: ListOptions) {
      return yield* filterActive(yield* scanPrefix(PREFIX), options)
    })

    yield* bus.subscribe().pipe(
      Stream.filter(
        (event): event is SessionEvent.Deleted | SessionEvent.Archived =>
          event.type === SessionEvent.Deleted.type || event.type === SessionEvent.Archived.type,
      ),
      Stream.runForEach((event) =>
        clearSession(event.data.sessionID, { location: event.location }).pipe(
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

    return Service.of({ register, clear, clearByPrefix, clearSession, list, listAll })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node, Bus.node] })
