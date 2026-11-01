import { describe, expect } from "bun:test"
import { LanguageModel, LLMClient, LLMEvent } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigCompactionPlugin } from "@opencode/core/config/plugin/compaction"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Session } from "@opencode/core/session"
import { Agent } from "@opencode/core/agent"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { ConfigCompaction } from "@opencode/schema/config/compaction"
import { Document, Event, Info } from "@opencode/schema/config"
import { Money } from "@opencode/schema/money"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const model = LanguageModel.make({
  id: "test-model",
  provider: "test-provider",
  route: OpenAIChat.route,
})
const limit = { context: 100_000, output: 1_000 }
const resolved = SessionRunnerModel.resolved(model, {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit,
})
const config = Config.testLayer()
const it = testEffect(
  Layer.merge(
    config,
    AppNodeBuilder.build(LayerNode.group([SessionCompaction.node, SessionModelRequest.node, Config.node, Bus.node]), [
      llmClient.replace(
        Layer.mock(LLMClient.Service)({
          stream: () => Stream.make(LLMEvent.textDelta({ id: "summary", text: "## Objective\n- summary" })),
        }),
      ),
      Config.node.replace(config),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/tmp") })),
    ]),
  ),
)
describe("ConfigCompactionPlugin.Plugin", () => {
  it.live("merges settings and reloads changed config", () =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service
      // An automatic compaction that is not due is skipped.
      const due = (input: typeof nearInput) =>
        compaction
          .compact({ reason: "auto", context: input.context })
          .pipe(Effect.map((outcome) => outcome.status !== "skipped"))
      const config = yield* Config.Test
      const bus = yield* Bus.Service
      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ auto: false, buffer: 20_000 }) }),
        }),
        new Document({
          type: "document",
          info: new Info({
            compaction: new ConfigCompaction.Info({
              buffer: 10_000,
              keep: new ConfigCompaction.Keep({ tokens: 0 }),
            }),
          }),
        }),
      ])
      yield* ConfigCompactionPlugin.Plugin.effect(host({ event: { subscribe: () => bus.subscribe(Event.Updated) } }))

      expect(yield* due(nearInput)).toBe(false)
      const ended = yield* bus
        .subscribe(SessionEvent.Compaction.Ended)
        .pipe(Stream.runHead, Effect.forkScoped({ startImmediately: true }))
      const messages = [
        SessionMessage.User.make({
          id: SessionMessage.ID.create(),
          type: "user",
          text: "Older context",
          time: { created: DateTime.makeUnsafe(0) },
        }),
        SessionMessage.User.make({
          id: SessionMessage.ID.create(),
          type: "user",
          text: "Recent context",
          time: { created: DateTime.makeUnsafe(1) },
        }),
      ]
      expect(
        yield* compaction.compact({
          reason: "manual",
          context: { ...nearInput.context, messages },
          inputID: SessionMessage.ID.make("msg_compaction_manual"),
        }),
      ).toEqual({ status: "completed" })
      expect(Option.getOrThrow(yield* Fiber.join(ended)).metadata?.keepID).toBe(messages[1].id)

      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ auto: true, buffer: 20_000 }) }),
        }),
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ buffer: 10_000 }) }),
        }),
      ])
      yield* bus.publish(Event.Updated, {})
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (yield* due(nearInput)) return
          yield* Effect.sleep("10 millis")
        }
        yield* Effect.die(new Error("Timed out waiting for compaction config reload"))
      })
      expect(yield* due(bufferedInput)).toBe(false)

      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ auto: true, buffer: 20_000 }) }),
        }),
      ])
      yield* bus.publish(Event.Updated, {})
      for (let attempt = 0; attempt < 200; attempt++) {
        if (yield* due(bufferedInput)) return
        yield* Effect.sleep("10 millis")
      }
      yield* Effect.die(new Error("Timed out waiting for compaction config reload"))
    }),
  )

  it.live("dynamically reloads compaction.soft_limits without service restart", () =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service
      const due = (inp: typeof nearInput) =>
        compaction
          .compact({ reason: "auto", context: inp.context })
          .pipe(Effect.map((outcome) => outcome.status !== "skipped"))
      const config = yield* Config.Test
      const bus = yield* Bus.Service

      const lowerTokens = input(60_000)
      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({
            compaction: new ConfigCompaction.Info({
              auto: true,
            }),
          }),
        }),
      ])
      yield* ConfigCompactionPlugin.Plugin.effect(host({ event: { subscribe: () => bus.subscribe(Event.Updated) } }))

      // Initially no soft limit: ceiling for 100k model is 84k, so 60k tokens is not due.
      expect(yield* due(lowerTokens)).toBe(false)

      // Set soft limit for "test-provider/test-model" to 60k.
      // Clamped window = 60k. Reserve = 16k. Ceiling = 44k.
      // 60k >= 44k, so auto compaction is now due.
      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({
            compaction: new ConfigCompaction.Info({
              auto: true,
              soft_limits: {
                "test-provider/test-model": 60_000,
              },
            }),
          }),
        }),
      ])
      yield* bus.publish(Event.Updated, {})
      for (let attempt = 0; attempt < 200; attempt++) {
        if (yield* due(lowerTokens)) break
        yield* Effect.sleep("10 millis")
        if (attempt === 199) yield* Effect.die(new Error("Timed out waiting for soft limit reload"))
      }
      expect(yield* due(lowerTokens)).toBe(true)

      // Update soft limit to 80k.
      // Clamped window = 80k. Reserve = 16k. Ceiling = 64k.
      // 60k < 64k, so auto compaction is no longer due.
      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({
            compaction: new ConfigCompaction.Info({
              auto: true,
              soft_limits: {
                "test-provider/test-model": 80_000,
              },
            }),
          }),
        }),
      ])
      yield* bus.publish(Event.Updated, {})
      for (let attempt = 0; attempt < 200; attempt++) {
        if (!(yield* due(lowerTokens))) break
        yield* Effect.sleep("10 millis")
        if (attempt === 199) yield* Effect.die(new Error("Timed out waiting for soft limit update reload"))
      }
      expect(yield* due(lowerTokens)).toBe(false)
    }),
  )
})

const session = Session.Info.make({
  id: Session.ID.make("ses_compaction_config"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/tmp") }),
})
const input = (tokens: number) => {
  const messages = [
    Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.make("msg_compaction_config"),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "test-model", providerID: "test-provider" },
      content: [],
      tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, completed: 0 },
    }),
  ]
  return {
    session,
    resolved,
    messages,
    context: {
      session,
      model: resolved,
      messages,
      agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
      initial: "",
      tools: { definitions: [], execute: () => Effect.die("unused") },
    },
  }
}
const bufferedInput = input(85_000)
const nearInput = input(95_000)
