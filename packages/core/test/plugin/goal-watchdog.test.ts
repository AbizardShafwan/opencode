import { describe, expect } from "bun:test"
import { DateTime, Duration, Effect, Option, Queue, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { Plugin } from "@opencode/plugin/effect"
import type { CommandDefinition } from "@opencode/plugin/effect/command"
import { Event } from "@opencode/schema/event"
import { Goal } from "@opencode/schema/goal"
import { GoalPlugin } from "@opencode/core/plugin/goal"
import { Job } from "@opencode/core/job"
import { Mcp } from "@opencode/core/mcp/index"
import { Session } from "@opencode/core/session"
import { SessionExternalWait } from "@opencode/core/session/external-wait"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionStore } from "@opencode/core/session/store"
import { AbsolutePath } from "@opencode/core/schema"
import type { SessionEvent } from "@opencode/core/session/event"
import type { SessionEvent as SchemaSessionEvent } from "@opencode/schema/session-event"
import { it } from "../lib/effect"
import { host } from "./host"

const sessionID = Session.ID.make("ses_goal_watchdog")
// A subagent working for the goal Session, and the subagent's own subagent.
const child = Session.ID.make("ses_goal_watchdog_child")
const grandchild = Session.ID.make("ses_goal_watchdog_grandchild")
const unrelated = Session.ID.make("ses_goal_watchdog_unrelated")
const parents: Record<string, Session.ID | undefined> = { [child]: sessionID, [grandchild]: child }

type Execution = SessionEvent.Execution.Started | SessionEvent.Execution.Succeeded
type Watched = Execution | SessionEvent.Step.Started | SchemaSessionEvent.ExternalWait.Changed | SessionEvent.Moved

const execution = (type: Execution["type"], target = sessionID): Execution => ({
  id: Event.ID.create(),
  created: 0,
  durable: { aggregateID: target, seq: Event.Seq.make(0), version: Event.Version.make(1) },
  type,
  data: { sessionID: target },
})

// SAFETY: the plugin reads only the type and Session ID of a step event.
const step = (stepSessionID: Session.ID) =>
  ({ type: "session.step.started", data: { sessionID: stepSessionID } }) as unknown as SessionEvent.Step.Started

const externalWaitChanged = (target = sessionID, directory = "/workspace") =>
  ({
    id: Event.ID.create(),
    created: 0,
    type: "session.external_wait.changed",
    location: { directory: AbsolutePath.make(directory) },
    data: { sessionID: target },
  }) as unknown as SchemaSessionEvent.ExternalWait.Changed

const sessionMoved = (target = sessionID, directory = "/other-workspace") =>
  ({
    id: Event.ID.create(),
    created: 0,
    type: "session.moved",
    data: { sessionID: target, location: { directory: AbsolutePath.make(directory) } },
  }) as unknown as SessionEvent.Moved

/** Runs the goal plugin against stubbed domains: plugin storage in memory, and RPC that records what it publishes. */
const run = Effect.fnUntraced(function* (
  seed?: Goal.State,
  options?: { isExecuting?: boolean; runningBackground?: unknown[]; externalWait?: { readonly live: boolean } },
) {
  let backgroundJobs = options?.runningBackground ?? []
  let externalLive = options?.externalWait?.live ?? false
  const stored = new Map<string, Schema.Json>(seed ? [[`session:${sessionID}`, seed]] : [])
  const changed: unknown[] = []
  const handlers: { get?: (input: { sessionID: string }) => Effect.Effect<Goal.State | null> } = {}
  const events = yield* Queue.unbounded<Watched>()
  const commands: CommandDefinition[] = []
  const hooks = new Map<string, (event: never) => Effect.Effect<void>>()
  const judgePrompts: string[] = []
  const synthetics: Array<{ sessionID: Session.ID; text: string }> = []
  let judgeReply = '{"verdict":"done","reason":"Done."}'
  const info = (id: Session.ID) =>
    // SAFETY: the plugin reads only the id, parent, title and creation time of a Session.
    ({
      id,
      parentID: parents[id],
      title: "Release",
      time: { created: DateTime.makeUnsafe(0) },
      location: { directory: AbsolutePath.make("/workspace") },
    }) as unknown as Session.Info
  const session: Partial<Plugin.Context["session"]> = {
    // SAFETY: these tests drive the plugin through events and commands, not its session hooks.
    hook: ((name: string, callback: (event: never) => Effect.Effect<void>) =>
      Effect.sync(() => void hooks.set(name, callback))) as never,
    get: (input) => Effect.sync(() => info(input.sessionID)),
    update: () => Effect.void,
    synthetic: (input) =>
      Effect.sync(() => {
        synthetics.push({ sessionID: input.sessionID, text: input.text })
        return { id: SessionMessage.ID.create() } as never
      }),
    context: () => Effect.succeed([]),
    generate: ((input: { readonly prompt: string }) =>
      Effect.sync(() => {
        judgePrompts.push(input.prompt)
        return { text: judgeReply }
      })) as never,
  }
  const start = GoalPlugin.Plugin.effect(
    host({
      session,
      storage: {
        get: (key) => Effect.sync(() => stored.get(key)),
        set: (key, value) => Effect.sync(() => void stored.set(key, value)),
        remove: (key) => Effect.sync(() => void stored.delete(key)),
        scan: (options) =>
          Effect.sync(() => ({
            entries: [...stored].flatMap(([key, value]) => (key.startsWith(options.prefix) ? [{ key, value }] : [])),
          })),
      },
      rpc: Object.assign(
        () => {
          throw new Error("unused rpc.client")
        },
        {
          // SAFETY: the goal plugin registers one RPC, whose `get` handler and `changed` events these tests observe.
          register: ((_definition: unknown, registered: typeof handlers) =>
            Effect.sync(() => {
              handlers.get = registered.get
              return {
                dispose: Effect.void,
                events: { emit: (_name: string, data: unknown) => Effect.sync(() => void changed.push(data)) },
              }
            })) as never,
        },
      ),
      // SAFETY: the plugin only filters the stream by event type.
      event: { subscribe: () => Stream.fromQueue(events) as never },
      command: {
        list: () => Effect.die(new Error("unused command.list")),
        transform: (callback) =>
          Effect.sync(() => callback({ add: (definition) => void commands.push(definition) })) as never,
        reload: () => Effect.die(new Error("unused command.reload")),
      },
    }),
  )
  const jobService = Job.Service.of({
    runningBackground: Effect.sync(() => backgroundJobs as any),
  } as any)
  const storeService = SessionStore.Service.of({
    get: (id: Session.ID) => Effect.sync(() => ({ id, parentID: parents[id] } as any)),
  } as any)
  const waitService = SessionExternalWait.Service.of(
    {
      list: (_sessionID: Session.ID, listOptions?: SessionExternalWait.ListOptions) =>
        Effect.gen(function* () {
          if (!externalLive) return []
          if (listOptions?.isServerLive && !(yield* listOptions.isServerLive("t3-code-test"))) return []
          return [
            {
              waitID: "pr-watch:1",
              sessionID,
              source: "pull_request_watch",
              server: "t3-code-test",
              description: "Watching pull request #1",
              expiresAt: 0,
              boot: "test",
            },
          ]
        }),
    } as unknown as SessionExternalWait.Interface,
  )
  const mcpService = Mcp.Service.of({
    isAttached: () => Effect.succeed(externalLive),
  } as unknown as Mcp.Interface)
  yield* start.pipe(
    Effect.provideService(Job.Service, jobService),
    Effect.provideService(SessionStore.Service, storeService),
    Effect.provideService(SessionExternalWait.Service, waitService),
    Effect.provideService(Mcp.Service, mcpService),
  )
  // Let the forked event watcher and startup sweep start.
  yield* Effect.yieldNow
  return {
    setBackgroundJobs: (jobs: unknown[]) => {
      backgroundJobs = jobs
    },
    setExternalLive: (live: boolean) => {
      externalLive = live
    },
    /** Answers the next goal-reviewer generation with this verdict line. */
    reply: (text: string) => {
      judgeReply = text
    },
    judgePrompts,
    synthetics,
    /** Runs the plugin's registered experimental.idle hook as the runner would. */
    idle: (background: unknown[]) => {
      const handler = hooks.get("experimental.idle")
      if (!handler) return Effect.die(new Error("the goal plugin did not register experimental.idle"))
      return handler({ sessionID, background } as never)
    },
    goal: (target = sessionID) =>
      Option.getOrUndefined(Schema.decodeUnknownOption(Goal.State)(stored.get(`session:${target}`))),
    set: (target: Session.ID, state: Goal.State) => void stored.set(`session:${target}`, state),
    changed,
    get: () => handlers.get?.({ sessionID }) ?? Effect.die(new Error("the goal RPC was not registered")),
    command: (text: string) =>
      Effect.forEach(commands, (definition) =>
        definition.execute({ sessionID, prompt: { text }, delivery: "steer" }).pipe(Effect.orDie),
      ),
    emit: (type: Execution["type"], target = sessionID) =>
      Queue.offer(events, execution(type, target)).pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.yieldNow)),
    step: (stepSessionID: Session.ID) =>
      Queue.offer(events, step(stepSessionID)).pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.yieldNow)),
    externalWaitChanged: (target = sessionID, directory = "/workspace") =>
      Queue.offer(events, externalWaitChanged(target, directory)).pipe(
        Effect.andThen(Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow)),
      ),
    moved: (target = sessionID, directory = "/other-workspace") =>
      Queue.offer(events, sessionMoved(target, directory)).pipe(
        Effect.andThen(Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow)),
      ),
  }
})

describe("goal plugin waiting", () => {
  it.effect("pauses a goal an earlier server process left active when the plugin starts", () =>
    Effect.gen(function* () {
      const plugin = yield* run({
        id: "goal-earlier",
        objective: "Ship the release",
        status: "active",
        rounds: 1,
        maxRounds: 50,
        boot: "an-earlier-process",
        updatedAt: 0,
      })

      expect(plugin.goal()).toMatchObject({
        status: "paused",
        reason: "The server restarted while the goal was active",
      })
    }),
  )

  it.effect("restores waiting goal's watchdog on same-process reload and pauses after WAIT_LIMIT", () =>
    Effect.gen(function* () {
      const plugin = yield* run({
        id: "goal-same-process",
        objective: "Ship the release",
        status: "active",
        rounds: 1,
        maxRounds: 50,
        boot: GoalPlugin.boot(),
        updatedAt: 0,
      })

      // Active goal is NOT immediately paused on startup
      expect(plugin.goal()).toMatchObject({ status: "active" })

      // Watchdog was restored on startup because SessionExecution is not active: advancing time by WAIT_LIMIT pauses it
      yield* TestClock.adjust(GoalPlugin.WAIT_LIMIT)
      expect(plugin.goal()).toMatchObject({
        status: "paused",
        reason: "Nothing ran for 30 minutes while the goal waited on background work",
      })
    }),
  )

  it.effect("pauses a goal that sits idle past the limit, and not while the Session keeps running", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      yield* plugin.command("Ship the release")
      expect(plugin.goal()).toMatchObject({ status: "active" })

      // Waiting on background work: the execution ended with the goal still active.
      yield* plugin.emit("session.execution.succeeded")
      yield* TestClock.adjust(Duration.subtract(GoalPlugin.WAIT_LIMIT, Duration.minutes(1)))
      // The background work reports: the Session runs again, which cancels the wait.
      yield* plugin.emit("session.execution.started")
      yield* TestClock.adjust(Duration.minutes(5))
      expect(plugin.goal()).toMatchObject({ status: "active" })

      yield* plugin.emit("session.execution.succeeded")
      yield* TestClock.adjust(GoalPlugin.WAIT_LIMIT)
      expect(plugin.goal()).toMatchObject({
        status: "paused",
        reason: "Nothing ran for 30 minutes while the goal waited on background work",
      })
    }),
  )

  it.effect("keeps waiting while the Session itself keeps running steps", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      yield* plugin.command("Ship the release")
      yield* plugin.emit("session.execution.succeeded")

      // Steps on the goal session itself reset the timer
      yield* TestClock.adjust(Duration.subtract(GoalPlugin.WAIT_LIMIT, Duration.minutes(1)))
      yield* plugin.step(sessionID)
      yield* TestClock.adjust(Duration.subtract(GoalPlugin.WAIT_LIMIT, Duration.minutes(1)))
      yield* plugin.step(sessionID)
      yield* TestClock.adjust(Duration.subtract(GoalPlugin.WAIT_LIMIT, Duration.minutes(1)))
      expect(plugin.goal()).toMatchObject({ status: "active" })

      // Advancing past WAIT_LIMIT with no more steps pauses it
      yield* TestClock.adjust(Duration.minutes(2))
      expect(plugin.goal()).toMatchObject({
        status: "paused",
        reason: "Nothing ran for 30 minutes while the goal waited on background work",
      })
    }),
  )

  it.effect("keeps waiting while a descendant Session keeps running steps", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      yield* plugin.command("Ship the release")
      yield* plugin.emit("session.execution.succeeded")

      // A subagent below the goal Session works past the limit; each of its steps restarts the wait.
      yield* TestClock.adjust(Duration.subtract(GoalPlugin.WAIT_LIMIT, Duration.minutes(1)))
      yield* plugin.step(child)
      yield* TestClock.adjust(Duration.subtract(GoalPlugin.WAIT_LIMIT, Duration.minutes(1)))
      yield* plugin.step(grandchild)
      yield* TestClock.adjust(Duration.subtract(GoalPlugin.WAIT_LIMIT, Duration.minutes(1)))
      expect(plugin.goal()).toMatchObject({ status: "active" })

      // Another Session's steps say nothing about this goal's work.
      yield* plugin.step(unrelated)
      yield* TestClock.adjust(Duration.minutes(2))
      expect(plugin.goal()).toMatchObject({
        status: "paused",
        reason: "Nothing ran for 30 minutes while the goal waited on background work",
      })
    }),
  )

  it.effect("never overwrites what the user did after the loop decided", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      yield* plugin.command("Ship the release")
      yield* plugin.emit("session.execution.succeeded")
      yield* plugin.command("pause")

      // The wait was decided on the active goal; the user's pause since then wins.
      yield* TestClock.adjust(GoalPlugin.WAIT_LIMIT)
      expect(plugin.goal()).toMatchObject({ status: "paused", reason: "Paused by the user" })
    }),
  )

  it.effect("refreshes all waiting ancestor goals when a descendant runs steps", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      yield* plugin.command("Ship the release")
      plugin.set(child, {
        id: "goal-child",
        objective: "Child task",
        status: "active",
        rounds: 1,
        maxRounds: 50,
        boot: GoalPlugin.boot(),
        updatedAt: 0,
      })

      // Both sessionID (parent) and child enter waiting state
      yield* plugin.emit("session.execution.succeeded", sessionID)
      yield* plugin.emit("session.execution.succeeded", child)

      // Step from grandchild at 29 minutes (both should be refreshed)
      yield* TestClock.adjust(Duration.minutes(29))
      yield* plugin.step(grandchild)

      // Advance another 20 minutes (total 49 min from start, 20 min from grandchild step)
      yield* TestClock.adjust(Duration.minutes(20))

      // Both parent and child goals should still be active!
      expect(plugin.goal(sessionID)).toMatchObject({ status: "active" })
      expect(plugin.goal(child)).toMatchObject({ status: "active" })

      // Advance another 11 minutes (31 min from grandchild step) -> both should pause!
      yield* TestClock.adjust(Duration.minutes(11))
      expect(plugin.goal(sessionID)).toMatchObject({ status: "paused" })
      expect(plugin.goal(child)).toMatchObject({ status: "paused" })
    }),
  )

  it.effect("serves the goal over RPC and publishes every change", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      expect(yield* plugin.get()).toBeNull()

      yield* plugin.command("Ship the release")
      yield* plugin.command("pause")
      expect(yield* plugin.get()).toMatchObject({ objective: "Ship the release", status: "paused" })
      yield* plugin.command("clear")

      expect(yield* plugin.get()).toBeNull()
      expect(plugin.changed).toMatchObject([
        { sessionID, goal: { objective: "Ship the release", status: "active" } },
        { sessionID, goal: { status: "paused", reason: "Paused by the user" } },
        { sessionID, goal: null },
      ])
    }),
  )

  it.effect("restarts watchdog timer without pausing when background work is still running across locations", () =>
    Effect.gen(function* () {
      const plugin = yield* run(undefined, {
        runningBackground: [
          {
            kind: "subagent",
            parentSessionID: sessionID,
            childSessionID: child,
            agent: "reviewer",
            description: "testing",
          },
        ],
      })
      yield* plugin.command("Ship the release")
      yield* plugin.emit("session.execution.succeeded")

      // Advancing by WAIT_LIMIT checks SessionBackground.outstanding
      yield* TestClock.adjust(GoalPlugin.WAIT_LIMIT)
      // Because background job was running, watchdog restarted timer instead of pausing!
      expect(plugin.goal()).toMatchObject({ status: "active" })

      // Now background job finishes
      plugin.setBackgroundJobs([])

      // Advancing by WAIT_LIMIT again with no background work pauses it
      yield* TestClock.adjust(GoalPlugin.WAIT_LIMIT)
      expect(plugin.goal()).toMatchObject({
        status: "paused",
        reason: "Nothing ran for 30 minutes while the goal waited on background work",
      })
    }),
  )

  it.effect("offers and honors wait while an external wait is outstanding", () =>
    Effect.gen(function* () {
      const plugin = yield* run({
        id: "goal-external",
        objective: "Land the pull request",
        status: "active",
        rounds: 0,
        maxRounds: 50,
        boot: GoalPlugin.boot(),
        updatedAt: 0,
      })
      plugin.reply('{"verdict":"wait","reason":"Watching the pull request"}')

      yield* plugin.idle([
        {
          kind: "external",
          sessionID,
          waitID: "pr-watch:1",
          source: "pull_request_watch",
          server: "t3-code-test",
          description: "Watching pull request #1",
        },
      ])

      expect(plugin.judgePrompts).toHaveLength(1)
      expect(plugin.judgePrompts[0]).toContain("External work still running:")
      expect(plugin.judgePrompts[0]).toContain("Watching pull request #1")
      // The reviewer's "wait" is accepted and the goal keeps its budget instead of pausing.
      expect(plugin.goal()).toMatchObject({ status: "active", rounds: 0 })
    }),
  )

  it.effect("keeps waiting while a live external wait exists and pauses once its host disconnects", () =>
    Effect.gen(function* () {
      const plugin = yield* run(undefined, { externalWait: { live: true } })
      yield* plugin.command("Ship the release")
      yield* plugin.emit("session.execution.succeeded")

      // The host holds a live PR watch, so outstanding work keeps the goal waiting.
      yield* TestClock.adjust(GoalPlugin.WAIT_LIMIT)
      expect(plugin.goal()).toMatchObject({ status: "active" })

      // The MCP host disconnects: the lease is no longer outstanding, so the next check pauses.
      plugin.setExternalLive(false)
      yield* TestClock.adjust(GoalPlugin.WAIT_LIMIT)
      expect(plugin.goal()).toMatchObject({
        status: "paused",
        reason: "Nothing ran for 30 minutes while the goal waited on background work",
      })
    }),
  )

  it.effect("reacts immediately to session.external_wait.changed instead of waiting 30 minutes", () =>
    Effect.gen(function* () {
      const plugin = yield* run(undefined, { externalWait: { live: true } })
      yield* plugin.command("Land the pull request")
      yield* plugin.emit("session.execution.succeeded")
      plugin.reply('{"verdict":"continue","reason":"PR watch settled","next_step":"Check merge result"}')

      // Even immediately after settling (well before WAIT_LIMIT), GoalPlugin re-judges and admits continuation.
      yield* TestClock.adjust(Duration.seconds(5))
      plugin.setExternalLive(false)
      yield* plugin.externalWaitChanged(sessionID)

      expect(plugin.judgePrompts).toHaveLength(1)
      expect(plugin.synthetics).toHaveLength(2)
      expect(plugin.synthetics[1]?.text).toContain("PR watch settled")
      expect(plugin.goal()).toMatchObject({ status: "active", rounds: 1, reason: "PR watch settled" })

      // When settled and verdict is done, the goal completes immediately.
      yield* plugin.emit("session.execution.started")
      yield* plugin.emit("session.execution.succeeded")
      plugin.reply('{"verdict":"done","reason":"Pull request merged"}')
      yield* plugin.externalWaitChanged(sessionID)
      expect(plugin.goal()).toMatchObject({ status: "complete", reason: "Pull request merged" })
    }),
  )

  it.effect("keeps waiting when remaining waits exist on session.external_wait.changed and ignores active executions", () =>
    Effect.gen(function* () {
      const plugin = yield* run(undefined, { externalWait: { live: true } })
      yield* plugin.command("Land the pull request")

      // While execution is active, external wait change notifications do not trigger judge early.
      yield* plugin.emit("session.execution.started")
      yield* plugin.externalWaitChanged(sessionID)
      expect(plugin.judgePrompts).toEqual([])

      // Once idle with remaining external wait and judge answering "wait", the 30-min watchdog resumes.
      yield* plugin.emit("session.execution.succeeded")
      plugin.reply('{"verdict":"wait","reason":"Second watch still running"}')
      yield* plugin.externalWaitChanged(sessionID)
      expect(plugin.judgePrompts).toHaveLength(1)
      expect(plugin.goal()).toMatchObject({ status: "active" })

      // Moving the session to another location clears the source location's watchdog timer.
      yield* plugin.moved(sessionID, "/other-workspace")
      plugin.setExternalLive(false)
      yield* TestClock.adjust(GoalPlugin.WAIT_LIMIT)
      expect(plugin.goal()).toMatchObject({ status: "active" })
    }),
  )
})
