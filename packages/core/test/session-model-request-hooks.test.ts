import { describe, expect } from "bun:test"
import { LLMClient, Message, SystemPart, ToolDefinition } from "@opencode/ai"
import { Anthropic } from "@opencode/ai/providers"
import { RequestExecutor } from "@opencode/ai/route"
import { App } from "@opencode/core/app"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import type { SessionRequestKind } from "@opencode/plugin/effect/session"
import { Location } from "@opencode/core/location"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { DateTime, Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const KINDS: ReadonlyArray<SessionRequestKind> = ["primary", "compaction", "title", "generate"]

const session = Session.Info.make({
  id: Session.ID.make("ses_hook_kind"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const model = SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit: { context: 200_000, output: 32_000 },
})
const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})

describe("SessionModelRequest Anthropic identity", () => {
  it.effect("preserves the API key and application user-agent for every Session request kind", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const app = yield* App.Metadata
      const calls: HttpClientRequest.HttpClientRequest[] = []
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          calls.push(request)
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              [
                { type: "message_start", message: { usage: { input_tokens: 1 } } },
                { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
                { type: "message_stop" },
              ]
                .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
                .join(""),
              { headers: { "content-type": "text/event-stream" } },
            ),
          )
        }),
      )
      const llm = yield* LLMClient.Service.pipe(
        Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.fresh)),
        Effect.provideService(HttpClient.HttpClient, http),
      )
      const selected = SessionRunnerModel.resolved(
        Anthropic.configure({
          apiKey: "sk-ant-api03-test",
          baseURL: "https://api.anthropic.test/v1",
          headers: { "x-configured": "preserved" },
        }).model("claude-opus-5"),
        {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          cost: [],
          limit: { context: 1_000_000, output: 128_000 },
        },
      )

      for (const kind of KINDS) {
        const prepared = yield* requests[kind]({
          session,
          agent: Agent.ID.make("build"),
          model: selected,
          system: [SystemPart.make("Be concise.")],
          messages: [Message.user("Hi")],
        })
        yield* llm.generate(prepared.request, prepared.options)
      }

      expect(calls).toHaveLength(KINDS.length)
      for (const call of calls) {
        expect(call.headers).toMatchObject({
          "user-agent": App.useragent(app),
          "x-opencode-session-id": session.id,
          "x-configured": "preserved",
          "x-api-key": "sk-ant-api03-test",
        })
        expect(call.headers.authorization).toBeUndefined()
      }
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )
})

describe("SessionModelRequest HTTP hooks", () => {
  it.effect("tags every Session request kind on http.request and http.response", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const seen: Array<{ hook: string; kind: SessionRequestKind; agent: Agent.ID }> = []
      yield* hooks.register("session", "http.request", (event) =>
        Effect.sync(() => {
          seen.push({ hook: "request", kind: event.kind, agent: event.agent })
        }),
      )
      yield* hooks.register("session", "http.response", (event) =>
        Effect.sync(() => {
          seen.push({ hook: "response", kind: event.kind, agent: event.agent })
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))

      for (const kind of KINDS) {
        const prepared = yield* requests[kind]({
          session,
          agent: Agent.ID.make("build"),
          model,
          system: [],
          messages: [],
        })
        const http = prepared.options.http
        if (!http) throw new Error(`Expected HTTP middleware for ${kind}`)
        yield* http(HttpClientRequest.post("https://example.test/v1/chat/completions"), (request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }))),
        )
      }

      expect(seen).toEqual(
        KINDS.flatMap((kind) => [
          { hook: "request", kind, agent: Agent.ID.make("build") },
          { hook: "response", kind, agent: Agent.ID.make("build") },
        ]),
      )
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("offers the WebSocket executor alongside HTTP hooks and routes the WebSocket hooks", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const seen: string[] = []
      yield* hooks.register("session", "http.request", () => Effect.sync(() => void seen.push("http.request")))
      yield* hooks.register("session", "experimental.ws.handshake", (event) =>
        Effect.sync(() => {
          seen.push(`handshake:${event.kind}:${event.url}`)
          event.headers.authorization = "Bearer minted"
          delete event.headers["api-key"]
        }),
      )
      yield* hooks.register("session", "experimental.ws.send", (event) =>
        Effect.sync(() => {
          seen.push(`send:${event.kind}:${event.frame}`)
          event.frame = `${event.frame}+plugin`
        }),
      )
      yield* hooks.register("session", "experimental.ws.receive", (event) =>
        Effect.sync(() => {
          seen.push(`receive:${event.kind}:${event.frame}`)
          event.frame = event.frame.toUpperCase()
        }),
      )
      const bound: Array<{ url: string; headers: Record<string, string> }> = []
      const frames: string[] = []
      const websocketTransport = SessionModelTransport.Service.of({
        bind: (_sessionID, interceptor) => ({
          execute: () =>
            Effect.gen(function* () {
              if (!interceptor?.handshake || !interceptor.send || !interceptor.receive)
                throw new Error("Expected a full WebSocket interceptor")
              bound.push(
                yield* interceptor.handshake({ url: "wss://example.test/v1/responses", headers: { "api-key": "k" } }),
              )
              frames.push(yield* interceptor.send("create"))
              frames.push(yield* interceptor.receive("created"))
              return { frames: Stream.empty, complete: Effect.void }
            }),
        }),
        close: () => Effect.void,
        closeAll: Effect.void,
      })
      const requests = yield* SessionModelRequest.Service.pipe(
        Effect.provide(SessionModelRequest.layer),
        Effect.provideService(SessionModelTransport.Service, websocketTransport),
      )
      const prepared = yield* requests.primary({
        session,
        agent: Agent.ID.make("build"),
        model: SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          cost: [],
          limit: { context: 200_000, output: 32_000 },
          transport: "websocket",
        }),
        system: [],
        messages: [],
        webSocket: "session",
      })

      expect(prepared.options.http).toBeDefined()
      expect(prepared.options.webSocket).toBeDefined()
      yield* prepared.options.webSocket!.execute({} as never)
      expect(bound).toEqual([{ url: "wss://example.test/v1/responses", headers: { authorization: "Bearer minted" } }])
      expect(frames).toEqual(["create+plugin", "CREATED"])
      expect(seen).toEqual([
        "handshake:primary:wss://example.test/v1/responses",
        "send:primary:create",
        "receive:primary:created",
      ])
    }),
  )
})

it.effect("keeps wire tools and the conversation prefix stable after hook reordering", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    let reverse = false
    yield* hooks.register("session", "context", (event) =>
      Effect.sync(() => {
        if (!reverse) return
        event.tools = Object.fromEntries(Object.entries(event.tools).reverse())
        event.tools.alpha.input = {
          properties: { z: { description: "Last", type: "string" }, a: { type: "number" } },
          required: ["z", "a"],
          type: "object",
        }
      }),
    )
    const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
    const definitions = ["zebra", "alpha"].map(
      (name) =>
        new ToolDefinition({
          name,
          description: name,
          inputSchema:
            name === "alpha"
              ? {
                  type: "object",
                  required: ["z", "a"],
                  properties: { a: { type: "number" }, z: { type: "string", description: "Last" } },
                }
              : { type: "object", properties: {} },
        }),
    )
    const input = {
      session,
      agent: Agent.ID.make("build"),
      model,
      system: [SystemPart.make(SessionSystemPrompt.make()), SystemPart.make("Project context")],
      tools: { definitions, execute: () => Effect.die("not executed") },
      messages: [Message.user("Inspect the project")],
    }
    const first = yield* requests.primary(input)
    reverse = true
    const next = yield* requests.primary({
      ...input,
      messages: [...input.messages, Message.assistant("Inspected"), Message.user("Continue")],
    })
    const before = yield* OpenAIChat.fromRequest(first.request)
    const after = yield* OpenAIChat.fromRequest(next.request)
    expect(before.tools?.map((tool) => (tool.type === "function" ? tool.function.name : undefined))).toEqual([
      "alpha",
      "zebra",
    ])
    expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools))
    expect(JSON.stringify(after.messages.slice(0, before.messages.length))).toBe(JSON.stringify(before.messages))
    expect(next.request.promptCacheKey).toBe(first.request.promptCacheKey)
    expect(definitions.map((tool) => tool.name)).toEqual(["zebra", "alpha"])
    expect(after.tools?.[0]).toMatchObject({ function: { parameters: { required: ["z", "a"] } } })
    expect(Object.keys(definitions[1]!.inputSchema)).toEqual(["type", "required", "properties"])
  }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
)
