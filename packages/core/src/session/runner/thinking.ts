export * as SessionThinking from "./thinking.js"

import { mergeJsonRecords, type LLMRequest } from "@opencode/ai"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Option, Schema } from "effect"

const block = Schema.Struct({
  type: Schema.optional(Schema.Literals(["enabled", "disabled", "adaptive"])),
  budgetTokens: Schema.optional(Schema.Int),
  budget_tokens: Schema.optional(Schema.Int),
  tokenBudget: Schema.optional(Schema.Int),
  maxReasoningEffort: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
})
const config = Schema.Struct({
  thinkingLevel: Schema.optional(Schema.String),
  thinkingBudget: Schema.optional(Schema.Int),
})
const output = Schema.Struct({ effort: Schema.optional(Schema.String) })
const fields = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.String),
  reasoning_effort: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  enableThinking: Schema.optional(Schema.Boolean),
  thinkingLevel: Schema.optional(Schema.String),
  thinkingBudget: Schema.optional(Schema.Int),
  reasoning_budget: Schema.optional(Schema.Int),
  thinking: Schema.optional(Schema.Union([Schema.Boolean, block])),
  thinkingConfig: Schema.optional(config),
  generationConfig: Schema.optional(Schema.Struct({ thinkingConfig: Schema.optional(config) })),
  outputConfig: Schema.optional(output),
  output_config: Schema.optional(output),
  reasoningConfig: Schema.optional(block),
  reasoning: Schema.optional(
    Schema.Struct({
      effort: Schema.optional(Schema.String),
      enabled: Schema.optional(Schema.Boolean),
      max_tokens: Schema.optional(Schema.Int),
    }),
  ),
  chat_template_args: Schema.optional(Schema.Struct({ enable_thinking: Schema.optional(Schema.Boolean) })),
  chat_template_kwargs: Schema.optional(
    Schema.Struct({
      enable_thinking: Schema.optional(Schema.Boolean),
      thinking: Schema.optional(Schema.Boolean),
      reasoning_effort: Schema.optional(Schema.String),
      thinking_mode: Schema.optional(Schema.Literals(["enabled", "disabled"])),
    }),
  ),
})
const nested = Schema.Struct({ ...fields.fields, additionalModelRequestFields: Schema.optional(fields) })
const decode = Schema.decodeUnknownOption(
  Schema.Struct({
    ...nested.fields,
    modelParams: Schema.optional(nested),
  }),
)

/** Snapshot recognized request settings after model defaults and session hooks, without recording arbitrary options. */
export function configured(request: LLMRequest): SessionMessage.Thinking | undefined {
  const parsed = Option.getOrUndefined(
    decode(
      mergeJsonRecords(
        request.model.route.defaults.providerOptions,
        request.model.defaults?.providerOptions,
        request.providerOptions,
        request.model.route.defaults.http?.body,
        request.model.defaults?.http?.body,
        request.http?.body,
      ) ?? {},
    ),
  )
  if (!parsed) return
  const options = {
    ...parsed,
    ...parsed.additionalModelRequestFields,
    ...parsed.modelParams,
    ...parsed.modelParams?.additionalModelRequestFields,
  }
  const thinking = typeof options.thinking === "boolean" ? undefined : (options.thinking ?? options.reasoningConfig)
  const toggle =
    (typeof options.thinking === "boolean" ? options.thinking : undefined) ??
    options.enableThinking ??
    options.reasoning?.enabled ??
    options.chat_template_kwargs?.enable_thinking ??
    options.chat_template_kwargs?.thinking ??
    options.chat_template_args?.enable_thinking
  const gemini = options.generationConfig?.thinkingConfig ?? options.thinkingConfig
  const effort =
    options.output_config?.effort ??
    options.outputConfig?.effort ??
    options.reasoning?.effort ??
    options.chat_template_kwargs?.reasoning_effort ??
    thinking?.effort ??
    thinking?.maxReasoningEffort ??
    options.reasoning_effort ??
    options.reasoningEffort ??
    options.effort ??
    gemini?.thinkingLevel ??
    options.thinkingLevel
  const budget =
    thinking?.budget_tokens ??
    thinking?.budgetTokens ??
    thinking?.tokenBudget ??
    gemini?.thinkingBudget ??
    options.thinkingBudget ??
    options.reasoning?.max_tokens ??
    options.reasoning_budget
  const mode =
    thinking?.type ??
    options.chat_template_kwargs?.thinking_mode ??
    (toggle === false || effort === "none" || budget === 0
      ? "disabled"
      : toggle === true
        ? "enabled"
        : budget === -1
          ? "adaptive"
          : undefined)
  if (mode === "disabled") return { mode }
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(effort === undefined ? {} : { effort }),
    ...(budget === undefined || budget < -1 ? {} : { budget }),
  }
}
