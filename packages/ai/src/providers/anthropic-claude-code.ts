import { Effect } from "effect"
import { LLMRequest, ProviderID, type LLMEvent } from "../schema/index.js"
import { AnthropicMessages } from "../protocols/anthropic-messages.js"
import * as ProviderShared from "../protocols/shared.js"
import { Auth } from "../route/auth.js"
import { Endpoint } from "../route/endpoint.js"
import { Protocol } from "../route/protocol.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"

export const id = ProviderID.make("anthropic")

/**
 * Claude Code identity used by the subscription OAuth flow. The provider bills a
 * request against the subscription only when it recognizes this envelope.
 */
export const SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

/** Compatibility values mirrored from the reference Claude Code client. */
const CLAUDE_CODE_VERSION = "2.1.295"
const OAUTH_BETA = "oauth-2025-04-20"
const CLAUDE_CODE_BETA = "claude-code-20250219"
const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14"

/**
 * Anthropic requires its first-party tool names in canonical casing on OAuth
 * requests. Matching is case-insensitive so ordinary lowercase OpenCode tool
 * names round-trip, while unknown tools are left untouched.
 */
const CLAUDE_CODE_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "KillShell",
  "NotebookEdit",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
] as const

const CANONICAL_TOOL_NAMES = new Map(CLAUDE_CODE_TOOL_NAMES.map((name) => [name.toLowerCase(), name]))
const MCP_ALIAS_PREFIX = "mcp__memyr__"
const MAX_TOOL_NAME_LENGTH = 128

type ToolNames = {
  /** Exact request name → wire name. */
  readonly toWire: ReadonlyMap<string, string>
  /** Lowercased wire name → request name. */
  readonly fromWire: ReadonlyMap<string, string>
}

/**
 * Build a reversible name map for one request. Claude Code tools keep their
 * canonical casing. Every other flat tool is advertised under an MCP-style
 * alias, the shape Anthropic accepts for third-party tool definitions on a
 * subscription connection. Names already using that shape pass through.
 */
export function toolNames(request: LLMRequest): ToolNames {
  const flattened = ProviderShared.flattenToolRequest(request)
  const names = new Set(flattened.tools.map((tool) => tool.name))
  for (const message of flattened.request.messages) {
    for (const part of message.content) {
      if (part.type === "tool-call" || part.type === "tool-result") names.add(part.name)
    }
  }
  if (request.toolChoice?.type === "tool" && request.toolChoice.name) names.add(request.toolChoice.name)

  const claimed = new Map<string, number>()
  for (const name of names) {
    const canonical = CANONICAL_TOOL_NAMES.get(name.toLowerCase())
    if (canonical) claimed.set(canonical, (claimed.get(canonical) ?? 0) + 1)
  }

  const toWire = new Map<string, string>()
  const fromWire = new Map<string, string>()
  const taken = new Set<string>()
  const ordered = Array.from(names).sort()
  for (const name of ordered) {
    const canonical = CANONICAL_TOOL_NAMES.get(name.toLowerCase())
    if (!canonical || claimed.get(canonical) !== 1) continue
    toWire.set(name, canonical)
    fromWire.set(canonical.toLowerCase(), name)
    taken.add(canonical.toLowerCase())
  }
  for (const name of ordered) {
    if (toWire.has(name)) continue
    const wire = validMCPName(name) && !taken.has(name.toLowerCase()) ? name : reserveAlias(name, taken)
    toWire.set(name, wire)
    fromWire.set(wire.toLowerCase(), name)
  }
  return { toWire, fromWire }
}

const validMCPName = (name: string) =>
  name.startsWith("mcp__") && name.length <= MAX_TOOL_NAME_LENGTH && /^[a-zA-Z0-9_-]+$/.test(name)

const sanitizeAlias = (name: string) => {
  const value = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return value || "tool"
}

const reserveAlias = (name: string, taken: Set<string>) => {
  const base = `${MCP_ALIAS_PREFIX}${sanitizeAlias(name)}`
  let candidate = base.slice(0, MAX_TOOL_NAME_LENGTH)
  let suffix = 2
  while (taken.has(candidate.toLowerCase())) {
    const ending = `_${suffix}`
    candidate = `${base.slice(0, MAX_TOOL_NAME_LENGTH - ending.length)}${ending}`
    suffix += 1
  }
  taken.add(candidate.toLowerCase())
  return candidate
}

const wireName = (name: string, names: ToolNames) => names.toWire.get(name) ?? name
const requestName = (name: string, names: ToolNames) => names.fromWire.get(name.toLowerCase()) ?? name

type Body = AnthropicMessages.AnthropicMessagesBody

function subscriptionBody(request: LLMRequest, body: Body): Body {
  const names = toolNames(request)
  const system = (body.system ?? []).map((block, index) =>
    index === 0 ? { ...block, text: block.text.replace(/^You are Memyr,/, "You are the CLI,") } : block,
  )
  const hasIdentity = system[0]?.text.trimStart().startsWith(SYSTEM_IDENTITY)
  return {
    ...body,
    system: hasIdentity ? system : [{ type: "text" as const, text: SYSTEM_IDENTITY }, ...system],
    tools: body.tools?.map((tool) => ({ ...tool, name: wireName(tool.name, names) })),
    tool_choice:
      body.tool_choice?.type === "tool"
        ? { ...body.tool_choice, name: wireName(body.tool_choice.name, names) }
        : body.tool_choice,
    messages: body.messages.map((message) =>
      message.role === "assistant"
        ? {
            ...message,
            content: message.content.map((block) =>
              block.type === "tool_use" ? { ...block, name: wireName(block.name, names) } : block,
            ),
          }
        : message,
    ),
  }
}

const restoreEventName = (event: LLMEvent, names: ToolNames): LLMEvent => {
  if (
    event.type !== "tool-input-start" &&
    event.type !== "tool-input-delta" &&
    event.type !== "tool-input-end" &&
    event.type !== "tool-input-error" &&
    event.type !== "tool-call" &&
    event.type !== "tool-result" &&
    event.type !== "tool-error"
  )
    return event
  const name = requestName(event.name, names)
  return name === event.name ? event : { ...event, name }
}

const protocol = Protocol.make({
  id: AnthropicMessages.protocol.id,
  body: {
    schema: AnthropicMessages.AnthropicMessagesBody,
    from: (request) =>
      AnthropicMessages.protocol.body.from(request).pipe(Effect.map((body) => subscriptionBody(request, body))),
  },
  stream: {
    event: AnthropicMessages.protocol.stream.event,
    initial: (request) => ({
      inner: AnthropicMessages.protocol.stream.initial(request),
      names: toolNames(request),
    }),
    step: (state, event) =>
      AnthropicMessages.protocol.stream
        .step(state.inner, event)
        .pipe(
          Effect.map(([inner, events]) => [
            { ...state, inner },
            events.map((emitted) => restoreEventName(emitted, state.names)),
          ]),
        ),
    terminal: AnthropicMessages.protocol.stream.terminal,
    onHalt: (state) => AnthropicMessages.protocol.stream.onHalt?.(state.inner) ?? Effect.succeed([]),
  },
  supportsSystemUpdates: AnthropicMessages.protocol.supportsSystemUpdates,
  supportsEffortUpdates: AnthropicMessages.protocol.supportsEffortUpdates,
  sanitizer: AnthropicMessages.protocol.sanitizer,
})

export type Input = RouteDefaultsInput & {
  readonly baseURL: string
  readonly authToken: string
}

/**
 * Route for a Claude Pro/Max subscription connection. Authentication is a bearer
 * token, and every request carries the Claude Code envelope the subscription
 * recognizes.
 */
export const route = (input: Input) => {
  const { baseURL, authToken, ...defaults } = input
  return Route.make({
    defaults,
    id: "anthropic-claude-code",
    provider: id,
    providerMetadataKey: "anthropic",
    protocol,
    endpoint: Endpoint.path(() => "/messages?beta=true", { baseURL }),
    auth: Auth.bearer(authToken),
    headers: () => ({
      "anthropic-version": "2023-06-01",
      "anthropic-beta": `${OAUTH_BETA},${CLAUDE_CODE_BETA},${FINE_GRAINED_TOOL_STREAMING_BETA}`,
      "x-app": "cli",
      "user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
      "anthropic-dangerous-direct-browser-access": "true",
      accept: "application/json",
    }),
    transport: AnthropicMessages.transport<AnthropicMessages.AnthropicMessagesBody>(),
  })
}

export * as AnthropicClaudeCode from "./anthropic-claude-code.js"
