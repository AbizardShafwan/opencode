import { describe, expect } from "bun:test"
import { AIError, InvalidRequestError, LanguageModel, LLM, LLMEvent } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Permission } from "@opencode/core/permission"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStep } from "@opencode/core/session/runner/step"
import { SessionTable } from "@opencode/core/session/sql"
import { Snapshot } from "@opencode/core/snapshot"
import { Tool } from "@opencode/core/tool"
import { ToolOutput } from "@opencode/core/tool-output"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node, ToolOutput.node]), [
      Bus.node.replace(Bus.configured({ persist: true })),
    ]),
    TestLLM.testLayer(),
  ),
)

const model = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }),
  {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 100_000, output: 1_000 },
    cost: [],
  },
)

const usage = { inputTokens: 10, outputTokens: 2, nonCachedInputTokens: 10 }

const stepStart = LLMEvent.stepStart({ index: 0 })
const toolCalls = (...calls: ReadonlyArray<{ id: string; name: string }>) => [
  stepStart,
  ...calls.map((call) => LLMEvent.toolCall({ id: call.id, name: call.name, input: {} })),
]
const stepEnd = [
  LLMEvent.stepFinish({ index: 0, reason: { normalized: "tool-calls" }, usage }),
  LLMEvent.finish({ reason: { normalized: "tool-calls" } }),
]

const seed = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, slug: String(sessionID), directory: "/project", version: "test" })
      .run()
  })

type Executed = { readonly name: string }
type DeferredOutcome = { readonly id: string; readonly error: string }

const attempt = (options: {
  readonly sessionID: Session.ID
  readonly response: TestLLM.Response
  readonly execute: (call: { readonly id: string; readonly name: string }) => Effect.Effect<
    Tool.NormalizedResult,
    Tool.Error | Permission.DeclinedError
  >
  readonly isDeferred: (name: string) => boolean
}) =>
  Effect.gen(function* () {
    const llm = yield* TestLLM.Test
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(Layer.mock(Snapshot.Service)({ capture: () => Effect.succeed(undefined) })),
    )
    yield* llm.push(options.response)
    yield* seed(options.sessionID)
    return yield* steps.attempt({
      isLocationClosed: () => false,
      sessionID: options.sessionID,
      assistantMessageID: SessionMessage.ID.create(),
      agent: Agent.defaultID,
      model,
      prepared: {
        retry: () => Effect.void,
        request: LLM.request({ model: model.model, prompt: "Call the tools" }),
        options: {},
        executeTool: (input) => options.execute({ id: input.call.id, name: input.call.name }),
        isDeferredTool: options.isDeferred,
      },
      retry: (_cause, _error, retry) =>
        Effect.succeed(retry ? { retry: true, attempt: 2, delay: 0 } : { retry: false }),
      recoverContinuation: true,
      recoverOverflow: Effect.succeed(false),
    })
  })

const record = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const executed: Executed[] = []
  const failures: DeferredOutcome[] = []
  const successes: string[] = []
  yield* bus.project(SessionEvent.Tool.Failed, (event) =>
    Effect.sync(() => void failures.push({ id: event.data.id, error: event.data.error.message })),
  )
  yield* bus.project(SessionEvent.Tool.Success, (event) => Effect.sync(() => void successes.push(event.data.id)))
  return { executed, failures, successes }
})

const result = { content: [{ type: "text" as const, text: "ran" }], metadata: {} }

describe("SessionStep deferred tool calls", () => {
  it.effect("runs a deferred call after the stream and its siblings finish", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_deferred_order")
      const siblingDone = yield* Deferred.make<void>()
      const { executed, failures, successes } = yield* record

      // The stream does not end until the sibling tool has completed, so the deferred call can only run afterwards.
      const response = Stream.concat(
        Stream.fromIterable(toolCalls({ id: "call-sibling", name: "sibling" }, { id: "call-deferred", name: "deferred" })),
        Stream.fromEffect(Deferred.await(siblingDone)).pipe(Stream.flatMap(() => Stream.fromIterable(stepEnd))),
      )

      const outcome = yield* attempt({
        sessionID,
        response,
        isDeferred: (name) => name === "deferred",
        execute: (call) =>
          Effect.gen(function* () {
            executed.push({ name: call.name })
            if (call.name === "sibling") yield* Deferred.succeed(siblingDone, undefined)
            return result
          }),
      })

      expect(outcome).toEqual(SessionStep.Outcome.Completed({ needsContinuation: true }))
      expect(executed).toEqual([{ name: "sibling" }, { name: "deferred" }])
      expect(successes).toEqual(["call-sibling", "call-deferred"])
      expect(failures).toEqual([])
    }),
  )

  it.effect("skips deferred calls and settles them once when a sibling fails", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_deferred_sibling_error")
      const { executed, failures, successes } = yield* record

      yield* attempt({
        sessionID,
        response: [...toolCalls({ id: "call-sibling", name: "sibling" }, { id: "call-deferred", name: "deferred" }), ...stepEnd],
        isDeferred: (name) => name === "deferred",
        execute: (call) =>
          Effect.gen(function* () {
            executed.push({ name: call.name })
            if (call.name === "sibling") return yield* new Tool.Error({ message: "sibling exploded" })
            return result
          }),
      })

      expect(executed).toEqual([{ name: "sibling" }])
      expect(successes).toEqual([])
      expect(failures).toEqual([
        { id: "call-sibling", error: "sibling exploded" },
        {
          id: "call-deferred",
          error: "Skipped deferred tool because an earlier sibling tool did not succeed",
        },
      ])
    }),
  )

  it.effect("skips deferred calls and settles them once when a sibling is declined", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_deferred_decline")
      const { executed, failures, successes } = yield* record

      const exit = yield* attempt({
        sessionID,
        response: [...toolCalls({ id: "call-sibling", name: "sibling" }, { id: "call-deferred", name: "deferred" }), ...stepEnd],
        isDeferred: (name) => name === "deferred",
        execute: (call) =>
          Effect.gen(function* () {
            executed.push({ name: call.name })
            if (call.name === "sibling") return yield* new Permission.DeclinedError({})
            return result
          }),
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(executed).toEqual([{ name: "sibling" }])
      expect(successes).toEqual([])
      expect(failures.map((failure) => failure.id)).toEqual(["call-deferred", "call-sibling"])
      expect(failures[0]?.error).toBe("Skipped deferred tool because an earlier sibling tool did not succeed")
    }),
  )

  it.effect("skips deferred calls and settles them once when the stream fails", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_deferred_stream_failure")
      const { executed, failures, successes } = yield* record
      const response = Stream.concat(
        Stream.fromIterable(toolCalls({ id: "call-sibling", name: "sibling" }, { id: "call-deferred", name: "deferred" })),
        Stream.fail(new AIError({ reason: new InvalidRequestError({ message: "provider failed" }) })),
      )

      const exit = yield* attempt({
        sessionID,
        response,
        isDeferred: (name) => name === "deferred",
        execute: (call) =>
          Effect.sync(() => {
            executed.push({ name: call.name })
            return result
          }),
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(executed).toEqual([{ name: "sibling" }])
      expect(successes).toEqual(["call-sibling"])
      expect(failures).toEqual([{ id: "call-deferred", error: "Tool execution interrupted" }])
    }),
  )

  it.effect("skips deferred calls and settles them once when the stream is interrupted", () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_deferred_interrupt")
      const bus = yield* Bus.Service
      const { executed, failures, successes } = yield* record
      const buffered = yield* Deferred.make<void>()
      yield* bus
        .project(SessionEvent.Tool.Called, (event) =>
          event.data.id === "call-deferred" ? Deferred.succeed(buffered, undefined).pipe(Effect.asVoid) : Effect.void,
        )
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow

      const fiber = yield* attempt({
        sessionID,
        response: TestLLM.hangAfter(
          ...toolCalls({ id: "call-sibling", name: "sibling" }, { id: "call-deferred", name: "deferred" }),
        ),
        isDeferred: (name) => name === "deferred",
        execute: (call) =>
          Effect.gen(function* () {
            executed.push({ name: call.name })
            return result
          }),
      }).pipe(Effect.forkScoped)

      yield* Deferred.await(buffered)
      yield* Fiber.interrupt(fiber)
      yield* Fiber.await(fiber)

      expect(executed.map((item) => item.name)).toEqual(["sibling"])
      expect(successes).toEqual(["call-sibling"])
      expect(failures).toEqual([{ id: "call-deferred", error: "Tool execution interrupted" }])
    }),
  )
})
