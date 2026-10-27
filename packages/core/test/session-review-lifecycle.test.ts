import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { LanguageModel, type LLMRequest } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Job } from "@opencode/core/job"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import type { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionReview } from "@opencode/core/session/review"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionMessage } from "@opencode/core/session/message"
import { SubagentCompletion } from "@opencode/core/session/subagent-completion"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { SessionStore } from "@opencode/core/session/store"
import { Snapshot } from "@opencode/core/snapshot"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const report = {
  findings: [
    {
      title: "[P1] Guard the missing value",
      body: "`read` can return `undefined` here.",
      confidence_score: 0.9,
      priority: 1,
      code_location: {
        absolute_file_path: "/repo/src/index.ts",
        line_range: { start: 10, end: 12 },
      },
    },
  ],
  overall_correctness: "patch is incorrect" as const,
  overall_explanation: "The read path can crash.",
  overall_confidence_score: 0.8,
}

const llmLayer = TestLLM.testLayer({ fallback: TestLLM.text("unused", "unused") })
const it = testEffect(
  Layer.merge(
    llmLayer,
    AppNodeBuilder.build(
      LayerNode.group([
        Bus.node,
        Session.node,
        SessionStore.node,
        Job.node,
        SubagentJob.node,
        LocationServiceMap.node,
      ]),
      [
        Global.node.replace(tempGlobalLayer),
        offlineModels,
        Watcher.node.replace(Watcher.configured({ enabled: false })),
        Snapshot.node.replace(Snapshot.noopLayer),
        LayerNodePlatform.llmClient.replace(llmLayer),
        SessionRunnerModel.node.replace(
          Layer.succeed(SessionRunnerModel.Service, {
            resolve: () =>
              Effect.succeed(
                SessionRunnerModel.resolved(
                  LanguageModel.make({ id: "review", provider: "test", route: OpenAIChat.route }),
                  {
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    cost: [],
                    limit: { context: 200_000, output: 32_000 },
                  },
                ),
              ),
          }),
        ),
      ],
    ),
  ) as unknown as Layer.Layer<unknown, never>,
)

const userTexts = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
      : [],
  )

const runReview = Effect.fnUntraced(function* (response: TestLLM.Response, permissions?: Permission.Ruleset) {
  const sessions = yield* Session.Service
  const bus = yield* Bus.Service
  const jobs = yield* Job.Service
  const subagents = yield* SubagentJob.Service
  const locations = yield* LocationServiceMap.Service
  const llm = yield* TestLLM.Test
  const directory = yield* tmpdirScoped()

  const parent = yield* sessions.create({
    location: { directory: AbsolutePath.make(directory.path) },
    agent: Agent.ID.make("build"),
    model: Model.Ref.parse("test/parent"),
    title: "Parent session",
    ...(permissions === undefined ? {} : { permissions }),
  })
  yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(
    Effect.provide(locations.get(parent.location)),
  )
  yield* llm.push(
    TestLLM.text("parent response", "parent"),
    response,
    TestLLM.text("parent review response", "parent"),
  )

  yield* sessions.prompt({ sessionID: parent.id, text: "parent-only context" })
  yield* sessions.wait(parent.id)
  const before = (yield* llm.requests()).length

  const running = yield* bus
    .subscribe(SessionEvent.Synthetic)
    .pipe(
      Stream.filter((event) => event.data.sessionID === parent.id),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped({ startImmediately: true }),
    )
  const finished = yield* bus
    .subscribe(SessionEvent.Execution.Succeeded)
    .pipe(
      Stream.filter((event) => event.data.sessionID === parent.id),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped({ startImmediately: true }),
    )
  const archived = yield* bus
    .subscribe(SessionEvent.Archived)
    .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
  yield* Effect.yieldNow

  const child = yield* SessionReview.launch({
    sessionID: parent.id,
    prompt: { text: "HEAD~1" },
    delivery: "steer",
  }).pipe(
    Effect.provide(locations.get(parent.location)),
    Effect.provideService(SubagentJob.Service, subagents),
  )

  const notices = Array.from(yield* Fiber.join(running).pipe(Effect.timeout("5 seconds")))
  yield* Fiber.join(finished).pipe(Effect.timeout("5 seconds"))
  yield* Fiber.join(archived).pipe(Effect.timeout("5 seconds"))
  yield* sessions.wait(parent.id)
  yield* Effect.yieldNow
  return { parent, child, notices, before, llm, sessions, jobs }
})

describe("SessionReview lifecycle", () => {
  it.live("delivers a completed review to the parent and resumes the parent", () =>
    Effect.gen(function* () {
      const result = yield* runReview(TestLLM.text(JSON.stringify(report), "review"))
      const { parent, child, notices, before, llm, sessions, jobs } = result

      expect(child).toMatchObject({
        parentID: parent.id,
        taskName: expect.stringMatching(/^review-[a-z0-9]{8}$/),
        agent: Agent.ID.make("review"),
      })
      expect(child.fork).toBeUndefined()
      expect(notices.map((event) => event.data.metadata?.state)).toEqual(["running"])

      const synthetic = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
      expect(synthetic).toMatchObject([
        { metadata: { source: "subagent", childID: child.id, agent: "Review", state: "running" } },
        { metadata: { source: "subagent", childID: child.id, agent: "Review", state: "completed" } },
      ])
      expect(synthetic[1]?.description).toBe("Review: HEAD~1 — completed")
      expect(synthetic[1]?.text).toContain("## Review report")
      expect(synthetic[1]?.text).toContain("[P1] Guard the missing value")
      expect(synthetic[1]?.text).toContain("`/repo/src/index.ts:10-12`")
      expect(yield* sessions.inbox(parent.id)).toEqual([])
      expect((yield* sessions.get(child.id)).time.archived).toBeDefined()
      expect(yield* jobs.pendingBackground).toEqual([])
      expect(yield* jobs.get(child.id)).toBeUndefined()

      const requests = yield* llm.requests()
      expect(requests).toHaveLength(before + 2)
      const childRequest = requests[before]
      expect(childRequest?.system.some((part) => part.text.includes("review-only assignment"))).toBe(true)
      const childText = userTexts(childRequest!).join("\n")
      expect(childText).toContain("## Review target")
      expect(childText).toContain("HEAD~1")
      expect(childText).not.toContain("parent-only context")
      expect(childText).not.toContain("parent response")

      const parentRequest = requests[before + 1]
      const parentText = userTexts(parentRequest!).join("\n")
      expect(parentText).toContain("The user requested a one-shot review.")
      expect(parentText).toContain("## Review report")
      expect(parentText).toContain("[P1] Guard the missing value")
      const last = (yield* sessions.context(parent.id)).findLast(
        (message): message is SessionMessage.Assistant => message.type === "assistant",
      )
      expect(SubagentCompletion.text(last)).toBe("parent review response")
    }),
  )

  it.live("preserves a malformed reviewer response instead of reporting no findings", () =>
    Effect.gen(function* () {
      const raw = "I could not produce a structured report."
      const { parent, child, notices, sessions, jobs } = yield* runReview(TestLLM.text(raw, "review"))

      const synthetic = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
      const completion = synthetic.find((message) => message.metadata?.state === "completed")
      expect(notices.map((event) => event.data.metadata?.state)).toEqual(["running"])
      expect(completion?.text).toContain(raw)
      expect(completion?.text).toContain("did not match the review report format")
      expect(completion?.text.toLowerCase()).not.toContain("no findings")
      expect((yield* sessions.get(child.id)).time.archived).toBeDefined()
      expect(yield* jobs.pendingBackground).toEqual([])
      expect(synthetic).toHaveLength(2)
      expect(yield* sessions.inbox(parent.id)).toEqual([])
    }),
  )

  it.live("reuses a delivered review notice when delivery retries", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const jobs = yield* Job.Service
      const llm = yield* TestLLM.Test
      const directory = yield* tmpdirScoped()
      const parent = yield* sessions.create({
        location: { directory: AbsolutePath.make(directory.path) },
        agent: Agent.ID.make("build"),
        model: Model.Ref.parse("test/parent"),
        title: "Parent session",
      })
      const child = yield* sessions.create({
        parentID: parent.id,
        agent: Agent.ID.make("review"),
        title: "Review: retry",
      })
      const notificationID = SessionMessage.ID.create()
      const input = {
        status: "completed" as const,
        output: JSON.stringify(report),
        notificationID,
        recovery: {
          kind: "subagent" as const,
          parentSessionID: parent.id,
          childSessionID: child.id,
          agent: "Review",
          description: "Review: retry",
          mode: "review" as const,
        },
      }

      yield* llm.push(TestLLM.text("parent review response", "parent"))
      const finished = yield* bus
        .subscribe(SessionEvent.Execution.Succeeded)
        .pipe(
          Stream.filter((event) => event.data.sessionID === parent.id),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        )
      yield* Effect.yieldNow

      yield* SubagentCompletion.deliver(sessions, jobs, input)
      yield* Fiber.join(finished).pipe(Effect.timeout("5 seconds"))
      yield* sessions.wait(parent.id)

      yield* SubagentCompletion.deliver(sessions, jobs, input)

      const synthetic = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
      expect(synthetic).toHaveLength(1)
      expect(synthetic[0]).toMatchObject({
        metadata: { source: "subagent", childID: child.id, state: "completed" },
      })
      expect(synthetic[0]?.text).toContain("## Review report")
      expect((yield* sessions.get(child.id)).time.archived).toBeDefined()
      expect(yield* jobs.pendingBackground).toEqual([])
      expect(yield* llm.requests()).toHaveLength(1)
    }),
  )

  it.live("leaves a shutdown-cancelled review marker recoverable", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* Job.Service
      const directory = yield* tmpdirScoped()
      const parent = yield* sessions.create({
        location: { directory: AbsolutePath.make(directory.path) },
        agent: Agent.ID.make("build"),
        model: Model.Ref.parse("test/parent"),
        title: "Parent session",
      })
      const child = yield* sessions.create({
        parentID: parent.id,
        agent: Agent.ID.make("review"),
        title: "Review: shutdown",
      })
      const recovery = {
        kind: "subagent" as const,
        parentSessionID: parent.id,
        childSessionID: child.id,
        agent: "Review",
        description: "Review: shutdown",
        mode: "review" as const,
      }
      const handle = yield* jobs.startObserved({
        id: child.id,
        type: "subagent",
        title: recovery.description,
        recovery,
        run: Effect.never,
      })
      const background = yield* handle.background
      const notificationID = background?.notificationID
      if (!notificationID) throw new Error("expected a persisted review notification")

      yield* SubagentCompletion.deliver(sessions, jobs, { status: "cancelled", notificationID, recovery })

      expect((yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")).toEqual([])
      expect(
        (yield* jobs.pendingBackground).find((item) => item.notificationID === notificationID),
      ).toMatchObject({ status: "running" })

      yield* handle.cancel
      yield* jobs.completeBackground(notificationID)
    }),
  )

  it.live("delivers and archives a deliberately cancelled review", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const jobs = yield* Job.Service
      const subagents = yield* SubagentJob.Service
      const locations = yield* LocationServiceMap.Service
      const llm = yield* TestLLM.Test
      const directory = yield* tmpdirScoped()

      const parent = yield* sessions.create({
        location: { directory: AbsolutePath.make(directory.path) },
        agent: Agent.ID.make("build"),
        model: Model.Ref.parse("test/parent"),
        title: "Parent session",
      })
      yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(
        Effect.provide(locations.get(parent.location)),
      )
      yield* llm.push(TestLLM.text("parent response", "parent"))
      yield* sessions.prompt({ sessionID: parent.id, text: "parent-only context" })
      yield* sessions.wait(parent.id)

      const notices = yield* bus
        .subscribe(SessionEvent.Synthetic)
        .pipe(
          Stream.filter((event) => event.data.sessionID === parent.id),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        )
      const finished = yield* bus
        .subscribe(SessionEvent.Execution.Succeeded)
        .pipe(
          Stream.filter((event) => event.data.sessionID === parent.id),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        )
      const archived = yield* bus
        .subscribe(SessionEvent.Archived)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
      yield* Effect.yieldNow

      const gate = yield* llm.gate()
      const child = yield* SessionReview.launch({
        sessionID: parent.id,
        prompt: { text: "HEAD~1" },
        delivery: "steer",
      }).pipe(
        Effect.provide(locations.get(parent.location)),
        Effect.provideService(SubagentJob.Service, subagents),
      )

      yield* gate.started.pipe(Effect.timeout("5 seconds"))
      yield* sessions.interrupt(child.id)
      yield* gate.release

      const events = Array.from(yield* Fiber.join(notices).pipe(Effect.timeout("5 seconds")))
      yield* Fiber.join(finished).pipe(Effect.timeout("5 seconds"))
      yield* Fiber.join(archived).pipe(Effect.timeout("5 seconds"))
      yield* sessions.wait(parent.id)
      yield* Effect.yieldNow

      expect(events.map((event) => event.data.metadata?.state)).toEqual(["running"])
      const synthetic = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
      const cancelled = synthetic.find((message) => message.metadata?.state === "cancelled")
      expect(cancelled?.description).toBe("Review: HEAD~1 — cancelled")
      expect(cancelled?.text).toContain("## Review cancelled")
      expect(cancelled?.text.toLowerCase()).not.toContain("no findings")
      expect((yield* sessions.get(child.id)).time.archived).toBeDefined()
      expect(yield* jobs.pendingBackground).toEqual([])
      expect(yield* jobs.get(child.id)).toBeUndefined()
      expect(yield* sessions.inbox(parent.id)).toEqual([])
      const requests = yield* llm.requests()
      expect(requests).toHaveLength(3)
      expect(userTexts(requests[2]!).join("\n")).toContain("## Review cancelled")
    }),
  )

  it.live("does not advertise mutation or CodeMode tools under a broad parent allow", () =>
    Effect.gen(function* () {
      const { before, llm } = yield* runReview(TestLLM.text(JSON.stringify(report), "review"), [
        { action: "*", resource: "*", effect: "allow" },
      ])
      const childRequest = (yield* llm.requests())[before]
      if (!childRequest) return yield* Effect.die("missing review request")

      const names = childRequest.tools.map((tool) => tool.name)
      for (const name of [
        "execute",
        "edit",
        "patch",
        "write",
        "webfetch",
        "websearch",
        "subagent",
        "spawn_agent",
      ])
        expect(names).not.toContain(name)

      const system = childRequest.system.map((part) => part.text).join("\n")
      expect(system).not.toContain("tools.opencode.")
      for (const name of ["session_rename", "session_move", "worktree_create", "worktree_remove"])
        expect(system).not.toContain(name)
    }),
  )
})
