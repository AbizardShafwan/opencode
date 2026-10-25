import { expect } from "bun:test"
import { Deferred, Effect, Layer, Stream } from "effect"
import { LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { Tool } from "@opencode/core/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

const llmLayer = TestLLM.testLayer({ fallback: TestLLM.text("original answer", "delegation") })
const model = Model.Ref.make({ id: Model.ID.make("delegation"), providerID: Provider.ID.make("test") })
const it = testEffect(
  Layer.merge(
    llmLayer,
    AppNodeBuilder.build(
      LayerNode.group([
        Session.node,
        Job.node,
        LocationServiceMap.node,
        SubagentJob.node,
        SessionRestart.node,
        KV.node,
        Bus.node,
      ]),
      [
        Global.node.replace(tempGlobalLayer),
        offlineModels,
        Watcher.node.replace(Watcher.configured({ enabled: false })),
        LayerNodePlatform.llmClient.replace(llmLayer),
        SessionRunnerModel.node.replace(
          Layer.succeed(SessionRunnerModel.Service, {
            resolve: () =>
              Effect.succeed(
                SessionRunnerModel.resolved(
                  LanguageModel.make({ id: "delegation", provider: "test", route: OpenAIChat.route }),
                  {
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    cost: [],
                    limit: { context: 200000, output: 32000 },
                  },
                ),
              ),
          }),
        ),
      ],
    ),
  ),
)

const fixture = Effect.gen(function* () {
  const dir = yield* tmpdirScoped()
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({
    location: { directory: AbsolutePath.make(dir.path) },
    agent: Agent.ID.make("build"),
    model,
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  })
  const locations = yield* LocationServiceMap.Service
  yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(locations.get(parent.location)))
  const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
  const child = yield* sessions.create({
    parentID: parent.id,
    agent: Agent.ID.make("general"),
    model,
    taskName: "worker",
  })
  const recovery = {
    kind: "subagent" as const,
    parentSessionID: parent.id,
    childSessionID: child.id,
    agent: "general",
    description: "worker",
  }
  return { sessions, parent, child, registry, recovery }
})

it.live("reports the observed running execution's failure instead of a prior successful answer", () =>
  Effect.gen(function* () {
    const { sessions, parent, child, recovery } = yield* fixture
    const llm = yield* TestLLM.Test
    const jobs = yield* Job.Service
    const subagents = yield* SubagentJob.Service
    const bus = yield* Bus.Service
    yield* sessions.prompt({ sessionID: child.id, text: "First task", resume: false })
    yield* sessions.resume(child.id)
    yield* llm.always(Stream.die(new Error("delegated provider failed")))
    const gate = yield* llm.gate()
    const notification = yield* Deferred.make<string>()
    yield* bus.project(SessionEvent.InboxEnqueued, (event) => {
      const item = event.data.item
      return event.data.sessionID === parent.id &&
        item.type === "synthetic" &&
        item.payload.metadata?.source === "subagent"
        ? Deferred.succeed(notification, item.payload.text).pipe(Effect.asVoid)
        : Effect.void
    })
    yield* sessions.prompt({ sessionID: child.id, text: "Second task" })
    yield* gate.started
    expect(yield* sessions.inbox(child.id)).toHaveLength(0)
    const job = yield* subagents.start(recovery)
    yield* subagents.background(recovery, job)
    yield* gate.release
    expect((yield* job.wait()).info).toMatchObject({ status: "error" })
    const text = yield* Deferred.await(notification)
    expect(text).toContain('state="error"')
    expect(text).toContain("delegated provider failed")
    expect(text).not.toContain("original answer")
    expect((yield* jobs.get(child.id))?.output).toBeUndefined()
  }),
)

it.live("persists displaced user cancellation without cancelling a later admission", () =>
  Effect.gen(function* () {
    const { sessions, child, recovery } = yield* fixture
    const llm = yield* TestLLM.Test
    const subagents = yield* SubagentJob.Service
    const jobs = yield* Job.Service
    const gate = yield* llm.gate()
    yield* sessions.prompt({ sessionID: child.id, text: "Original task", resume: false })
    const original = yield* subagents.start(recovery)
    yield* gate.started
    const marker = yield* original.background
    expect(yield* original.interrupt).toBe(true)
    yield* sessions.prompt({ sessionID: child.id, text: "Later task", delivery: "queue", resume: false })
    const followup = yield* subagents.start(recovery)
    expect((yield* original.wait()).info?.status).toBe("cancelled")
    expect((yield* jobs.pendingBackground).find((item) => item.notificationID === marker?.notificationID)?.status).toBe(
      "cancelled",
    )
    yield* gate.started
    expect(yield* original.interrupt).toBe(false)
    expect((yield* jobs.get(child.id))?.status).toBe("running")
    yield* gate.release
    expect((yield* followup.wait()).info).toMatchObject({ status: "completed", output: "original answer" })
    if (!marker?.notificationID) throw new Error("Missing background marker")
    yield* jobs.completeBackground(marker.notificationID)
  }),
)

it.live("restores one child for multiple running markers without replacing stored terminal outcomes", () =>
  Effect.gen(function* () {
    const { sessions, parent, child, recovery } = yield* fixture
    const llm = yield* TestLLM.Test
    const kv = yield* KV.Service
    const bus = yield* Bus.Service
    const restart = yield* SessionRestart.Service
    const delivered = yield* Deferred.make<void>()
    const markers = [
      { notificationID: SessionMessage.ID.create(), status: "completed", output: "stored old success" },
      { notificationID: SessionMessage.ID.create(), status: "error", error: "stored old failure" },
      { notificationID: SessionMessage.ID.create(), status: "running" },
      { notificationID: SessionMessage.ID.create(), status: "running" },
    ] as const
    yield* Effect.forEach(markers, (marker) =>
      kv.set(`job.background/${marker.notificationID}`, { id: child.id, recovery, ...marker }),
    )
    const notices = new Map<SessionMessage.ID, string>()
    const starts: string[] = []
    yield* bus.project(SessionEvent.Execution.Started, (event) =>
      Effect.sync(() => {
        starts.push(event.data.sessionID)
      }),
    )
    yield* bus.project(SessionEvent.InboxEnqueued, (event) => {
      if (event.data.sessionID !== parent.id || event.data.item.type !== "synthetic") return Effect.void
      notices.set(event.data.inboxID, event.data.item.payload.text)
      return notices.size === markers.length ? Deferred.succeed(delivered, undefined).pipe(Effect.asVoid) : Effect.void
    })
    yield* llm.always(TestLLM.text("restored execution result", "recovery"))
    const gate = yield* llm.gate()
    yield* restart.resumeSuspendedSessions
    // The parent and child remain gated while another sweep checks the live owner.
    yield* gate.started
    yield* gate.started
    yield* restart.resumeSuspendedSessions
    yield* gate.release
    yield* Deferred.await(delivered)
    yield* sessions.wait(child.id)
    expect(starts.filter((id) => id === child.id)).toHaveLength(1)
    expect(notices.get(markers[0].notificationID)).toContain("stored old success")
    expect(notices.get(markers[1].notificationID)).toContain("stored old failure")
    expect(notices.get(markers[2].notificationID)).toContain("restored execution result")
    expect(notices.get(markers[3].notificationID)).toContain("restored execution result")
  }),
)

it.live("executes a followup admitted while an idle child's old Job is still settling", () =>
  Effect.gen(function* () {
    const { sessions, parent, child, registry, recovery } = yield* fixture
    const jobs = yield* Job.Service
    const llm = yield* TestLLM.Test
    const executionDone = yield* Deferred.make<void>()
    const settleOldJob = yield* Deferred.make<void>()
    yield* sessions.prompt({ sessionID: child.id, text: "Original task", resume: false })
    const old = yield* jobs.startObserved({
      id: child.id,
      type: "subagent",
      recovery,
      run: sessions
        .resume(child.id)
        .pipe(
          Effect.andThen(Deferred.succeed(executionDone, undefined)),
          Effect.andThen(Deferred.await(settleOldJob)),
          Effect.as("original job output"),
        ),
    })
    yield* Deferred.await(executionDone)
    expect((yield* sessions.active).has(child.id)).toBe(false)
    expect((yield* jobs.get(child.id))?.status).toBe("running")
    yield* llm.always(TestLLM.text("new task answer", "followup"))
    const result = yield* executeTool(registry, {
      sessionID: parent.id,
      ...toolIdentity,
      call: {
        type: "tool-call",
        id: "delegation-followup",
        name: "followup_task",
        input: { target: child.id, prompt: "Do the new task" },
      },
    })
    expect(result.status).toBe("completed")
    const current = yield* jobs.observe(child.id)
    if (!current) throw new Error("Missing followup job")
    expect(current.owner).not.toBe(old.owner)
    expect((yield* current.wait()).info).toMatchObject({ status: "completed", output: "new task answer" })
    yield* Deferred.succeed(settleOldJob, undefined)
    expect((yield* old.wait()).info?.output).toBe("original job output")
    expect(yield* sessions.inbox(child.id)).toHaveLength(0)
    expect(yield* sessions.messages({ sessionID: child.id, type: "assistant" })).toHaveLength(2)
  }),
)
