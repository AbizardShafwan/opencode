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

/** The reserved namespace the verified T3 Code host advertises its tools under. */
const HOST_TOOL_PREFIX = "t3-code_"

/**
 * T3 Code host tools keep their advertised namespace, while bare names appear when a host tool is
 * called directly. Mapping both lets ACP clients show the right icon for either spelling.
 */
function hostToolName(toolName: string) {
  const name = canonicalName(toolName)
  return name.startsWith(HOST_TOOL_PREFIX) ? name.slice(HOST_TOOL_PREFIX.length) : name
}

export function toToolKind(toolName: string): ToolKind {
  switch (hostToolName(toolName)) {
    case "execute":
    case "shell":
    case "ci_rerun":
    // Browser work drives pages and runs scripts, so ACP treats it like running code.
    case "preview_act":
    case "preview_close":
    case "preview_dialog":
    case "preview_evaluate":
    case "preview_navigate":
    case "preview_open":
    case "preview_recording_start":
    case "preview_recording_stop":
    case "preview_resize":
    case "preview_set_appearance":
    case "preview_wait_for":
    case "device_open":
    case "device_close":
    // Agent-thread control changes another thread's work rather than reading it.
    case "send_message":
    case "followup_task":
    case "interrupt_agent":
    case "close_agent":
    case "task_cancel":
    case "t3_thread_launch":
    case "t3_thread_send":
    case "t3_thread_queue":
    case "t3_thread_interrupt":
    case "t3_thread_organize":
    case "t3_thread_rename":
    case "t3_thread_update":
    case "t3_thread_transfer":
    case "t3_worktree_create":
    case "t3_worktree_remove":
    case "t3_worktree_handoff":
    case "t3_worktree_sync":
    case "t3_environment_link":
    case "t3_environment_unlink":
    case "pull_request_merge":
      return "execute"
    case "webfetch":
      return "fetch"
    case "edit":
    case "patch":
    case "write":
    case "create_issue":
    case "comment_on_issue":
    case "pull_request_create":
    case "pull_request_update":
    case "pull_request_review":
    case "pull_request_respond":
      return "edit"
    case "grep":
    case "glob":
    case "context":
    case "context7_resolve_library_id":
    case "context7_get_library_docs":
    case "list_issues":
    case "pull_request_list":
    case "list_thread_issues":
    case "list_thread_pull_requests":
    case "list_scheduled_tasks":
    case "list_agents":
    case "t3_preview_list":
    case "t3_thread_list":
    case "t3_thread_search":
    case "device_list":
    case "t3_worktree_list":
    case "t3_worktree_status":
    case "t3_environment_links":
    case "orchestrator_capabilities":
      return "search"
    case "read":
    case "pull_request_read":
    case "read_issue":
    case "read_pull_request_guide":
    case "ci_logs":
    case "t3_thread_read":
    case "t3_environment_read":
    case "device_screenshot":
    case "html_preview":
    case "preview_snapshot":
    case "preview_status":
    case "task_status":
      return "read"
    case "subagent":
    case "spawn_agent":
    case "delegate_task":
      return "think"
    case "wait_agent":
    case "request_secret":
    case "html_render":
    case "t3_background_wait":
      return "other"
    default:
      return "other"
  }
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
