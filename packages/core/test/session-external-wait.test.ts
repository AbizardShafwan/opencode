import { describe, expect } from "bun:test"
import { Duration, Effect, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Bus } from "@opencode/core/bus"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { Session } from "@opencode/core/session"
import { SessionBackground } from "@opencode/core/session/background"
import { SessionExternalWait } from "@opencode/core/session/external-wait"
import { SessionStore } from "@opencode/core/session/store"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionEvent } from "@opencode/schema/session-event"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([KV.node, Bus.node, SessionExternalWait.node])))
const sessionID = Session.ID.make("ses_external_wait")
const otherSessionID = Session.ID.make("ses_external_wait_other")
const server = "t3-code-test"

const wait = (
  waitID: string,
  extra?: Partial<Omit<SessionExternalWait.RegisterInput, "sessionID" | "waitID">>,
): SessionExternalWait.RegisterInput => ({
  sessionID,
  waitID,
  source: "background_wait",
  server,
  description: `Waiting on ${waitID}`,
  ...extra,
})

describe("SessionExternalWait", () => {
  it.effect("registers, lists, and clears one wait", () =>
    Effect.gen(function* () {
      const waits = yield* SessionExternalWait.Service
      yield* waits.register(wait("bg:1"))
      yield* waits.register(wait("bg:2"))

      expect((yield* waits.list(sessionID)).map((entry) => entry.waitID).toSorted()).toEqual(["bg:1", "bg:2"])

      yield* waits.clear(sessionID, "bg:1")
      expect((yield* waits.list(sessionID)).map((entry) => entry.waitID)).toEqual(["bg:2"])
    }),
  )

  it.effect("expires a wait once its TTL passes", () =>
    Effect.gen(function* () {
      const waits = yield* SessionExternalWait.Service
      yield* waits.register(wait("pr-watch:1", { ttlMs: Duration.toMillis(Duration.minutes(5)) }))
      expect(yield* waits.list(sessionID)).toHaveLength(1)

      yield* TestClock.adjust(Duration.minutes(4))
      expect(yield* waits.list(sessionID)).toHaveLength(1)

      yield* TestClock.adjust(Duration.minutes(1))
      expect(yield* waits.list(sessionID)).toEqual([])
    }),
  )

  it.effect("clears a prefix without touching other sessions or waits", () =>
    Effect.gen(function* () {
      const waits = yield* SessionExternalWait.Service
      yield* waits.register(wait("pr-watch:1"))
      yield* waits.register(wait("pr-watch:2"))
      yield* waits.register(wait("bg:1"))
      yield* waits.register({ ...wait("pr-watch:other"), sessionID: otherSessionID })

      yield* waits.clearByPrefix(sessionID, "pr-watch:")
      expect((yield* waits.list(sessionID)).map((entry) => entry.waitID)).toEqual(["bg:1"])
      expect((yield* waits.list(otherSessionID)).map((entry) => entry.waitID)).toEqual(["pr-watch:other"])
    }),
  )

  it.effect("drops waits whose owning MCP server is no longer live", () =>
    Effect.gen(function* () {
      const waits = yield* SessionExternalWait.Service
      yield* waits.register(wait("pr-watch:live", { server: "live" }))
      yield* waits.register(wait("pr-watch:dead", { server: "dead" }))

      const live = yield* waits.list(sessionID, {
        isServerLive: (name) => Effect.succeed(name === "live"),
      })
      expect(live.map((entry) => entry.waitID)).toEqual(["pr-watch:live"])
    }),
  )

  it.effect("feeds live waits into outstanding work for the owning session", () =>
    Effect.gen(function* () {
      const waits = yield* SessionExternalWait.Service
      yield* waits.register(wait("pr-watch:7", { source: "pull_request_watch", description: "Watching pull request #7" }))
      yield* waits.register({ ...wait("pr-watch:8"), sessionID: otherSessionID })

      const store: Pick<SessionStore.Interface, "get"> = { get: () => Effect.succeed(undefined) }
      const jobs = { runningBackground: Effect.succeed([]) }
      const external = { waits, isServerLive: () => Effect.succeed(true) }

      const outstanding = yield* SessionBackground.outstanding(jobs, store, sessionID, external)
      expect(outstanding).toEqual([
        {
          kind: "external",
          sessionID,
          waitID: "pr-watch:7",
          source: "pull_request_watch",
          server,
          description: "Watching pull request #7",
        },
      ])

      // A disconnected host is not outstanding work, so a waiting goal can pause instead.
      const disconnected = yield* SessionBackground.outstanding(jobs, store, sessionID, {
        waits,
        isServerLive: () => Effect.succeed(false),
      })
      expect(disconnected).toEqual([])

      // Callers that only know about jobs keep their previous shape.
      expect(yield* SessionBackground.outstanding(jobs, store, sessionID)).toEqual([])
    }),
  )

  it.effect("purges KV leases when a session is archived or deleted", () =>
    Effect.gen(function* () {
      const waits = yield* SessionExternalWait.Service
      const bus = yield* Bus.Service
      const kv = yield* KV.Service
      yield* waits.register(wait("pr-watch:1"))
      yield* waits.register({ ...wait("pr-watch:2"), sessionID: otherSessionID })

      yield* bus.publish(SessionEvent.Archived, { sessionID })
      yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow)
      expect((yield* kv.scan({ prefix: `external.wait/${sessionID}/` })).entries).toEqual([])
      expect(yield* waits.list(otherSessionID)).toHaveLength(1)

      yield* bus.publish(SessionEvent.Deleted, { sessionID: otherSessionID })
      yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow)
      expect((yield* kv.scan({ prefix: `external.wait/${otherSessionID}/` })).entries).toEqual([])
    }),
  )

  it.effect("lists active waits across all sessions with single-scan pruning and liveness filtering", () =>
    Effect.gen(function* () {
      const waits = yield* SessionExternalWait.Service
      yield* waits.register(wait("pr-watch:1", { server: "live", ttlMs: Duration.toMillis(Duration.minutes(10)) }))
      yield* waits.register(wait("pr-watch:expired", { server: "live", ttlMs: Duration.toMillis(Duration.minutes(2)) }))
      yield* waits.register({ ...wait("bg:2", { server: "down" }), sessionID: otherSessionID })

      yield* TestClock.adjust(Duration.minutes(3))

      const liveOnly = yield* waits.listAll({ isServerLive: (name) => Effect.succeed(name === "live") })
      expect(liveOnly.map((entry) => `${entry.sessionID}:${entry.waitID}`)).toEqual([`${sessionID}:pr-watch:1`])

      // Disconnected host leases stay in KV so re-attachment recovers them.
      const all = yield* waits.listAll()
      expect(all.map((entry) => entry.waitID).toSorted()).toEqual(["bg:2", "pr-watch:1"])
    }),
  )

  it.effect("emits SessionEvent.ExternalWait.Changed with location only on actual state mutations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const waits = yield* SessionExternalWait.Service
        const bus = yield* Bus.Service
        const ref = Location.Ref.make({ directory: AbsolutePath.make("/repo-wait-bus") })
        const events: Array<{ sessionID: string; directory?: string }> = []

        yield* bus.subscribe(SessionEvent.ExternalWait.Changed).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push({ sessionID: event.data.sessionID, directory: event.location?.directory })
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )

        yield* waits.register({ ...wait("pr-watch:1"), location: ref })
        yield* waits.clear(sessionID, "pr-watch:missing", { location: ref })
        yield* waits.clearByPrefix(sessionID, "missing:", { location: ref })
        yield* waits.clear(sessionID, "pr-watch:1", { location: ref })
        yield* waits.clear(sessionID, "pr-watch:1", { location: ref })
        yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow)

        expect(events).toEqual([
          { sessionID, directory: ref.directory },
          { sessionID, directory: ref.directory },
        ])
      }),
    ),
  )
})
