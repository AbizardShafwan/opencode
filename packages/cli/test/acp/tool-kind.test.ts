import { expect, test } from "bun:test"
import { toToolKind } from "../../src/acp/tool"

test.each([
  // Local tools keep their V1 aliases.
  ["shell", "execute"],
  ["bash", "execute"],
  ["execute", "execute"],
  ["apply_patch", "edit"],
  ["read", "read"],
  ["grep", "search"],
  ["webfetch", "fetch"],
  ["subagent", "think"],
  // T3 Code host tools, prefixed and bare.
  ["t3-code_shell", "execute"],
  ["preview_act", "execute"],
  ["t3-code_preview_navigate", "execute"],
  ["preview_snapshot", "read"],
  ["t3-code_preview_status", "read"],
  ["device_screenshot", "read"],
  ["t3-code_device_list", "search"],
  ["device_open", "execute"],
  ["html_preview", "read"],
  ["t3-code_html_render", "other"],
  ["pull_request_read", "read"],
  ["t3-code_pull_request_list", "search"],
  ["pull_request_create", "edit"],
  ["pull_request_merge", "execute"],
  ["list_issues", "search"],
  ["read_issue", "read"],
  ["create_issue", "edit"],
  ["ci_logs", "read"],
  ["ci_rerun", "execute"],
  ["t3-code_ci_logs", "read"],
  ["t3_thread_read", "read"],
  ["t3-code_t3_thread_search", "search"],
  ["t3_thread_send", "execute"],
  ["delegate_task", "think"],
  ["request_secret", "other"],
  ["t3_worktree_status", "search"],
  ["t3-code_t3_worktree_handoff", "execute"],
  ["list_agents", "search"],
  ["followup_task", "execute"],
  ["unknown_tool", "other"],
])("maps %s to the ACP %s kind", (name, kind) => {
  expect(toToolKind(name)).toBe(kind as ReturnType<typeof toToolKind>)
})
