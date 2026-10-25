import { expect, test } from "bun:test"
import { LLM } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { SessionThinking } from "@opencode/core/session/runner/thinking"

const model = OpenAIChat.route.with({ providerOptions: { reasoningEffort: "high" } }).model({ id: "test" })

test("records resolved defaults and request overrides, not the selected variant's name", () => {
  expect(SessionThinking.configured(LLM.request({ model }))).toEqual({ effort: "high" })
  expect(SessionThinking.configured(LLM.request({ model, providerOptions: { reasoningEffort: "low" } }))).toEqual({
    effort: "low",
  })
})

test("wire body overrides and disabled thinking take precedence", () => {
  expect(SessionThinking.configured(LLM.request({ model, http: { body: { reasoning_effort: "max" } } }))).toEqual({
    effort: "max",
  })
  expect(
    SessionThinking.configured(LLM.request({ model, http: { body: { thinking: { type: "disabled" } } } })),
  ).toEqual({ mode: "disabled" })
})

test.each([
  [{ thinking: { type: "adaptive", effort: "max" } }, { mode: "adaptive", effort: "max" }],
  [
    {
      modelParams: {
        additionalModelRequestFields: { thinking: { type: "adaptive" }, output_config: { effort: "high" } },
      },
    },
    { mode: "adaptive", effort: "high" },
  ],
  [
    { additionalModelRequestFields: { reasoningConfig: { type: "enabled", maxReasoningEffort: "high" } } },
    { mode: "enabled", effort: "high" },
  ],
  [{ chat_template_kwargs: { thinking: true, reasoning_effort: "max" } }, { mode: "enabled", effort: "max" }],
  [{ chat_template_args: { enable_thinking: false } }, { mode: "disabled" }],
  [{ thinking: { type: "enabled", tokenBudget: 4096 } }, { mode: "enabled", budget: 4096 }],
  [{ thinking: { type: "enabled", budgetTokens: 4096 } }, { mode: "enabled", budget: 4096 }],
  [
    { thinking: { type: "adaptive" }, output_config: { effort: "max" } },
    { mode: "adaptive", effort: "max" },
  ],
  [{ thinkingConfig: { thinkingLevel: "high" } }, { effort: "high" }],
  [{ thinkingConfig: { thinkingBudget: -1 } }, { mode: "adaptive", budget: -1 }],
  [{ thinkingConfig: { thinkingBudget: 0 } }, { mode: "disabled" }],
  [{ enableThinking: false }, { mode: "disabled" }],
  [
    { chat_template_kwargs: { enable_thinking: true }, reasoning_budget: 8192 },
    { mode: "enabled", budget: 8192 },
  ],
] as const)("captures supported reasoning settings %j", (options, expected) => {
  const request = LLM.request({ model: OpenAIChat.route.model({ id: "test" }), providerOptions: options })
  expect(SessionThinking.configured(request)).toEqual(expected)
})

test("does not persist unrelated options or invent settings for an invalid configuration", () => {
  const plain = OpenAIChat.route.model({ id: "test" })
  expect(SessionThinking.configured(LLM.request({ model: plain, providerOptions: { apiKey: "private" } }))).toEqual({})
  expect(
    SessionThinking.configured(LLM.request({ model: plain, providerOptions: { reasoningEffort: 42 } })),
  ).toBeUndefined()
})
