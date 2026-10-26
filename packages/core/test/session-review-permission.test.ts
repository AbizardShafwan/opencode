import { beforeEach, describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Command } from "@opencode/core/command"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { CommandPlugin } from "@opencode/core/plugin/command"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { Money } from "@opencode/schema/money"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { emptyMcpLayer } from "./fixture/mcp"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

const parentID = Session.ID.make("ses_review_permission_parent")
const parentModel = Model.Ref.parse("test/parent")
const parent = {
  id: parentID,
  agent: Agent.ID.make("build"),
  model: parentModel,
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: { directory: AbsolutePath.make("/project") },
} satisfies Session.Info

const calls = {
  creates: [] as Parameters<Session.Interface["create"]>[0][],
  prompts: [] as Parameters<Session.Interface["prompt"]>[0][],
  notices: [] as SessionEvent.Synthetic[],
}

beforeEach(() => {
  calls.creates.length = 0
  calls.prompts.length = 0
  calls.notices.length = 0
})

const sessionMock = Layer.mock(Session.Service, {
  get: () => Effect.succeed(parent),
  active: Effect.succeed(new Set<Session.ID>()),
  create: (input) =>
    Effect.sync(() => {
      calls.creates.push(input)
      return { ...parent, id: Session.ID.make("ses_review_permission_child"), parentID }
    }),
  prompt: (input) =>
    Effect.sync(() => {
      calls.prompts.push(input)
      return Effect.die("unexpected prompt")
    }).pipe(Effect.flatten),
  interrupt: () => Effect.succeed(false),
  archive: () => Effect.void,
  revert: {
    stage: () => Effect.die("unused"),
    clear: () => Effect.die("unused"),
    commit: () => Effect.die("unused"),
  },
})

const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        SessionStore.node,
        PermissionSaved.node,
        Agent.node,
        Permission.node,
        Command.node,
        Mcp.node,
      ]),
      [
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
          ),
        ),
        Mcp.node.replace(emptyMcpLayer),
      ],
    ),
    Layer.mergeAll(
      sessionMock,
      Layer.mock(Model.Service, {}),
      Layer.mock(SubagentJob.Service, {}),
    ),
  ) as unknown as Layer.Layer<unknown, never>,
)

const registerReview = Effect.gen(function* () {
  const command = yield* Command.Service
  yield* CommandPlugin.Plugin.effect(
    host({
      command: {
        list: () => Effect.die("unused command.list"),
        transform: command.transform,
        reload: command.reload,
      },
    }),
  ).pipe(Effect.provideService(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))))
  return command
})

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: parentID,
      project_id: Project.ID.global,
      slug: "review-permission",
      directory: "/project",
      title: "review permission",
      version: "test",
      agent: Agent.ID.make("build"),
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
      agent.permissions = [{ action: "subagent", resource: "*", effect: "ask" }]
    })
    editor.update(Agent.ID.make("review"), (agent) => {
      agent.name = Agent.Name.make("Review")
      agent.mode = "subagent"
      agent.hidden = true
      agent.system = "review"
    })
  })
})

const decline = (message?: string) =>
  Effect.gen(function* () {
    const command = yield* registerReview
    yield* seed
    const bus = yield* Bus.Service
    const permission = yield* Permission.Service
    const asked = yield* Deferred.make<Permission.Request>()
    const unsubscribe = yield* bus.listen((event) => {
      if (event.type === Permission.Event.Asked.type)
        return Deferred.succeed(asked, event.data as Permission.Request).pipe(Effect.asVoid)
      if (event.type === SessionEvent.Synthetic.type)
        calls.notices.push(event.data as SessionEvent.Synthetic)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    const fiber = yield* command
      .execute({
        name: "review",
        invocation: { sessionID: parentID, prompt: { text: "main" }, delivery: "steer" },
      })
      .pipe(Effect.exit, Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    yield* permission.reply({ requestID: request.id, reply: "reject", message })
    const exit = yield* Fiber.join(fiber)
    return { exit, permission }
  })

describe("SessionReview permission decline", () => {
  it.effect("maps a rejected permission request to a typed command error without launching", () =>
    Effect.gen(function* () {
      const { exit, permission } = yield* decline()

      if (!Exit.isFailure(exit)) return yield* Effect.die("expected command failure")
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "Command.ExecutionError",
        message: "Review permission was declined.",
      })
      expect(calls.creates).toEqual([])
      expect(calls.prompts).toEqual([])
      expect(calls.notices).toEqual([])
      expect(yield* permission.list()).toEqual([])
      expect(yield* permission.forSession(parentID)).toEqual([])
    }),
  )

  it.effect("preserves permission feedback in the typed command error", () =>
    Effect.gen(function* () {
      const { exit, permission } = yield* decline("not now")

      if (!Exit.isFailure(exit)) return yield* Effect.die("expected command failure")
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "Command.ExecutionError",
        message: "Review permission was declined: not now",
      })
      expect(calls.creates).toEqual([])
      expect(calls.prompts).toEqual([])
      expect(calls.notices).toEqual([])
      expect(yield* permission.list()).toEqual([])
      expect(yield* permission.forSession(parentID)).toEqual([])
    }),
  )

  it.effect("does not convert permission interruption and clears the pending request", () =>
    Effect.gen(function* () {
      const command = yield* registerReview
      yield* seed
      const bus = yield* Bus.Service
      const permission = yield* Permission.Service
      const asked = yield* Deferred.make<Permission.Request>()
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Permission.Event.Asked.type
          ? Deferred.succeed(asked, event.data as Permission.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const fiber = yield* command
        .execute({
          name: "review",
          invocation: { sessionID: parentID, prompt: { text: "main" }, delivery: "steer" },
        })
        .pipe(Effect.exit, Effect.forkScoped)
      yield* Deferred.await(asked)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(calls.creates).toEqual([])
      expect(calls.notices).toEqual([])
      expect(yield* permission.list()).toEqual([])
      expect(yield* permission.forSession(parentID)).toEqual([])
    }),
  )
})
