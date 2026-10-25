export * as ConfigAgentFile from "./agent-file.js"

import { Effect, Schema } from "effect"
import { parse } from "smol-toml"
import { Document, Info } from "@opencode/schema/config"
import { ConfigAgent } from "@opencode/schema/config/agent"
import { Model } from "@opencode/schema/model"
import { Permission } from "@opencode/schema/permission"
import { AbsolutePath } from "../../schema.js"
import { SessionSystemPrompt } from "../../session/system-prompt.js"

// Role files may specialize the assignment and model, never the host's sandbox/approval authority.
const Role = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)),
  description: Schema.NonEmptyString,
  developer_instructions: Schema.NonEmptyString,
  model: Schema.optionalKey(Schema.NonEmptyString),
  model_provider: Schema.optionalKey(Schema.NonEmptyString),
  model_reasoning_effort: Schema.optionalKey(Model.VariantID),
  permissions: Schema.optionalKey(Permission.Ruleset),
  mode: ConfigAgent.Info.fields.mode,
  steps: ConfigAgent.Info.fields.steps,
  disabled: Schema.optionalKey(Schema.Boolean),
})

export const decode = Effect.fn("ConfigAgentFile.decode")(function* (file: string, content: string) {
  return yield* Effect.gen(function* () {
    const parsed = yield* Effect.try(() => parse(content))
    const role = yield* Schema.decodeUnknownEffect(Role)(parsed, { onExcessProperty: "error" })
    const model = role.model_provider && role.model ? `${role.model_provider}/${role.model}` : role.model
    const agent = yield* Schema.decodeUnknownEffect(ConfigAgent.Info)(
      Object.fromEntries(
        Object.entries({
          model,
          variant: role.model_reasoning_effort,
          description: role.description,
          system: `${SessionSystemPrompt.make()}\n\n<assignment>\n${role.developer_instructions}\n</assignment>`,
          mode: role.mode ?? "subagent",
          steps: role.steps,
          disabled: role.disabled,
          permissions: role.permissions,
        }).filter(([, value]) => value !== undefined),
      ),
    )
    return new Document({
      type: "document",
      path: AbsolutePath.make(file),
      info: Info.make({ agents: { [role.name]: agent } }),
    })
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("ignored invalid agent role file", { path: file, error }).pipe(Effect.as(undefined)),
    ),
  )
})
