export * as SessionSystemPrompt from "./system-prompt.js"

import { Effect, Schema } from "effect"
import type { SessionMessage } from "./message.js"
import { Instructions } from "../instructions/index.js"
import PROMPT from "./runner/prompt/system.txt"
import VISUAL_VERIFICATION from "./runner/prompt/visual-verification.txt"

export const key = Instructions.Key.make("core/system-policy")

// Tool contracts live in their definitions, not in the shared policy prefix.
export function make() {
  return `${PROMPT}\n${VISUAL_VERIFICATION}`
}

/** Admit policy changes through the same durable path as project and runtime context. */
export function source(system: string | undefined) {
  return Instructions.make({
    key,
    codec: Schema.toCodecJson(Schema.String),
    read: Effect.succeed(system || make()),
    render: {
      initial: String,
      changed: (_previous, current) =>
        `The agent policy is now the following. It supersedes earlier agent policy, but does not remove project instructions or change tool permissions.

${current}`,
    },
  })
}

/** Separate the shared policy from project context for independent cache boundaries. */
export function baseline(instructions: Instructions.List, values: Readonly<Record<string, Schema.Json>>) {
  const policy = instructions.find((source) => source.key === key)
  return {
    policy: policy && Object.hasOwn(values, key) ? policy.initial(values[key]) : undefined,
    initial: Instructions.renderInitial(
      instructions.filter((source) => source.key !== key),
      values,
    ),
  }
}

/** Only our standalone policy updates may be omitted on a leading-only route. */
export function isUpdate(message: SessionMessage.Info) {
  if (message.type !== "system") return false
  const sources = message.metadata?.instructionSources
  return Array.isArray(sources) && sources.length === 1 && sources[0] === key
}
