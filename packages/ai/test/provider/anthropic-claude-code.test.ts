import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Headers } from "effect/http"
import { LLM, LLMRequest, Message, ToolCallPart, ToolDefinition } from "../../src/index.js"
import { AnthropicClaudeCode } from "../../src/providers/anthropic-claude-code.js"
import { Auth, LLMClient } from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, observe, type Call } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const route = AnthropicClaudeCode.route({
  baseURL: "https://api.anthropic.test/v1/",
  authToken: "sk-ant-oat-test",
})

const model = route.model({ id: "claude-sonnet-5-5" })

const tools = [
  ToolDefinition.make({ name: "read", description: "Read a file", inputSchema: { type: "object" } }),
  ToolDefinition.make({ name: "grep", description: "Search files", inputSchema: { type: "object" } }),
  ToolDefinition.make({ name: "custom_tool", description: "Custom", inputSchema: { type: "object" } }),
]

const request = LLM.request({
  model,
  system: { type: "text", text: "You are concise." },
  messages: [
    Message.user("Inspect the file."),
    Message.assistant([ToolCallPart.make({ id: "call_1", name: "read", input: { filePath: "README.md" } })]),
    Message.tool({ id: "call_1", name: "read", result: "contents" }),
  ],
  tools,
  toolChoice: { type: "tool", name: "read" },
  cache: "none",
})

describe("Anthropic Claude Code subscription route", () => {
  it.effect("builds the Claude Code request envelope", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(request)

      expect(prepared.body.system).toEqual([
        { type: "text", text: AnthropicClaudeCode.SYSTEM_IDENTITY },
        { type: "text", text: "You are concise." },
      ])
      expect(prepared.body.tools).toEqual([
        { name: "Read", description: "Read a file", input_schema: { type: "object" } },
        { name: "Grep", description: "Search files", input_schema: { type: "object" } },
        { name: "custom_tool", description: "Custom", input_schema: { type: "object" } },
      ])
      expect(prepared.body.tool_choice).toEqual({ type: "tool", name: "Read" })
      expect(prepared.body.messages).toMatchObject([
        { role: "user", content: [{ type: "text", text: "Inspect the file." }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Read" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1" }] },
      ])
    }),
  )

  it.effect("does not duplicate the Claude Code identity", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLMRequest.update(request, {
          system: [{ type: "text", text: `${AnthropicClaudeCode.SYSTEM_IDENTITY}\nBe brief.` }],
        }),
      )

      expect(prepared.body.system).toEqual([
        { type: "text", text: `${AnthropicClaudeCode.SYSTEM_IDENTITY}\nBe brief.` },
      ])
    }),
  )

  it.effect("leaves ambiguous case variants untouched", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLMRequest.update(request, {
          tools: [
            ToolDefinition.make({ name: "read", description: "lower", inputSchema: { type: "object" } }),
            ToolDefinition.make({ name: "Read", description: "upper", inputSchema: { type: "object" } }),
          ],
        }),
      )

      expect(prepared.body.tools?.map((tool) => tool.name)).toEqual(["read", "Read"])
    }),
  )

  it.effect("sets bearer authentication and subscription headers", () =>
    Effect.gen(function* () {
      expect(route.headers).toBeDefined()
      const deployment = route.headers!({ request })
      expect(deployment).toEqual({
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
        "x-app": "cli",
        "user-agent": "claude-cli/2.1.75",
        accept: "application/json",
      })

      const headers = yield* Auth.toEffect(route.auth)({
        request: { http: { headers: deployment } },
        method: "POST",
        url: "https://api.anthropic.test/v1/messages",
        body: "{}",
        headers: Headers.fromInput({}),
      })
      expect(headers.authorization).toBe("Bearer sk-ant-oat-test")
    }),
  )

  it.effect("forwards route defaults from provider and variant settings", () =>
    Effect.gen(function* () {
      const configured = AnthropicClaudeCode.route({
        baseURL: "https://api.anthropic.test/v1/",
        authToken: "sk-ant-oat-test",
        generation: { maxTokens: 4_096, temperature: 0.1 },
        providerOptions: { thinking: { type: "enabled", budgetTokens: 1_024 } },
        headers: { "x-configured": "yes" },
        http: { body: { custom_extension: { enabled: true } } },
      })
      const calls: Call[] = []
      const body = sseEvents(
        { type: "message_start", message: { usage: { input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      )
      yield* LLMClient.generate(
        LLM.request({ model: configured.model({ id: "claude-sonnet-5-5" }), prompt: "Hello" }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              yield* observe(calls, input)
              return input.respond(body, { headers: { "content-type": "text/event-stream" } })
            }),
          ),
        ),
      )

      const sent = calls[0]!
      expect(JSON.parse(sent.body)).toMatchObject({
        max_tokens: 4_096,
        temperature: 0.1,
        thinking: { type: "enabled", budget_tokens: 1_024 },
        custom_extension: { enabled: true },
      })
      expect(sent.headers.get("x-configured")).toBe("yes")
    }),
  )

  it.effect("applies automatic prompt caching", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(LLMRequest.update(request, { cache: undefined }))

      expect(prepared.body.system).toMatchObject([
        { type: "text", text: AnthropicClaudeCode.SYSTEM_IDENTITY },
        { type: "text", text: "You are concise.", cache_control: { type: "ephemeral" } },
      ])
      expect(prepared.body.tools?.at(-1)).toMatchObject({ cache_control: { type: "ephemeral" } })
    }),
  )

  it.effect("round-trips streamed canonical tool names to request names", () =>
    Effect.gen(function* () {
      const calls: Call[] = []
      const body = sseEvents(
        { type: "message_start", message: { usage: { input_tokens: 5 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "Read" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"filePath"' } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ':"README.md"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      )
      const response = yield* LLMClient.generate(
        LLMRequest.update(request, {
          tools: [ToolDefinition.make({ name: "read", description: "Read a file", inputSchema: { type: "object" } })],
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              yield* observe(calls, input)
              return input.respond(body, { headers: { "content-type": "text/event-stream" } })
            }),
          ),
        ),
      )

      expect(response.toolCalls).toMatchObject([{ type: "tool-call", id: "call_1", name: "read" }])
      expect(response.events.filter((event) => event.type.startsWith("tool-"))).toMatchObject([
        { type: "tool-input-start", name: "read" },
        { type: "tool-input-delta", name: "read" },
        { type: "tool-input-delta", name: "read" },
        { type: "tool-input-end", name: "read" },
        { type: "tool-call", name: "read" },
      ])

      expect(calls).toHaveLength(1)
      const sent = calls[0]!
      expect(JSON.parse(sent.body).tools).toMatchObject([{ name: "Read" }])
      expect(sent.headers.get("authorization")).toBe("Bearer sk-ant-oat-test")
      expect(sent.headers.get("x-app")).toBe("cli")
      expect(sent.headers.get("user-agent")).toBe("claude-cli/2.1.75")
      expect(sent.headers.get("anthropic-beta")).toContain("oauth-2025-04-20")
      expect(sent.headers.get("anthropic-beta")).toContain("claude-code-20250219")
      expect(sent.headers.get("anthropic-beta")).toContain("interleaved-thinking-2025-05-14")
    }),
  )
})
