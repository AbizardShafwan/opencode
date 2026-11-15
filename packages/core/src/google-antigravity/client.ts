/**
 * Google Antigravity / Cloud Code Assist wire support.
 *
 * This is an unofficial integration built from the behaviour of the
 * `pi-antigravity` and `@rahularya01/opencode-antigravity` packages. It uses
 * Google's public Antigravity desktop OAuth client and the Cloud Code Assist
 * endpoints those packages target. Set ANTIGRAVITY_CLIENT_ID and
 * ANTIGRAVITY_CLIENT_SECRET to use an OAuth client you control.
 */
import { createHash } from "node:crypto"
import { isRecord } from "@opencode/ai/utils/record"

export const DEFAULT_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"

export const DEFAULT_CLIENT_SECRET = "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"

export function clientID(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTIGRAVITY_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID
}

export function clientSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTIGRAVITY_CLIENT_SECRET?.trim() || DEFAULT_CLIENT_SECRET
}

export const CLIENT_ID = clientID()

export const CLIENT_SECRET = clientSecret()

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
export const TOKEN_URL = "https://oauth2.googleapis.com/token"
export const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json"
export const ENDPOINT = "https://daily-cloudcode-pa.googleapis.com"
export const CALLBACK_PORT = 51121
export const CALLBACK_PATH = "/oauth-callback"
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`
export const METHOD_ID = "antigravity"

export const SCOPES = [
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
]

/** Matches the current official Antigravity CLI fingerprint used by the reference packages. */
export const USER_AGENT =
  "antigravity/cli/1.4.0 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)"

export type Thinking = {
  readonly includeThoughts?: boolean
  readonly thinkingBudget?: number
  readonly thinkingLevel?: string
}

type Json = Record<string, unknown>

export const EFFORT_ORDER = ["minimal", "low", "medium", "high"] as const

export type PublicModelID =
  | "gemini-4-argon"
  | "gemini-3.8-flash"
  | "gemini-3.7-flash"
  | "gemini-3.6-flash"
  | "gemini-3.5-flash"
  | "gemini-3.1-pro"
  | "claude-sonnet-5-5"
  | "claude-opus-5-5"
  | "claude-sonnet-4-6"
  | "claude-opus-4-6"
  | "gpt-oss-120b"

/** Public IDs whose Antigravity runtime ID changes with the selected thinking effort. */
const ROUTED: Readonly<Record<string, Partial<Record<string, string>>>> = {
  "gemini-3.6-flash": {
    low: "gemini-3.6-flash-low",
    minimal: "gemini-3.6-flash-low",
    medium: "gemini-3.6-flash-medium",
    high: "gemini-3.6-flash-high",
  },
  "gemini-3.5-flash": {
    low: "gemini-3.5-flash-extra-low",
    minimal: "gemini-3.5-flash-extra-low",
    "extra-low": "gemini-3.5-flash-extra-low",
    medium: "gemini-3.5-flash-low",
    high: "gemini-3-flash-agent",
  },
  "gemini-3.1-pro": {
    low: "gemini-3.1-pro-low",
    minimal: "gemini-3.1-pro-low",
    medium: "gemini-3.1-pro-low",
    high: "gemini-pro-agent",
  },
}

const FIXED: Readonly<Record<string, string>> = {
  "gemini-3.8-flash": "gemini-3.8-flash-tiered",
  "gemini-3.7-flash": "gemini-3.7-flash-tiered",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-opus-4-6": "claude-opus-4-6-thinking",
  "gpt-oss-120b": "gpt-oss-120b-medium",
}

const MODEL_ENUMS: Readonly<Record<string, string>> = {
  "gemini-3.8-flash": "MODEL_PLACEHOLDER_M318",
  "gemini-3.8-flash-tiered": "MODEL_PLACEHOLDER_M318",
  "gemini-3.7-flash": "MODEL_PLACEHOLDER_M298",
  "gemini-3.7-flash-tiered": "MODEL_PLACEHOLDER_M298",
  "gemini-3.6-flash": "MODEL_PLACEHOLDER_M71",
  "gemini-3.6-flash-low": "MODEL_PLACEHOLDER_M73",
  "gemini-3.6-flash-medium": "MODEL_PLACEHOLDER_M72",
  "gemini-3.6-flash-high": "MODEL_PLACEHOLDER_M71",
  "gemini-3.5-flash": "MODEL_PLACEHOLDER_M20",
  "gemini-3.5-flash-extra-low": "MODEL_PLACEHOLDER_M187",
  "gemini-3.5-flash-low": "MODEL_PLACEHOLDER_M20",
  "gemini-3-flash-agent": "MODEL_PLACEHOLDER_M84",
  "gemini-3.1-pro": "MODEL_PLACEHOLDER_M36",
  "gemini-3.1-pro-low": "MODEL_PLACEHOLDER_M36",
  "gemini-pro-agent": "MODEL_PLACEHOLDER_M16",
  "claude-sonnet-4-6": "MODEL_PLACEHOLDER_M35",
  "claude-opus-4-6": "MODEL_PLACEHOLDER_M26",
  "claude-opus-4-6-thinking": "MODEL_PLACEHOLDER_M26",
  "gpt-oss-120b": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
  "gpt-oss-120b-medium": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
}

function thinkingOf(body: Json): Thinking | undefined {
  const generation = isRecord(body.generationConfig) ? body.generationConfig : undefined
  const thinking = generation && isRecord(generation.thinkingConfig) ? generation.thinkingConfig : undefined
  if (!thinking) return undefined
  return {
    ...(typeof thinking.includeThoughts === "boolean" ? { includeThoughts: thinking.includeThoughts } : {}),
    ...(typeof thinking.thinkingBudget === "number" ? { thinkingBudget: thinking.thinkingBudget } : {}),
    ...(typeof thinking.thinkingLevel === "string" ? { thinkingLevel: thinking.thinkingLevel } : {}),
  }
}

function effortOf(thinking: Thinking | undefined) {
  if (!thinking) return undefined
  if (thinking.thinkingLevel) {
    const level = thinking.thinkingLevel.toLowerCase()
    return level === "none" ? "off" : level
  }
  if (thinking.includeThoughts === false) return "off"
  const budget = thinking.thinkingBudget
  if (budget === undefined) return undefined
  if (budget === 0) return "off"
  if (budget < 0) return "high"
  if (budget <= 1000) return "low"
  if (budget <= 4000) return "medium"
  return "high"
}

const RUNTIME_SUFFIX = /-(extra-low|minimal|low|medium|high|tiered|thinking)$/i
const EFFORT_SUFFIX = /-(extra-low|minimal|low|medium|high)$/i

export function isRoutedModel(modelID: string): boolean {
  return modelID in ROUTED
}

export function runtimeForEffort(modelID: string, effort: string): readonly string[] {
  const routed = ROUTED[modelID]
  if (routed) {
    const target = routed[effort]
    return target ? [target] : []
  }
  if (effort === "low") return [`${modelID}-low`, `${modelID}-extra-low`]
  return [`${modelID}-${effort}`]
}

function runtimeEffort(runtime: string): string | undefined {
  const suffix = EFFORT_SUFFIX.exec(runtime)?.[1]?.toLowerCase()
  if (suffix) return suffix === "extra-low" ? "low" : suffix
  for (const values of Object.values(ROUTED)) {
    for (const effort of ["high", "medium", "low", "minimal"] as const) {
      if (values[effort] === runtime) return effort
    }
  }
  return undefined
}

/** Resolve a public model ID to the runtime ID Cloud Code Assist expects. */
export function runtimeModel(modelID: string, thinking: Thinking | undefined): string {
  const fixed = FIXED[modelID]
  if (fixed) return fixed
  const effort = effortOf(thinking)
  const routed = ROUTED[modelID]
  if (routed) {
    const selected = effort ?? "high"
    return routed[selected] ?? routed.high ?? modelID
  }
  if (!effort || effort === "off") return modelID
  return `${modelID}-${effort}`
}

/** Resolve a public model ID against the active account's advertised runtime inventory. */
export function resolveRuntime(
  modelID: string,
  thinking: Thinking | undefined,
  available?: Readonly<Record<string, unknown>>,
): string {
  const preferred = runtimeModel(modelID, thinking)
  if (!available) return preferred
  const effort = effortOf(thinking)
  if (effort === "off") {
    for (const candidate of [modelID, preferred]) {
      if (available[candidate]) return candidate
    }
  }
  const target = effort && effort !== "off" ? effort : "high"
  const candidates = [
    ...runtimeForEffort(modelID, target),
    preferred,
    ...(FIXED[modelID] ? [FIXED[modelID]] : []),
    `${modelID}-tiered`,
    `${modelID}-thinking`,
    modelID,
    ...runtimeForEffort(modelID, "high"),
    ...runtimeForEffort(modelID, "medium"),
    ...runtimeForEffort(modelID, "low"),
    ...runtimeForEffort(modelID, "minimal"),
  ]
  for (const candidate of candidates) {
    if (available[candidate]) return candidate
  }
  return Object.keys(available).find((id) => publicModelID(id) === modelID) ?? preferred
}

/** Keep existing public IDs stable when availability advertises their runtime variants. */
export function publicModelID(runtime: string): string {
  return (
    Object.entries(FIXED).find(([, value]) => value === runtime)?.[0] ??
    Object.entries(ROUTED).find(([, values]) => Object.values(values).includes(runtime))?.[0] ??
    runtime.replace(RUNTIME_SUFFIX, "")
  )
}

/**
 * Cloud Code Assist models use explicit budgets rather than the public API's
 * `thinkingLevel`. Values mirror the reference Antigravity adapters.
 */
export function thinkingFor(
  runtime: string,
  thinking: Thinking | undefined,
  maxOutputTokens?: number,
): Thinking | undefined {
  const effort = effortOf(thinking) ?? runtimeEffort(runtime)
  if (thinking && (effort === "off" || thinking.includeThoughts === false))
    return { includeThoughts: false, thinkingBudget: 0 }

  const defaultBudget = defaultBudgetFor(runtime, effort, thinking)
  if (defaultBudget === undefined && thinking?.thinkingBudget === undefined)
    return thinking

  let budgetVal = thinking?.thinkingBudget !== undefined ? thinking.thinkingBudget : defaultBudget!

  // If incoming thinking already has a budget, don't exceed it
  if (thinking?.thinkingBudget !== undefined && budgetVal > 0) {
    budgetVal = Math.min(budgetVal, thinking.thinkingBudget)
  }

  // Clamp to maxOutputTokens if available and positive, ensuring room for answer tokens
  if (typeof maxOutputTokens === "number" && maxOutputTokens > 0 && budgetVal > 0) {
    if (maxOutputTokens <= 1) {
      return { includeThoughts: false, thinkingBudget: 0 }
    }
    const maxBudget = Math.min(maxOutputTokens - 1, Math.max(1, maxOutputTokens - 1024))
    budgetVal = Math.min(budgetVal, maxBudget)
  }

  return { includeThoughts: true, thinkingBudget: budgetVal }
}

function defaultBudgetFor(
  runtime: string,
  effort: string | undefined,
  thinking: Thinking | undefined,
): number | undefined {
  if (runtime.startsWith("claude-")) return 1024
  if (runtime.startsWith("gpt-oss-")) return 8192
  if (/^gemini-(?:4-|3\.(?:8|7|6)-flash)/.test(runtime)) return budget(effort, 4000, 1000, -1)
  if (runtime.startsWith("gemini-3.5-flash") || runtime === "gemini-3-flash-agent")
    return budget(effort, 4000, 1000, 10000)
  if (runtime.startsWith("gemini-3.1-pro") || runtime === "gemini-pro-agent")
    return budget(effort, 1001, 1001, 10001)
  if (runtime.startsWith("gemini-") && thinking?.thinkingLevel !== undefined)
    return budget(effort, 4000, 1000, -1)
  return undefined
}

function budget(effort: string | undefined, medium: number, low: number, high: number) {
  if (effort === "medium") return medium
  if (effort === "low" || effort === "minimal" || effort === "extra-low") return low
  return high
}

/** Lower JSON Schema tool declarations into the legacy shape Claude and GPT-OSS require. */
export function lowerTools(body: Json, runtime: string): Json {
  if (runtime.startsWith("gemini-")) return body
  if (!Array.isArray(body.tools)) return body
  return {
    ...body,
    tools: body.tools.map((tool) => {
      if (!isRecord(tool) || !Array.isArray(tool.functionDeclarations)) return tool
      return {
        ...tool,
        functionDeclarations: tool.functionDeclarations.map((declaration) => {
          if (!isRecord(declaration)) return declaration
          const { parametersJsonSchema, ...rest } = declaration
          if (!isRecord(parametersJsonSchema)) return rest
          return { ...rest, parameters: legacySchema(parametersJsonSchema, parametersJsonSchema) }
        }),
      }
    }),
  }
}

const LEGACY_SCHEMA_KEYS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
])

function resolveRef(ref: string, root: unknown): unknown {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined
  const parts = ref
    .slice(2)
    .split("/")
    .map((part) => decodeURIComponent(part.replace(/~1/g, "/").replace(/~0/g, "~")))
  let current: unknown = root
  for (const part of parts) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function dereference(branch: unknown, root: unknown): unknown {
  let current = branch
  const seen = new Set<string>()
  while (isRecord(current) && typeof current.$ref === "string") {
    if (seen.has(current.$ref)) break
    seen.add(current.$ref)
    const resolved = resolveRef(current.$ref, root)
    if (!isRecord(resolved)) break
    current = { ...resolved, ...(typeof current.description === "string" ? { description: current.description } : {}) }
  }
  return current
}

function isStringBranch(branch: unknown): boolean {
  if (!isRecord(branch)) return false
  if (typeof branch.const === "string") return true
  if (Array.isArray(branch.enum) && branch.enum.every((e) => typeof e === "string")) return true
  const type = Array.isArray(branch.type) ? branch.type.find((t) => t !== "null") : branch.type
  if (type === "string") return true
  return false
}

function mergePropertySchemas(existing: unknown, incoming: unknown): unknown {
  if (!isRecord(existing)) return incoming
  if (!isRecord(incoming)) return existing

  const result: Json = { ...existing }

  if (!result.description && typeof incoming.description === "string") {
    result.description = incoming.description
  }

  const existingType = typeof existing.type === "string" ? existing.type : undefined
  const incomingType = typeof incoming.type === "string" ? incoming.type : undefined

  const existingEnum = Array.isArray(existing.enum) ? existing.enum : undefined
  const incomingEnum = Array.isArray(incoming.enum) ? incoming.enum : undefined

  if (existingType === incomingType) {
    if (existingEnum && incomingEnum) {
      result.enum = Array.from(new Set([...existingEnum, ...incomingEnum]))
      if (!result.type) result.type = "string"
    } else if (existingEnum || incomingEnum) {
      delete result.enum
    }
  } else if (existingType && incomingType) {
    if (
      (existingType === "number" && incomingType === "integer") ||
      (existingType === "integer" && incomingType === "number")
    ) {
      result.type = "number"
      if (existingEnum && incomingEnum) {
        result.enum = Array.from(new Set([...existingEnum, ...incomingEnum]))
      } else {
        delete result.enum
      }
    } else {
      if (existingEnum && incomingEnum) {
        result.enum = Array.from(new Set([...existingEnum, ...incomingEnum]))
      } else {
        delete result.enum
      }
      result.type = existingType === "string" || incomingType === "string" ? "string" : existingType
    }
  } else if (!existingType && incomingType) {
    result.type = incomingType
    if (incomingEnum && !existingEnum) result.enum = incomingEnum
  }

  if (isRecord(existing.properties) && isRecord(incoming.properties)) {
    result.properties = mergeProperties(existing.properties, incoming.properties)
  } else if (isRecord(incoming.properties) && !result.properties) {
    result.properties = incoming.properties
  }

  const existingReq = Array.isArray(existing.required)
    ? existing.required.filter((x): x is string => typeof x === "string")
    : undefined
  const incomingReq = Array.isArray(incoming.required)
    ? incoming.required.filter((x): x is string => typeof x === "string")
    : undefined

  if (existingReq && incomingReq) {
    const intersection = existingReq.filter((name) => incomingReq.includes(name))
    if (intersection.length > 0) {
      result.required = intersection
    } else {
      delete result.required
    }
  } else {
    delete result.required
  }

  if (isRecord(existing.items) && isRecord(incoming.items)) {
    result.items = mergePropertySchemas(existing.items, incoming.items)
  } else if (incoming.items && !result.items) {
    result.items = incoming.items
  }

  return result
}

function mergeProperties(existing: Json, incoming: Json): Json {
  const merged: Json = { ...existing }
  for (const [name, incomingProp] of Object.entries(incoming)) {
    if (name in merged) {
      merged[name] = mergePropertySchemas(merged[name], incomingProp)
    } else {
      merged[name] = incomingProp
    }
  }
  return merged
}

export function legacySchema(schema: unknown, root: unknown = schema, seenRefs = new Set<string>()): unknown {
  if (Array.isArray(schema)) return schema.map((item) => legacySchema(item, root, seenRefs))
  if (!isRecord(schema)) return schema

  if (typeof schema.$ref === "string") {
    const ref = schema.$ref
    if (seenRefs.has(ref)) {
      return {
        type: "object",
        ...(typeof schema.description === "string" ? { description: schema.description } : {}),
      }
    }
    const resolved = resolveRef(ref, root)
    if (isRecord(resolved)) {
      seenRefs.add(ref)
      const res = legacySchema(
        {
          ...resolved,
          ...(typeof schema.description === "string" ? { description: schema.description } : {}),
        },
        root,
        seenRefs,
      )
      seenRefs.delete(ref)
      return res
    }
    return {
      type: "object",
      ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    }
  }

  const result: Json = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!LEGACY_SCHEMA_KEYS.has(key)) continue
    if (key === "type") {
      const type = Array.isArray(value) ? value.find((entry) => typeof entry === "string" && entry !== "null") : value
      if (typeof type === "string") result.type = type
      continue
    }
    if (key === "properties" && isRecord(value)) {
      result.properties = Object.fromEntries(
        Object.entries(value).map(([name, property]) => [name, legacySchema(property, root, seenRefs)]),
      )
      continue
    }
    if (key === "items") {
      result.items = legacySchema(value, root, seenRefs)
      continue
    }
    if (key === "enum" && Array.isArray(value) && !value.every((entry) => typeof entry === "string")) continue
    result[key] = legacySchema(value, root, seenRefs)
  }

  if (schema.const !== undefined && result.enum === undefined) {
    if (typeof schema.const === "string") {
      result.type = "string"
      result.enum = [schema.const]
    } else if (typeof schema.const === "boolean") {
      result.type = "boolean"
    } else if (typeof schema.const === "number") {
      result.type = Number.isInteger(schema.const) ? "integer" : "number"
    }
  }

  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined
  if (union) {
    const variants = union.filter((v) => isRecord(v) && v.type !== "null")
    const dereferencedVariants = variants.map((v) => dereference(v, root))
    const isAllStrings = variants.length > 0 && dereferencedVariants.every(isStringBranch)

    if (isAllStrings) {
      let hasUnconstrainedString = false
      const allEnums: string[] = []
      for (const branch of dereferencedVariants) {
        if (!isRecord(branch)) continue
        if (typeof branch.const === "string") {
          allEnums.push(branch.const)
        } else if (Array.isArray(branch.enum) && branch.enum.every((e) => typeof e === "string")) {
          allEnums.push(...branch.enum)
        } else {
          const type = Array.isArray(branch.type) ? branch.type.find((t) => t !== "null") : branch.type
          if (type === "string") {
            if (Array.isArray(branch.enum) && branch.enum.every((e) => typeof e === "string")) {
              allEnums.push(...branch.enum)
            } else if (typeof branch.const === "string") {
              allEnums.push(branch.const)
            } else {
              hasUnconstrainedString = true
            }
          }
        }
      }

      result.type = "string"
      if (hasUnconstrainedString) {
        delete result.enum
      } else {
        result.enum = Array.from(new Set(allEnums))
      }
    } else {
      const types = new Set<string>()
      for (const branch of dereferencedVariants) {
        if (!isRecord(branch)) continue
        if (typeof branch.type === "string" && branch.type !== "null") types.add(branch.type)
        else if (Array.isArray(branch.type)) {
          for (const t of branch.type) {
            if (typeof t === "string" && t !== "null") types.add(t)
          }
        } else if (typeof branch.const === "string" || branch.enum) types.add("string")
        else if (typeof branch.const === "number") types.add(Number.isInteger(branch.const) ? "integer" : "number")
        else if (typeof branch.const === "boolean") types.add("boolean")
        else if (isRecord(branch.properties)) types.add("object")
      }
      if (result.type === undefined && types.size > 0) {
        if (types.has("object")) result.type = "object"
        else if (types.has("array")) result.type = "array"
        else if (types.has("string")) result.type = "string"
        else if (types.has("number")) result.type = "number"
        else if (types.has("integer")) result.type = "integer"
        else result.type = [...types][0]
      }
      const arrayBranches = dereferencedVariants.filter(
        (branch): branch is Record<string, unknown> =>
          isRecord(branch) &&
          (branch.type === "array" ||
            (Array.isArray(branch.type) && branch.type.includes("array")) ||
            branch.items !== undefined),
      )
      if (arrayBranches.length > 0) {
        let mergedItems: unknown
        for (const branch of arrayBranches) {
          if (branch.items) {
            mergedItems = mergedItems ? mergePropertySchemas(mergedItems, branch.items) : branch.items
          }
        }
        result.items = mergedItems ? legacySchema(mergedItems, root, seenRefs) : { type: "string" }
      }
      let commonRequired: string[] | undefined = undefined
      for (const branch of variants) {
        if (!isRecord(branch)) continue
        const lowered = legacySchema(branch, root, seenRefs)
        if (isRecord(lowered)) {
          for (const [k, v] of Object.entries(lowered)) {
            if (k === "required") continue
            if (k === "items" && arrayBranches.length > 0) continue
            if (result[k] === undefined) {
              result[k] = v
            } else if (k === "properties" && isRecord(result.properties) && isRecord(v)) {
              result.properties = mergeProperties(result.properties, v)
            }
          }
          const branchReq = Array.isArray(lowered.required)
            ? lowered.required.filter((k): k is string => typeof k === "string")
            : []
          if (commonRequired === undefined) {
            commonRequired = [...branchReq]
          } else {
            commonRequired = commonRequired.filter((prop) => branchReq.includes(prop))
          }
        }
      }
      const parentRequired = Array.isArray(result.required)
        ? result.required.filter((k): k is string => typeof k === "string")
        : []
      const branchRequired = commonRequired ?? []
      const totalRequired = Array.from(new Set([...parentRequired, ...branchRequired]))
      if (totalRequired.length > 0) {
        result.required = totalRequired
      } else {
        delete result.required
      }
    }
  }

  return result
}

export interface WrapInput {
  readonly project: string
  readonly modelID: string
  readonly sessionID: string
  readonly availableModels?: Readonly<Record<string, { readonly model?: string }>>
}

/** Build the Cloud Code Assist request envelope around a Gemini generateContent body. */
export function wrapRequest(body: Json, input: WrapInput): Json {
  const thinking = thinkingOf(body)
  const available = input.availableModels
  const runtime = resolveRuntime(input.modelID, thinking, available)
  if (available && !available[runtime])
    throw new Error(`Google Antigravity model ${input.modelID} is not available for this account`)
  const generation = isRecord(body.generationConfig) ? body.generationConfig : undefined
  const request: Json = { ...body }

  if (isRecord(request.systemInstruction))
    request.systemInstruction = { ...request.systemInstruction, role: request.systemInstruction.role ?? "user" }

  const maxOutputTokens = typeof generation?.maxOutputTokens === "number" ? generation.maxOutputTokens : undefined
  const configured = thinkingFor(runtime, thinking, maxOutputTokens)
  if (generation || configured) {
    const next: Json = { ...(generation ?? {}) }
    if (configured) {
      let finalThinking = configured
      if (
        typeof maxOutputTokens === "number" &&
        maxOutputTokens > 0 &&
        typeof configured.thinkingBudget === "number" &&
        configured.thinkingBudget > 0
      ) {
        if (maxOutputTokens <= 1) {
          finalThinking = { ...configured, includeThoughts: false, thinkingBudget: 0 }
        } else if (configured.thinkingBudget >= maxOutputTokens) {
          finalThinking = {
            ...configured,
            thinkingBudget: Math.min(maxOutputTokens - 1, Math.max(1, maxOutputTokens - 1024)),
          }
        }
      }
      next.thinkingConfig = finalThinking
    } else delete next.thinkingConfig
    request.generationConfig = next
  }

  if (request.tools !== undefined) request.tools = lowerTools(request, runtime).tools

  const contents = Array.isArray(body.contents) ? body.contents : []
  const session = stableId(input.sessionID, "session")
  const trajectory = stableId(input.sessionID, "trajectory")
  const conversation = stableId(input.sessionID, "agent")
  const step = Math.max(1, contents.length)
  const claude = runtime.startsWith("claude-") || input.modelID.startsWith("claude-")
  const nonGemini = claude || runtime.startsWith("gpt-oss-") || input.modelID.startsWith("gpt-oss-")
  const modelEnum = available?.[runtime]?.model ?? MODEL_ENUMS[runtime] ?? MODEL_ENUMS[input.modelID]

  request.sessionId = session
  request.labels = {
    last_step_index: String(Math.max(0, contents.length - 1)),
    request_id: `${trajectory}-0`,
    trajectory_id: trajectory,
    used_claude: String(claude),
    used_claude_conservative: String(claude),
    used_non_gemini_model: String(nonGemini),
    ...(modelEnum ? { model_enum: modelEnum } : {}),
  }

  return {
    project: input.project,
    model: runtime,
    request,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: `agent/${conversation}/${Date.now()}/${trajectory}/${step}`,
  }
}

export function isAntigravityRequest(url: string): boolean {
  const parsed = URL.canParse(url) ? new URL(url) : undefined
  return (
    parsed?.hostname.endsWith(".googleapis.com") === true &&
    parsed.pathname === "/v1internal:streamGenerateContent"
  )
}

/** Cloud Code Assist wraps each Gemini stream event in `{ response: ... }`. */
export function unwrapSseLine(line: string): string {
  if (!line.startsWith("data:")) return line
  const payload = line.slice(5).trim()
  if (!payload || payload === "[DONE]") return line
  try {
    const parsed: unknown = JSON.parse(payload)
    if (isRecord(parsed) && parsed.error === undefined && isRecord(parsed.response))
      return `data: ${JSON.stringify(parsed.response)}`
  } catch {
    // Not JSON; pass the line through so the SSE parser can report it in context.
  }
  return line
}

export function unwrapSseEvent(block: string): string {
  if (!block.trim()) return block
  const lines = block.split(/(?:\r\n|\r|\n)/)
  const dataLines: string[] = []
  const otherLines: string[] = []

  for (const line of lines) {
    if (line.startsWith("data:")) {
      const rest = line.slice(5)
      dataLines.push(rest.startsWith(" ") ? rest.slice(1) : rest)
    } else {
      otherLines.push(line)
    }
  }

  if (dataLines.length === 0) return block
  const payload = dataLines.join("\n").trim()
  if (!payload || payload === "[DONE]") return block

  try {
    const parsed: unknown = JSON.parse(payload)
    if (isRecord(parsed) && parsed.error === undefined && isRecord(parsed.response)) {
      const unwrappedData = `data: ${JSON.stringify(parsed.response)}`
      return otherLines.length > 0 ? [...otherLines, unwrappedData].join("\n") : unwrappedData
    }
  } catch {
    // Not JSON; pass the block through so the SSE parser can report it in context.
  }
  return block
}

export const MAX_SSE_BUFFER = 2 * 1024 * 1024
export const SSE_EVENT_DELIMITER = /\r\n\r\n|\r\n\r|\r\n\n|\r\r\n|\r\r|\n\r\n|\n\r|\n\n/g

/** Streamingly unwrap Cloud Code Assist SSE frames into plain Gemini events. */
export function unwrapResponse(response: Response): Response {
  if (!response.body) return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffered = ""
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffered += decoder.decode(chunk, { stream: true })
        const boundaryRegex = new RegExp(SSE_EVENT_DELIMITER.source, "g")
        let lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = boundaryRegex.exec(buffered)) !== null) {
          const event = buffered.slice(lastIndex, match.index)
          const delimiter = match[0]
          controller.enqueue(encoder.encode(`${unwrapSseEvent(event)}${delimiter}`))
          lastIndex = match.index + match[0].length
        }
        buffered = buffered.slice(lastIndex)
        if (buffered.length > MAX_SSE_BUFFER) {
          controller.error(new Error("SSE stream exceeded maximum buffer limit of 2 MiB without event delimiter"))
        }
      },
      flush(controller) {
        buffered += decoder.decode()
        if (buffered.length > MAX_SSE_BUFFER) {
          controller.error(new Error("SSE stream exceeded maximum buffer limit of 2 MiB without event delimiter"))
          return
        }
        if (buffered) controller.enqueue(encoder.encode(unwrapSseEvent(buffered)))
      },
    }),
  )
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

/** Extract the Cloud Code Assist project from loadCodeAssist/loadCodeAssist-like payloads. */
export function projectIdFromPayload(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  for (const key of [
    "cloudaicompanionProject",
    "antigravityProjectId",
    "projectId",
    "backendProjectId",
    "userDefinedCloudaicompanionProject",
  ]) {
    const candidate = value[key]
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
    if (isRecord(candidate) && typeof candidate.id === "string" && candidate.id.trim()) return candidate.id.trim()
  }
  return undefined
}

/** Stable UUID from a seed; used for the fallback project id and request telemetry. */
export function stableId(seed: string, namespace: string): string {
  const bytes = Buffer.from(createHash("sha256").update(`${namespace}:${seed}`).digest().subarray(0, 16))
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Accept the full redirect URL (or a bare query string) from a remote browser. */
export function callbackCode(input: string, expectedState: string): string {
  const value = input.trim()
  if (!value) throw new Error("Paste the full redirect URL from your browser.")
  const url = URL.canParse(value)
    ? new URL(value)
    : new URL(`http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}?${value.replace(/^\?/, "")}`)
  if (URL.canParse(value) && !allowedCallback(url))
    throw new Error("Paste the redirect URL Memyr opened, including its code and state.")
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
  if (error) throw new Error(error)
  const code = url.searchParams.get("code")?.trim()
  const state = url.searchParams.get("state")?.trim()
  if (!code) throw new Error("The redirect URL has no authorization code.")
  if (!state) throw new Error("The redirect URL has no state. Copy the complete address from the browser.")
  if (state !== expectedState) throw new Error("OAuth state mismatch. Start the sign-in again.")
  return code
}

function allowedCallback(url: URL) {
  return (
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    url.port === String(CALLBACK_PORT) &&
    url.pathname === CALLBACK_PATH
  )
}
