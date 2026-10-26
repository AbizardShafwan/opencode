import { beforeEach, describe, expect } from "bun:test"
import { Cause, DateTime, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Command } from "@opencode/core/command"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { CommandPlugin } from "@opencode/core/plugin/command"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { ReviewAuthority } from "@opencode/core/session/review-authority"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import type { PromptInput } from "@opencode/schema/prompt-input"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { Skill } from "@opencode/schema/skill"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Money } from "@opencode/schema/money"
import { emptyMcpLayer } from "../fixture/mcp"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "./host"
import PROMPT_INITIALIZE from "../../src/plugin/command/initialize.txt"

const directory = AbsolutePath.make("/repo/packages/app")
const project = AbsolutePath.make("/repo")
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory }, { projectDirectory: project })),
)

const parentID = Session.ID.make("ses_parent")
const parentModel = Model.Ref.parse("test/parent")
const parentAuthority: Permission.Ruleset[] = [[{ action: "shell", resource: "*", effect: "deny" }]]
const reviewRole = {
  ...Agent.Info.default(Agent.ID.make("review")),
  name: Agent.Name.make("Review"),
  mode: "subagent" as const,
  hidden: true,
  variant: Model.VariantID.make("fast"),
}
let activeReviewRole: Agent.Info | undefined = reviewRole
let permissionAssert: Effect.Effect<void> = Effect.void

const promptFiles: PromptInput.Prompt["files"] = [{ uri: "file:///tmp/context.md", name: "context.md" }]
const promptSkills: PromptInput.Prompt["skills"] = [{ id: Skill.ID.make("review-context") }]

const calls = {
  creates: [] as Parameters<Session.Interface["create"]>[0][],
  prompts: [] as Parameters<Session.Interface["prompt"]>[0][],
  asserts: [] as Parameters<Permission.Interface["assert"]>[0][],
  authorities: [] as { sessionID: Session.ID; agent?: Agent.ID }[],
  starts: [] as Parameters<SubagentJob.Interface["start"]>[0][],
  backgrounds: [] as Parameters<SubagentJob.Interface["background"]>[0][],
}

beforeEach(() => {
  activeReviewRole = reviewRole
  activeParent = parent
  activeDefaultModel = defaultModel
  permissionAssert = Effect.void
  activeSessions = new Set()
  calls.creates.length = 0
  calls.prompts.length = 0
  calls.asserts.length = 0
  calls.authorities.length = 0
  calls.starts.length = 0
  calls.backgrounds.length = 0
})

const sessionInfo = (input: {
  id: Session.ID
  parentID?: Session.ID
  taskName?: string
  title?: string
  agent?: Agent.ID
  model?: Model.Ref
  metadata?: Session.Info["metadata"]
  authority?: Session.Info["authority"]
}): Session.Info => ({
  id: input.id,
  parentID: input.parentID,
  taskName: input.taskName,
  title: input.title,
  agent: input.agent,
  model: input.model,
  projectID: Project.ID.make("prj_test"),
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: { directory: AbsolutePath.make("/repo") },
  metadata: input.metadata,
  authority: input.authority,
})

const parent = sessionInfo({
  id: parentID,
  agent: Agent.ID.make("build"),
  model: parentModel,
  metadata: { team: "core" },
})
let activeParent = parent

const modelInfo = (ref: string, variants: string[] = []): Model.Info => {
  const parsed = Model.Ref.parse(ref)
  return {
    ...Model.Info.default(parsed.providerID, parsed.id),
    variants: variants.map((variant) => ({ id: Model.VariantID.make(variant) })),
  }
}
const catalog = [
  modelInfo("test/parent", ["fast", "deep"]),
  modelInfo("test/reviewer", ["deep", "fast"]),
  modelInfo("test/default", ["fast", "deep"]),
]
const defaultModel = modelInfo("test/default", ["fast", "deep"])
let activeDefaultModel: Model.Info | undefined = defaultModel
const modelMock = Layer.mock(Model.Service, {
  available: () => Effect.succeed(catalog),
  default: () => Effect.succeed(activeDefaultModel),
})

const childID = Session.ID.make("ses_review")
let activeSessions = new Set<Session.ID>()

const sessionMock = Layer.mock(Session.Service, {
  get: (sessionID) => Effect.succeed(sessionID === parentID ? activeParent : sessionInfo({ id: sessionID })),
  active: Effect.suspend(() => Effect.succeed(activeSessions)),
  create: (input) =>
    Effect.sync(() => {
      calls.creates.push(input)
      return sessionInfo({
        id: childID,
        parentID: input.parentID,
        taskName: input.taskName,
        title: input.title,
        agent: input.agent,
        model: input.model,
        metadata: input.metadata,
        authority: input.authority,
      })
    }),
  prompt: (input) =>
    Effect.sync(() => {
      calls.prompts.push(input)
      return SessionInbox.User.make({
        id: SessionMessage.ID.make("msg_review"),
        sessionID: input.sessionID,
        time: { created: DateTime.makeUnsafe(0) },
        type: "user",
        payload: { text: input.text },
        delivery: input.delivery ?? "steer",
      })
    }),
  interrupt: () => Effect.succeed(true),
  archive: () => Effect.void,
  revert: {
    stage: () => Effect.die("unused"),
    clear: () => Effect.die("unused"),
    commit: () => Effect.die("unused"),
  },
})

const agentMock = Layer.mock(Agent.Service, {
  resolve: (id) => Effect.succeed(id === "review" ? activeReviewRole : undefined),
})

const permissionMock = Layer.mock(Permission.Service, {
  assert: (input) =>
    Effect.sync(() => {
      calls.asserts.push(input)
    }).pipe(Effect.andThen(permissionAssert)),
  authority: (sessionID, agent) =>
    Effect.sync(() => {
      calls.authorities.push({ sessionID, agent })
      return parentAuthority
    }),
})

const jobHandle: SubagentJob.Handle = {
  owner: {},
  info: { id: childID, type: "subagent", status: "running", started_at: 0 },
  interrupt: Effect.succeed(true),
  cancel: Effect.succeed(undefined),
  wait: () => Effect.succeed({ timedOut: false }),
  block: () => Effect.die("unused"),
  background: Effect.succeed(undefined),
}

const subagentMock = Layer.mock(SubagentJob.Service, {
  start: (recovery) =>
    Effect.sync(() => {
      calls.starts.push(recovery)
      return jobHandle
    }),
  background: (recovery) =>
    Effect.sync(() => {
      calls.backgrounds.push(recovery)
    }),
})

const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Command.node, Mcp.node, Bus.node]), [
      Mcp.node.replace(emptyMcpLayer),
      Location.node.replace(locationLayer),
    ]),
    Layer.mergeAll(sessionMock, agentMock, modelMock, permissionMock, subagentMock),
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
  ).pipe(Effect.provide(locationLayer))
  return command
})

describe("CommandPlugin.Plugin", () => {
  it.effect("registers built-in init and review commands", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const prompts: {
        text: string
        files?: readonly { readonly uri: string }[]
        delivery?: "steer" | "queue"
      }[] = []
      yield* CommandPlugin.Plugin.effect(
        host({
          command: {
            list: () => Effect.die("unused command.list"),
            transform: command.transform,
            reload: command.reload,
          },
          session: {
            prompt: (input) =>
              Effect.sync(() => {
                prompts.push({ text: input.text, files: input.files, delivery: input.delivery })
                return SessionInbox.User.make({
                  id: SessionMessage.ID.make("msg_test"),
                  sessionID: input.sessionID,
                  time: { created: DateTime.makeUnsafe(0) },
                  type: "user",
                  payload: { text: input.text },
                  delivery: input.delivery ?? "steer",
                })
              }),
          },
        }),
      ).pipe(Effect.provide(locationLayer))

      expect(yield* command.get("init")).toMatchObject({
        name: "init",
        description: "guided AGENTS.md setup",
      })
      expect(yield* command.get("review")).toMatchObject({
        name: "review",
        description: "review changes [commit|branch|pr], defaults to uncommitted",
      })
      yield* command.execute({
        name: "init",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "extra context", files: [{ uri: "file:///tmp/context.md" }] },
          delivery: "queue",
        },
      })
      yield* command.execute({
        name: "init",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "" },
          delivery: "steer",
        },
      })
      expect(prompts[0]?.text).toContain("If it does, do not overwrite or modify it")
      expect(prompts).toEqual([
        {
          text: PROMPT_INITIALIZE.replace("${path}", project).replaceAll("$ARGUMENTS", "extra context"),
          files: [{ uri: "file:///tmp/context.md" }],
          delivery: "queue",
        },
        {
          text: PROMPT_INITIALIZE.replace("${path}", project).replaceAll("$ARGUMENTS", ""),
          files: undefined,
          delivery: "steer",
        },
      ])
    }),
  )

  it.effect("launches review in a fresh child instead of prompting the parent", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const bus = yield* Bus.Service
      const prompts: string[] = []
      yield* CommandPlugin.Plugin.effect(
        host({
          command: {
            list: () => Effect.die("unused command.list"),
            transform: command.transform,
            reload: command.reload,
          },
          session: {
            prompt: (input) =>
              Effect.sync(() => {
                prompts.push(input.text)
                return SessionInbox.User.make({
                  id: SessionMessage.ID.make("msg_parent"),
                  sessionID: input.sessionID,
                  time: { created: DateTime.makeUnsafe(0) },
                  type: "user",
                  payload: { text: input.text },
                  delivery: input.delivery ?? "steer",
                })
              }),
          },
        }),
      ).pipe(Effect.provide(locationLayer))

      const notices = yield* bus
        .subscribe(SessionEvent.Synthetic)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* command.execute({
        name: "review",
        invocation: {
          sessionID: parentID,
          prompt: { text: "  branch $& $$ $` $'  ", files: promptFiles, skills: promptSkills },
          delivery: "steer",
        },
      })

      expect(prompts).toEqual([])
      expect(calls.asserts).toMatchObject([{ action: "subagent", resources: ["review"], sessionID: parentID }])
      expect(calls.authorities).toEqual([{ sessionID: parentID, agent: parent.agent }])
      expect(calls.creates).toHaveLength(1)
      expect(calls.prompts).toHaveLength(1)
      expect(calls.starts).toHaveLength(1)
      expect(calls.backgrounds).toHaveLength(1)

      const created = calls.creates[0]
      expect(created).toMatchObject({
        parentID: parentID,
        title: "Review: branch $& $$ $` $'",
        agent: reviewRole.id,
        model: { ...parentModel, variant: Model.VariantID.make("fast") },
        metadata: { team: "core", oneShotReview: true },
      })
      expect(created?.taskName).toMatch(/^review-[a-z0-9]{8}$/)
      expect(created?.authority).toEqual([...parentAuthority, ReviewAuthority.rules])
      const hardAuthority = created?.authority?.at(-1) ?? []
      expect(Permission.evaluate("edit", "src/index.ts", hardAuthority).effect).toBe("deny")
      expect(Permission.evaluate("subagent", "review", hardAuthority).effect).toBe("deny")
      expect(Permission.evaluate("todowrite", "anything", hardAuthority).effect).toBe("deny")
      expect(Permission.evaluate("read", "src/index.ts", hardAuthority).effect).toBe("allow")
      expect(Permission.evaluate("shell", "git diff", hardAuthority).effect).toBe("allow")
      expect(Permission.evaluate("external_directory", "/outside/*", hardAuthority).effect).toBe("allow")

      const childPrompt = calls.prompts[0]
      expect(childPrompt?.sessionID).toBe(childID)
      expect(childPrompt?.text).toContain("## Review target")
      expect(childPrompt?.text).toContain(`Repository: \`${project}\``)
      expect(childPrompt?.text).toContain("branch $& $$ $` $'")
      expect(childPrompt?.text).not.toContain("Review guidelines")
      expect(childPrompt?.text).not.toContain("## Output schema")
      expect(childPrompt?.files).toEqual(promptFiles)
      expect(childPrompt?.skills).toEqual(promptSkills)
      expect(childPrompt?.resume).toBe(false)

      expect(calls.starts[0]).toMatchObject({
        kind: "subagent",
        parentSessionID: parentID,
        childSessionID: childID,
        agent: "Review",
        description: "Review: branch $& $$ $` $'",
        mode: "review",
      })
      expect(calls.backgrounds[0]).toEqual(calls.starts[0])

      expect(yield* Fiber.join(notices)).toMatchObject([
        {
          data: {
            sessionID: parentID,
            description: "Review: branch $& $$ $` $' — open the reviewer to inspect or stop it.",
            metadata: { source: "subagent", childID, agent: "Review", state: "running" },
          },
        },
      ])
    }),
  )

  it.effect("prefers the review model's embedded variant over the standalone variant", () =>
    Effect.gen(function* () {
      const command = yield* registerReview
      const reviewModel = Model.Ref.parse("test/reviewer#deep")
      activeReviewRole = { ...reviewRole, model: reviewModel, variant: Model.VariantID.make("fast") }

      yield* command.execute({
        name: "review",
        invocation: { sessionID: parentID, prompt: { text: "main" }, delivery: "steer" },
      })

      expect(calls.creates[0]?.model).toEqual(reviewModel)
    }),
  )

  it.effect("applies a standalone review variant to a configured review model", () =>
    Effect.gen(function* () {
      const command = yield* registerReview
      activeReviewRole = {
        ...reviewRole,
        model: Model.Ref.parse("test/reviewer"),
        variant: Model.VariantID.make("fast"),
      }

      yield* command.execute({
        name: "review",
        invocation: { sessionID: parentID, prompt: { text: "main" }, delivery: "steer" },
      })

      expect(calls.creates[0]?.model).toEqual(Model.Ref.parse("test/reviewer#fast"))
    }),
  )

  it.effect("preserves the caller model variant when the review role has no override", () =>
    Effect.gen(function* () {
      const command = yield* registerReview
      activeParent = { ...parent, model: Model.Ref.parse("test/parent#deep") }
      activeReviewRole = { ...reviewRole, variant: undefined }

      yield* command.execute({
        name: "review",
        invocation: { sessionID: parentID, prompt: { text: "main" }, delivery: "steer" },
      })

      expect(calls.creates[0]?.model).toEqual(Model.Ref.parse("test/parent#deep"))
    }),
  )

  it.effect("uses the default model when the caller has no model", () =>
    Effect.gen(function* () {
      const command = yield* registerReview
      activeParent = { ...parent, model: undefined }
      activeReviewRole = { ...reviewRole, variant: undefined }

      yield* command.execute({
        name: "review",
        invocation: { sessionID: parentID, prompt: { text: "main" }, delivery: "steer" },
      })

      expect(calls.creates[0]?.model).toEqual(Model.Ref.parse("test/default"))
    }),
  )

  it.effect("applies a standalone review variant to the default model", () =>
    Effect.gen(function* () {
      const command = yield* registerReview
      activeParent = { ...parent, model: undefined }
      activeReviewRole = { ...reviewRole, variant: Model.VariantID.make("fast") }

      yield* command.execute({
        name: "review",
        invocation: { sessionID: parentID, prompt: { text: "main" }, delivery: "steer" },
      })

      expect(calls.creates[0]?.model).toEqual(Model.Ref.parse("test/default#fast"))
    }),
  )

  it.effect("fails when no default model is available", () =>
    Effect.gen(function* () {
      const command = yield* registerReview
      activeParent = { ...parent, model: undefined }
      activeDefaultModel = undefined
      const error = yield* command
        .execute({
          name: "review",
          invocation: { sessionID: parentID, prompt: { text: "main" }, delivery: "steer" },
        })
        .pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "Command.ExecutionError",
        message: "No model is available for the review.",
      })
    }),
  )

  it.effect("fails when the configured review model is unavailable", () =>
    Effect.gen(function* () {
      const command = yield* registerReview
      activeReviewRole = { ...reviewRole, model: Model.Ref.parse("test/missing"), variant: undefined }
      const error = yield* command
        .execute({
          name: "review",
          invocation: { sessionID: parentID, prompt: { text: "main" }, delivery: "steer" },
        })
        .pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "Command.ExecutionError",
        message: 'Model "test/missing" is not available for the review.',
      })
    }),
  )

  it.effect("fails when the configured review variant is unavailable", () =>
    Effect.gen(function* () {
      const command = yield* registerReview
      activeReviewRole = {
        ...reviewRole,
        model: Model.Ref.parse("test/reviewer"),
        variant: Model.VariantID.make("missing"),
      }
      const error = yield* command
        .execute({
          name: "review",
          invocation: { sessionID: parentID, prompt: { text: "main" }, delivery: "steer" },
        })
        .pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "Command.ExecutionError",
        message: 'Variant "missing" is not available for "test/reviewer". Available: deep, fast.',
      })
    }),
  )

  it.effect("fails clearly when the review role is unavailable", () =>
    Effect.gen(function* () {
      const command = yield* registerReview
      activeReviewRole = undefined
      const error = yield* command
        .execute({
          name: "review",
          invocation: { sessionID: parentID, prompt: { text: "main" }, delivery: "steer" },
        })
        .pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "Command.ExecutionError",
        message: "Review agent is unavailable: review",
      })
    }),
  )

  it.effect("fails clearly when the review role is not a subagent", () =>
    Effect.gen(function* () {
      const command = yield* registerReview
      activeReviewRole = { ...reviewRole, mode: "primary" }
      const error = yield* command
        .execute({
          name: "review",
          invocation: { sessionID: parentID, prompt: { text: "main" }, delivery: "steer" },
        })
        .pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "Command.ExecutionError",
        message: "Review agent must be configured as a subagent: review",
      })
    }),
  )

  it.effect("rejects queued review delivery", () =>
    Effect.gen(function* () {
      const command = yield* registerReview
      const error = yield* command
        .execute({
          name: "review",
          invocation: { sessionID: parentID, prompt: { text: "main" }, delivery: "queue" },
        })
        .pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "Command.ExecutionError",
        message: "Queued delivery is not supported for /review; it starts a reviewer immediately.",
      })
    }),
  )

  it.effect("rejects review while the parent is executing", () =>
    Effect.gen(function* () {
      const command = yield* registerReview
      activeSessions = new Set([parentID])
      const error = yield* command
        .execute({
          name: "review",
          invocation: { sessionID: parentID, prompt: { text: "main" }, delivery: "steer" },
        })
        .pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "Command.ExecutionError",
        message: "Cannot start a review while the current session is executing. Wait for it to finish or stop it first.",
      })
    }),
  )

  it.effect("does not convert an unrelated permission defect into a command error", () =>
    Effect.gen(function* () {
      const command = yield* registerReview
      permissionAssert = Effect.die(new Error("unrelated permission defect"))
      const exit = yield* command
        .execute({
          name: "review",
          invocation: { sessionID: parentID, prompt: { text: "main" }, delivery: "steer" },
        })
        .pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return yield* Effect.die("expected a permission defect")
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.hasFails(exit.cause)).toBe(false)
      expect(Cause.hasInterrupts(exit.cause)).toBe(false)
      expect(Cause.squash(exit.cause)).toMatchObject({ message: "unrelated permission defect" })
      expect(calls.creates).toEqual([])
      expect(calls.starts).toEqual([])
    }),
  )

})
