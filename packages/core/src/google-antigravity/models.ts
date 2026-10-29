export * as GoogleAntigravityModels from "./models.js"

import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Variant } from "../variant.js"
import { Schema } from "effect"
import { publicModelID, runtimeModel, type PublicModelID } from "./client.js"

export const AvailableModels = Schema.Struct({
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      displayName: Schema.optional(Schema.String),
      label: Schema.optional(Schema.String),
      modelName: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      isInternal: Schema.optional(Schema.Boolean),
      supportsImages: Schema.optional(Schema.Boolean),
      supportsThinking: Schema.optional(Schema.Boolean),
    }),
  ),
})

type Entry = {
  readonly id: PublicModelID
  readonly base?: string
  readonly name?: string
  readonly context: number
  readonly output: number
  readonly input: readonly string[]
  readonly efforts: readonly string[]
}

const catalog: readonly Entry[] = [
  {
    id: "gemini-3.8-flash",
    context: 1_048_576,
    output: 65_536,
    input: ["text", "image"],
    efforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.7-flash",
    context: 1_048_576,
    output: 65_536,
    input: ["text", "image"],
    efforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.6-flash",
    context: 1_048_576,
    output: 65_536,
    input: ["text", "image"],
    efforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.5-flash",
    context: 1_048_576,
    output: 65_536,
    input: ["text", "image"],
    efforts: ["minimal", "low", "medium", "high"],
  },
  {
    id: "gemini-3.1-pro",
    base: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro (Antigravity)",
    context: 1_048_576,
    output: 65_535,
    input: ["text", "image"],
    efforts: ["low", "high"],
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Antigravity)",
    context: 200_000,
    output: 64_000,
    input: ["text", "image"],
    efforts: ["high"],
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6 (Antigravity)",
    context: 250_000,
    output: 64_000,
    input: ["text", "image"],
    efforts: ["high"],
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B (Antigravity)",
    context: 131_072,
    output: 32_768,
    input: ["text"],
    efforts: ["medium"],
  },
]

export function supportedInventory(available: typeof AvailableModels.Type): typeof AvailableModels.Type {
  // The Gemini text/tool transport cannot serve tab completion or image generation.
  return {
    models: Object.fromEntries(
      Object.entries(available.models).filter(
        ([id, remote]) =>
          /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) &&
          !/^(chat_|tab_|MODEL_)/i.test(id) &&
          !/image/i.test(id) &&
          !remote.isInternal,
      ),
    ),
  }
}

/**
 * Availability owns membership and runtime IDs. The local catalog is only a
 * metadata fallback, never a list of models assumed accessible to an account.
 */
export function models(source: ReadonlyMap<string, Model.Info>, available: typeof AvailableModels.Type): Model.Info[] {
  const groups = Map.groupBy(Object.entries(available.models), ([id]) => publicModelID(id))
  return Array.from(groups, ([id, runtimes]) => {
    const remote = runtimes.find(([runtime]) => runtime === runtimeModel(id, undefined))?.[1] ?? runtimes[0]![1]
    const entry = catalog.find((entry) => entry.id === id)
    const template = source.get(id) ?? (entry && source.get(entry.base ?? entry.id))
    const base = template ?? (entry ? synthetic(entry) : Model.Info.default(Provider.ID.google, Model.ID.make(id)))
    const model: Model.Info = {
      ...base,
      id: Model.ID.make(id),
      modelID: Model.ID.make(id),
      name: remote.displayName || remote.label || remote.modelName || entry?.name || base.name,
      package: "@opencode/ai/providers/google",
      enabled: true,
      capabilities: {
        ...base.capabilities,
        input:
          remote.supportsImages === undefined
            ? (template?.capabilities.input ?? entry?.input ?? ["text"])
            : remote.supportsImages
              ? ["text", "image"]
              : ["text"],
      },
      variants: [],
    }
    const efforts =
      remote.supportsThinking === false
        ? []
        : entry
          ? entry.efforts.filter((effort) =>
              runtimes.some(([runtime]) => runtimeModel(entry.id, { thinkingLevel: effort }) === runtime),
            )
          : remote.supportsThinking
            ? ["high"]
            : []
    return { ...model, variants: Variant.resolve(model, [{ type: "effort", values: [...efforts] }]) }
  })
}

function synthetic(entry: Entry): Model.Info {
  const base: Model.Info = {
    id: Model.ID.make(entry.id),
    modelID: Model.ID.make(entry.id),
    providerID: Provider.ID.google,
    name: entry.name ?? entry.id,
    package: "@opencode/ai/providers/google",
    capabilities: {
      tools: true,
      input: [...entry.input],
      output: ["text"],
      temperature: true,
    },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: entry.context, output: entry.output },
  }
  return {
    ...base,
    variants: Variant.resolve(base, [{ type: "effort", values: [...entry.efforts] }]),
  }
}
