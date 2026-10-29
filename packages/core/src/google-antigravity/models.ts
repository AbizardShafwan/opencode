import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Variant } from "../variant.js"
import type { PublicModelID } from "./client.js"

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

/**
 * Build the Google provider's catalog while an Antigravity account is active.
 * Gemini entries keep the models.dev metadata and variants; Antigravity-only
 * models get a minimal native catalog entry.
 */
export function models(source: ReadonlyMap<string, Model.Info>): Model.Info[] {
  return catalog.map((entry) => {
    const base = source.get(entry.base ?? entry.id)
    if (base)
      return {
        ...base,
        id: Model.ID.make(entry.id),
        modelID: Model.ID.make(entry.id),
        name: entry.name ?? base.name,
        enabled: true,
      }
    return synthetic(entry)
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
