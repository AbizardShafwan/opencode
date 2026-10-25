import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM, Message } from "../src/index.js"
import { AnthropicMessages } from "../src/protocols/anthropic-messages.js"
import { OpenAIChat } from "../src/protocols/openai-chat.js"
import { OpenAIResponses } from "../src/protocols/openai-responses.js"
import { OpenAICompatibleResponses } from "../src/protocols/openai-compatible-responses.js"
import { GoogleVertexMessages } from "../src/providers.js"
import { it } from "./lib/effect.js"

describe("native system update capability", () => {
  test("defaults to leading-only for protocols that wrap updates as user content", () => {
    const model = OpenAIChat.route.model({ id: "deepseek-v4-flash" })
    expect(model.route.supportsSystemUpdates?.(model) ?? false).toBe(false)
  })

  test("Responses routes preserve the capability through deployment overrides", () => {
    for (const route of [OpenAIResponses.route, OpenAICompatibleResponses.route]) {
      const model = route
        .with({ provider: "test", endpoint: { baseURL: "https://provider.test/v1" } })
        .model({ id: "test" })
      expect(model.route.supportsSystemUpdates?.(model)).toBe(true)
    }
  })

  for (const [id, native] of [
    ["claude-sonnet-4-6", false],
    ["claude-opus-4-8", true],
    ["claude-opus-5", true],
    ["unknown", false],
  ] as const) {
    it.effect(`Anthropic capability matches wire roles for ${id}`, () =>
      Effect.gen(function* () {
        const model = AnthropicMessages.route.model({ id })
        const body = yield* AnthropicMessages.protocol.body.from(
          LLM.request({
            model,
            system: "Initial policy",
            messages: [Message.user("Continue"), Message.system("Updated policy")],
          }),
        )
        expect(model.route.supportsSystemUpdates?.(model)).toBe(native)
        expect(body.messages.some((message) => message.role === "system")).toBe(native)
        expect(JSON.stringify(body.messages)).toContain("Updated policy")
      }),
    )
  }

  test("Vertex forwards the Anthropic capability", () => {
    const model = GoogleVertexMessages.configure({ accessToken: "test", location: "global", project: "test" }).model(
      "claude-opus-4-8",
    )
    expect(model.route.supportsSystemUpdates?.(model)).toBe(true)
  })

  it.effect("OpenAI Responses keeps updated policy privileged and preserves earlier input", () =>
    Effect.gen(function* () {
      const model = OpenAIResponses.route.model({ id: "gpt-6" })
      const initial = [Message.user("First"), Message.assistant("Done")]
      const first = yield* OpenAIResponses.protocol.body.from(
        LLM.request({
          model,
          system: "Initial policy",
          messages: initial,
        }),
      )
      const next = yield* OpenAIResponses.protocol.body.from(
        LLM.request({
          model,
          system: "Initial policy",
          messages: [...initial, Message.system("Updated policy"), Message.user("Continue")],
        }),
      )
      expect(first.instructions).toBe("Initial policy")
      expect(next.instructions).toBe(first.instructions)
      expect(JSON.stringify(next.input.slice(0, first.input.length))).toBe(JSON.stringify(first.input))
      expect(next.input[first.input.length]).toMatchObject({
        type: "message",
        role: "developer",
        content: "Updated policy",
      })
    }),
  )
})
