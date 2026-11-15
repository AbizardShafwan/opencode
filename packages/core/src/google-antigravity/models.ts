export * as GoogleAntigravityModels from "./models.js"

import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Variant } from "../variant.js"
import { Schema } from "effect"
import {
  EFFORT_ORDER,
  isRoutedModel,
  publicModelID,
  resolveRuntime,
  runtimeForEffort,
  type PublicModelID,
} from "./client.js"

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

type RemoteModel = (typeof AvailableModels.Type)["models"][string]

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
    id: "gemini-4-argon",
    name: "Gemini 4 Argon",
    context: 1_048_576,
    output: 32_768,
    input: ["text", "image"],
    efforts: ["low", "medium", "high"],
  },
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
    id: "claude-sonnet-5-5",
    base: "claude-sonnet-5-5@default",
    name: "Claude Sonnet 5.5",
    context: 200_000,
    output: 64_000,
    input: ["text", "image"],
    efforts: ["low", "medium", "high"],
  },
  {
    id: "claude-opus-5-5",
    base: "claude-opus-5-5@default",
    name: "Claude Opus 5.5",
    context: 250_000,
    output: 64_000,
    input: ["text", "image"],
    efforts: ["low", "medium", "high"],
  },
  {
    id: "claude-sonnet-4-6",
    base: "claude-sonnet-4-6@default",
    name: "Claude Sonnet 4.6 (Antigravity)",
    context: 200_000,
    output: 64_000,
    input: ["text", "image"],
    efforts: ["high"],
  },
  {
    id: "claude-opus-4-6",
    base: "claude-opus-4-6@default",
    name: "Claude Opus 4.6 (Antigravity)",
    context: 250_000,
    output: 64_000,
    input: ["text", "image"],
    efforts: ["high"],
  },
  {
    id: "gpt-oss-120b",
    base: "openai/gpt-oss-120b-maas",
    name: "GPT-OSS 120B (Antigravity)",
    context: 131_072,
    output: 32_768,
    input: ["text"],
    efforts: ["medium"],
  },
]

const DISPLAY_SUFFIX = /\s*\((?:extra[- ]low|minimal|low|medium|high|tiered|thinking)\)\s*$/i

function familyName(value: string | undefined): string | undefined {
  const trimmed = value?.replace(DISPLAY_SUFFIX, "").trim()
  return trimmed || undefined
}

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
export function models(
  source: ReadonlyMap<string, Model.Info> | ReadonlyArray<ReadonlyMap<string, Model.Info> | undefined>,
  available: typeof AvailableModels.Type,
): Model.Info[] {
  const sources: ReadonlyArray<ReadonlyMap<string, Model.Info>> = (
    Array.isArray(source) ? source : [source]
  ).filter((s): s is ReadonlyMap<string, Model.Info> => s !== undefined)
  const lookup = (key: string): Model.Info | undefined => {
    for (const src of sources) {
      const found = src.get(key) ?? src.get(`${key}@default`)
      if (found) return found
    }
    return undefined
  }
  const groups = Map.groupBy(Object.entries(available.models), ([id]) => publicModelID(id))
  return Array.from(groups, ([id, runtimes]) => {
    const defaultRuntime = resolveRuntime(id, undefined, Object.fromEntries(runtimes))
    const remote = runtimes.find(([runtime]) => runtime === defaultRuntime)?.[1] ?? runtimes[0]![1]
    const entry = catalog.find((entry) => entry.id === id)
    const template = lookup(id) ?? (entry?.base ? lookup(entry.base) : undefined)
    const base = template ?? (entry ? synthetic(entry) : Model.Info.default(Provider.ID.google, Model.ID.make(id)))
    const model: Model.Info = {
      ...base,
      id: Model.ID.make(id),
      modelID: Model.ID.make(id),
      name:
        familyName(remote.displayName) ||
        familyName(remote.label) ||
        familyName(remote.modelName) ||
        entry?.name ||
        base.name,
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
    const efforts = effortsFor(id, entry, remote, runtimes)
    return { ...model, variants: Variant.resolve(model, [{ type: "effort", values: [...efforts] }]) }
  })
}

function effortsFor(
  id: string,
  entry: Entry | undefined,
  remote: RemoteModel,
  runtimes: ReadonlyArray<readonly [string, RemoteModel]>,
): readonly string[] {
  if (runtimes.every(([, item]) => item.supportsThinking === false)) return []
  const allowed = isRoutedModel(id) && entry ? entry.efforts : EFFORT_ORDER
  const discovered = EFFORT_ORDER.filter(
    (effort) =>
      allowed.includes(effort) &&
      runtimes.some(
        ([runtime, item]) => item.supportsThinking !== false && runtimeForEffort(id, effort).includes(runtime),
      ),
  )
  if (discovered.length > 0 || isRoutedModel(id)) return discovered
  if (entry) return entry.efforts
  if (runtimes.some(([runtime]) => /-tiered$/i.test(runtime))) return ["low", "medium", "high"]
  if (
    remote.supportsThinking ||
    runtimes.some(([runtime, item]) => item.supportsThinking || /-thinking$/i.test(runtime))
  )
    return ["high"]
  return []
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
