import { isAbsolute, resolve } from "node:path"
import type { ToolCall, ToolCallContent, ToolCallLocation, ToolCallUpdate, ToolKind } from "@agentclientprotocol/sdk"
import type { Tool } from "@opencode/schema/tool"
import { readDisplayText } from "@opencode/tui/mini/tool"
import { Patch } from "@opencode/util/patch"
import { Result } from "effect"

export type ToolInput = Record<string, unknown>

export type DiffSource = {
  readonly toolName: string
  readonly input: ToolInput
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** The reserved namespace prefixes the verified T3 Code host advertises its tools under. */
const HOST_TOOL_PREFIX = "t3-code_"
const PER_THREAD_HOST_PREFIX = "t3-code-"

const HOST_TOOL_KINDS = new Map<string, ToolKind>([
  ["shell", "execute"],
  ["ci_rerun", "execute"],
  // Browser work drives pages and runs scripts, so ACP treats it like running code.
  ["preview_act", "execute"],
  ["preview_close", "execute"],
  ["preview_dialog", "execute"],
  ["preview_evaluate", "execute"],
  ["preview_navigate", "execute"],
  ["preview_open", "execute"],
  ["preview_recording_start", "execute"],
  ["preview_recording_stop", "execute"],
  ["preview_resize", "execute"],
  ["preview_set_appearance", "execute"],
  ["device_open", "execute"],
  ["device_close", "execute"],
  // Agent-thread control changes another thread's work rather than reading it.
  ["send_message", "execute"],
  ["followup_task", "execute"],
  ["interrupt_agent", "execute"],
  ["close_agent", "execute"],
  ["task_cancel", "execute"],
  ["t3_thread_launch", "execute"],
  ["t3_thread_send", "execute"],
  ["t3_thread_queue", "execute"],
  ["t3_thread_interrupt", "execute"],
  ["t3_thread_organize", "execute"],
  ["t3_thread_rename", "execute"],
  ["t3_thread_update", "execute"],
  ["t3_thread_transfer", "execute"],
  ["t3_worktree_create", "execute"],
  ["t3_worktree_remove", "execute"],
  ["t3_worktree_handoff", "execute"],
  ["t3_worktree_sync", "execute"],
  ["t3_environment_link", "execute"],
  ["t3_environment_unlink", "execute"],
  ["pull_request_merge", "execute"],
  ["create_issue", "edit"],
  ["comment_on_issue", "edit"],
  ["pull_request_create", "edit"],
  ["pull_request_update", "edit"],
  ["pull_request_review", "edit"],
  ["pull_request_respond", "edit"],
  ["list_issues", "search"],
  ["pull_request_list", "search"],
  ["list_thread_issues", "search"],
  ["list_thread_pull_requests", "search"],
  ["list_scheduled_tasks", "search"],
  ["list_agents", "search"],
  ["t3_project_list", "search"],
  ["t3_preview_list", "search"],
  ["t3_thread_list", "search"],
  ["t3_thread_search", "search"],
  ["device_list", "search"],
  ["t3_worktree_list", "search"],
  ["t3_worktree_status", "search"],
  ["t3_environment_links", "search"],
  ["orchestrator_capabilities", "search"],
  ["pull_request_read", "read"],
  ["read_issue", "read"],
  ["read_pull_request_guide", "read"],
  ["ci_logs", "read"],
  ["t3_project_read", "read"],
  ["t3_theme_read", "read"],
  ["t3_thread_read", "read"],
  ["t3_environment_read", "read"],
  ["device_screenshot", "read"],
  ["html_preview", "read"],
  ["preview_snapshot", "read"],
  ["preview_status", "read"],
  ["preview_wait_for", "read"],
  ["task_status", "read"],
  ["delegate_task", "think"],
  ["request_secret", "other"],
  ["html_render", "other"],
  ["t3_background_wait", "other"],
  ["t3_thread_wait", "other"],
  ["t3_submit_output", "other"],
  ["send_to_user", "other"],
])

// Check longest known host tool suffixes first so `<tool>` names containing `_` win over shorter matches.
const HOST_TOOL_SUFFIXES = Array.from(HOST_TOOL_KINDS.entries()).toSorted(
  ([left], [right]) => right.length - left.length,
)

const LOCAL_TOOL_KINDS = new Map<string, ToolKind>([
  ["execute", "execute"],
  ["webfetch", "fetch"],
  ["edit", "edit"],
  ["patch", "edit"],
  ["write", "edit"],
  ["grep", "search"],
  ["glob", "search"],
  ["context", "search"],
  ["context7_resolve_library_id", "search"],
  ["context7_get_library_docs", "search"],
  ["read", "read"],
  ["subagent", "think"],
  ["spawn_agent", "think"],
  ["wait_agent", "other"],
])

/**
 * T3 Code host tools advertise under either `t3-code_<tool>` or per-thread `t3-code-<id>_<tool>`
 * (where `<id>` itself may contain underscores), while bare names appear when called directly.
 * Untrusted demoted `mcp_t3-code-*` names must never be resolved as host tools.
 */
export function toToolKind(toolName: string): ToolKind {
  const name = canonicalName(toolName)
  if (name.startsWith("mcp_")) return "other"
  if (name.startsWith(HOST_TOOL_PREFIX)) return HOST_TOOL_KINDS.get(name.slice(HOST_TOOL_PREFIX.length)) ?? "other"
  if (name.startsWith(PER_THREAD_HOST_PREFIX)) {
    const remainder = name.slice(PER_THREAD_HOST_PREFIX.length)
    const matched = HOST_TOOL_SUFFIXES.find(
      ([tool]) => remainder.endsWith(`_${tool}`) && remainder.length > tool.length + 1,
    )
    return matched?.[1] ?? "other"
  }
  return HOST_TOOL_KINDS.get(name) ?? LOCAL_TOOL_KINDS.get(name) ?? "other"
}

export function toLocations(toolName: string, input: ToolInput, cwd: string): ToolCallLocation[] {
  switch (canonicalName(toolName)) {
    case "shell":
      return locationFrom(cwd, stringValue(input.workdir) ?? stringValue(input.cwd) ?? cwd)
    case "read":
    case "edit":
    case "write":
      return locationFrom(cwd, filePath(input))
    case "patch":
      return locationFrom(
        cwd,
        ...patchHunks(input).flatMap((hunk) => [hunk.path, hunk.type === "update" ? hunk.movePath : undefined]),
      )
    case "external_directory":
      return locationFrom(cwd, input.filepath)
    case "grep":
    case "glob":
    case "context":
    case "context7_resolve_library_id":
    case "context7_get_library_docs":
      return locationFrom(cwd, input.path)
    default:
      return []
  }
}

export function pendingToolCall(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly state: { readonly input: ToolInput; readonly title?: string }
  readonly cwd: string
}): ToolCall {
  return {
    toolCallId: input.toolCallId,
    name: input.toolName,
    title: toolTitle(input.toolName, input.state.input, input.state.title),
    kind: toToolKind(input.toolName),
    status: "pending",
    locations: toLocations(input.toolName, input.state.input, input.cwd),
    rawInput: rawInput(input.toolName, input.state.input, input.cwd),
  }
}

export function runningToolUpdate(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly state: { readonly input: ToolInput }
  readonly cwd: string
}): ToolCallUpdate {
  return {
    toolCallId: input.toolCallId,
    status: "in_progress",
    kind: toToolKind(input.toolName),
    title: toolTitle(input.toolName, input.state.input),
    locations: toLocations(input.toolName, input.state.input, input.cwd),
    rawInput: rawInput(input.toolName, input.state.input, input.cwd),
  }
}

export function completedToolUpdate(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: ToolInput
  readonly content: ReadonlyArray<Tool.Content>
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly cwd: string
}): ToolCallUpdate {
  const normalized = toolContent(input.content)
  const firstText = input.content.find((part) => part.type === "text")
  const read = canonicalName(input.toolName) === "read" && firstText ? readDisplayText(firstText.text) : undefined
  const images = normalized.filter((part) => part.type === "content" && part.content.type === "image")
  const primary =
    read === undefined
      ? normalized.filter((part) => !images.includes(part))
      : [{ type: "content" as const, content: { type: "text" as const, text: read } }]
  return {
    toolCallId: input.toolCallId,
    status: "completed",
    locations: toLocations(input.toolName, input.input, input.cwd),
    content: [...primary, ...images],
    rawOutput: {
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
  }
}

export function errorToolUpdate(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: ToolInput
  readonly content?: ReadonlyArray<Tool.Content>
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly error: string
  readonly cwd: string
}): ToolCallUpdate {
  return {
    toolCallId: input.toolCallId,
    status: "failed",
    kind: toToolKind(input.toolName),
    title: toolTitle(input.toolName, input.input),
    locations: toLocations(input.toolName, input.input, input.cwd),
    rawInput: rawInput(input.toolName, input.input, input.cwd),
    content: [...toolContent(input.content ?? []), { type: "content", content: { type: "text", text: input.error } }],
    rawOutput: {
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      error: input.error,
    },
  }
}

function toolContent(content: ReadonlyArray<Tool.Content>): ToolCallContent[] {
  return content.flatMap((part): ToolCallContent[] => {
    if (part.type === "text") return [{ type: "content", content: { type: "text", text: part.text } }]
    const match = /^data:([^;,]+)(?:;[^,]*)*;base64,(.*)$/.exec(part.uri)
    if (!match?.[1]?.startsWith("image/") || match[2] === undefined) return []
    return [{ type: "content", content: { type: "image", mimeType: match[1], data: match[2] } }]
  })
}

function toolTitle(toolName: string, input: ToolInput, fallback?: string) {
  if (isShell(toolName)) return stringValue(input.command) ?? stringValue(input.cmd) ?? fallback ?? toolName
  return fallback || toolName
}

function rawInput(toolName: string, input: ToolInput, cwd: string): ToolInput {
  if (!isShell(toolName) || input.cwd || input.workdir) return input
  return { ...input, cwd }
}

function isShell(toolName: string) {
  return canonicalName(toolName) === "shell"
}

function locationFrom(cwd: string, ...values: unknown[]): ToolCallLocation[] {
  return Array.from(
    new Set(values.flatMap((value) => (typeof value === "string" && value ? [absolutePath(value, cwd)] : []))),
    (path) => ({ path }),
  )
}

const V1Aliases = new Map([
  ["bash", "shell"],
  ["task", "subagent"],
  ["apply_patch", "patch"],
])

export function canonicalName(toolName: string) {
  const name = toolName.toLocaleLowerCase()
  return V1Aliases.get(name) ?? name
}

// Sessions migrated from V1 keep their original `filePath` tool inputs.
export function filePath(input: ToolInput) {
  return stringValue(input.path) ?? stringValue(input.filePath)
}

export function patchHunks(input: ToolInput) {
  const patchText = stringValue(input.patchText)
  if (!patchText) return []
  const parsed = Patch.parse(patchText)
  return Result.isSuccess(parsed) ? parsed.success : []
}

export function absolutePath(path: string, cwd: string) {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

export function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}
