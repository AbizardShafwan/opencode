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

export const CLIENT_ID = process.env.ANTIGRAVITY_CLIENT_ID?.trim() ?? ""

export const CLIENT_SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET?.trim() ?? ""

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

export type PublicModelID =
  | "gemini-3.8-flash"
  | "gemini-3.7-flash"
  | "gemini-3.6-flash"
  | "gemini-3.5-flash"
  | "gemini-3.1-pro"
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

/** Resolve a public model ID to the runtime ID Cloud Code Assist expects. */
export function runtimeModel(modelID: string, thinking: Thinking | undefined): string {
  const fixed = FIXED[modelID]
  if (fixed) return fixed
  const routed = ROUTED[modelID]
  if (!routed) return modelID
  const effort = effortOf(thinking) ?? "high"
  return routed[effort] ?? routed.high ?? modelID
}

/**
 * Cloud Code Assist models use explicit budgets rather than the public API's
 * `thinkingLevel`. Values mirror the reference Antigravity adapters.
 */
export function thinkingFor(runtime: string, thinking: Thinking | undefined): Thinking | undefined {
  const effort = effortOf(thinking)
  if (thinking && (effort === "off" || thinking.includeThoughts === false))
    return { includeThoughts: false, thinkingBudget: 0 }
  if (runtime.startsWith("claude-")) return { includeThoughts: true, thinkingBudget: 1024 }
  if (runtime.startsWith("gpt-oss-")) return { includeThoughts: true, thinkingBudget: 8192 }
  if (/^gemini-3\.(8|7|6)-flash/.test(runtime))
    return { includeThoughts: true, thinkingBudget: budget(effort, 4000, 1000, -1) }
  if (runtime.startsWith("gemini-3.5-flash") || runtime === "gemini-3-flash-agent")
    return { includeThoughts: true, thinkingBudget: budget(effort, 4000, 1000, 10000) }
  if (runtime.startsWith("gemini-3.1-pro") || runtime === "gemini-pro-agent")
    return { includeThoughts: true, thinkingBudget: budget(effort, 1001, 1001, 10001) }
  return thinking
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
          return { ...rest, parameters: legacySchema(parametersJsonSchema) }
        }),
      }
    }),
  }
}

const LEGACY_SCHEMA_KEYS = new Set(["type", "description", "properties", "required", "items", "enum"])

function legacySchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(legacySchema)
  if (!isRecord(schema)) return schema
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
        Object.entries(value).map(([name, property]) => [name, legacySchema(property)]),
      )
      continue
    }
    if (key === "enum" && Array.isArray(value) && !value.every((entry) => typeof entry === "string")) continue
    result[key] = legacySchema(value)
  }
  return result
}

export interface WrapInput {
  readonly project: string
  readonly modelID: string
  readonly sessionID: string
}

/** Build the Cloud Code Assist request envelope around a Gemini generateContent body. */
export function wrapRequest(body: Json, input: WrapInput): Json {
  const thinking = thinkingOf(body)
  const runtime = runtimeModel(input.modelID, thinking)
  const generation = isRecord(body.generationConfig) ? body.generationConfig : undefined
  const request: Json = { ...body }

  if (isRecord(request.systemInstruction))
    request.systemInstruction = { ...request.systemInstruction, role: request.systemInstruction.role ?? "user" }

  const configured = thinkingFor(runtime, thinking)
  if (generation || configured) {
    const next: Json = { ...(generation ?? {}) }
    if (configured) next.thinkingConfig = configured
    else delete next.thinkingConfig
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
  const modelEnum = MODEL_ENUMS[runtime] ?? MODEL_ENUMS[input.modelID]

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
        const lines = buffered.split("\n")
        buffered = lines.pop() ?? ""
        for (const line of lines) controller.enqueue(encoder.encode(`${unwrapSseLine(line)}\n`))
      },
      flush(controller) {
        buffered += decoder.decode()
        if (buffered) controller.enqueue(encoder.encode(unwrapSseLine(buffered)))
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
