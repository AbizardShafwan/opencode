import { Effect } from "effect"
import { LLMRequest, ProviderID, type LLMEvent, type ToolDefinition } from "../schema/index.js"
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
const CLAUDE_CODE_VERSION = "2.1.75"
const OAUTH_BETA = "oauth-2025-04-20"
const CLAUDE_CODE_BETA = "claude-code-20250219"

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

type ToolNames = {
  /** Lowercased request name → canonical wire name. */
  readonly toWire: ReadonlyMap<string, string>
  /** Lowercased canonical wire name → request name. */
  readonly fromWire: ReadonlyMap<string, string>
}

/**
 * Build a reversible name map for one request. A canonical name is only used
 * when exactly one offered tool claims it, so two tools differing only by case
 * cannot be silently dispatched to each other.
 */
export function toolNames(request: LLMRequest): ToolNames {
  const tools: ReadonlyArray<ToolDefinition> = ProviderShared.flattenToolRequest(request).tools
  const claimed = new Map<string, number>()
  for (const tool of tools) {
    const canonical = CANONICAL_TOOL_NAMES.get(tool.name.toLowerCase())
    if (canonical) claimed.set(canonical, (claimed.get(canonical) ?? 0) + 1)
  }

  const toWire = new Map<string, string>()
  const fromWire = new Map<string, string>()
  for (const tool of tools) {
    const canonical = CANONICAL_TOOL_NAMES.get(tool.name.toLowerCase())
    if (!canonical || claimed.get(canonical) !== 1) continue
    toWire.set(tool.name.toLowerCase(), canonical)
    fromWire.set(canonical.toLowerCase(), tool.name)
  }
  return { toWire, fromWire }
}

const wireName = (name: string, names: ToolNames) => names.toWire.get(name.toLowerCase()) ?? name
const requestName = (name: string, names: ToolNames) => names.fromWire.get(name.toLowerCase()) ?? name

type Body = AnthropicMessages.AnthropicMessagesBody

function subscriptionBody(request: LLMRequest, body: Body): Body {
  const names = toolNames(request)
  const system = body.system ?? []
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
      "anthropic-beta": `${OAUTH_BETA},${CLAUDE_CODE_BETA}`,
      "x-app": "cli",
      "user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
      accept: "application/json",
    }),
    transport: AnthropicMessages.transport<AnthropicMessages.AnthropicMessagesBody>(),
  })
}

export * as AnthropicClaudeCode from "./anthropic-claude-code.js"
