import { describe, expect, test } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { SubagentTool } from "@opencode/core/tool/plugin/subagent"

describe("subagent tool descriptions", () => {
  test("lists the available subagents without routing guidance", () => {
    const description = SubagentTool.describeSubagents({
      description: "Spawns an agent in a child session.",
      available: [
        { id: Agent.ID.make("reviewer"), description: "Reviews changes", model: undefined, variant: undefined },
        { id: Agent.ID.make("explore"), description: undefined, model: undefined, variant: undefined },
      ],
      hostDelegation: false,
    })

    expect(description).toContain("Available subagents:")
    expect(description).toContain("- reviewer: Reviews changes")
    expect(description).toContain("- explore: This subagent should only be called when explicitly requested.")
    expect(description).not.toContain("delegate_task")
  })

  test("explains the boundary when the host also offers delegate_task", () => {
    const description = SubagentTool.describeSubagents({
      description: "Spawns an agent in a child session.",
      available: [],
      hostDelegation: true,
    })

    // No agents is valid: the routing boundary still matters when the host tool is present.
    expect(description).not.toContain("Available subagents:")
    expect(description).toContain("in-process subagent")
    expect(description).toContain("delegate_task")
    expect(description).toContain('isolation: "worktree"')
  })

  test("recognizes verified host delegate_task variants including 63-char aliases and ignores untrusted spoofs", () => {
    expect(SubagentTool.isHostDelegateAction("t3-code_delegate_task")).toBe(true)
    expect(SubagentTool.isHostDelegateAction("t3-code-thread_subagent_0123456789abcdef_delegate_task")).toBe(true)
    expect(SubagentTool.isHostDelegateAction("t3-code-_delegate_task")).toBe(false)
    expect(SubagentTool.isHostDelegateAction("mcp_t3-code_delegate_task")).toBe(false)

    // Registered trusted long server ID aliased to `m_<16hex>_delegate_task`.
    const aliasedId = "m_0123456789abcdef_delegate_task"
    const trustedLong = new Map([
      [
        aliasedId,
        { options: { permission: "t3-code-thread_project_very_long_identifier_exceeding_63_chars_delegate_task" } },
      ],
    ])
    expect(SubagentTool.hasHostDelegation({ [aliasedId]: {} }, trustedLong)).toBe(true)

    // Untrusted server claiming `t3-code-*` is demoted to `mcp_*` permission and must be ignored.
    const demotedSpoof = new Map([
      ["t3-code-spoof_delegate_task", { options: { permission: "mcp_t3-code-spoof_delegate_task" } }],
      [aliasedId, { options: { permission: "mcp_t3-code-long_untrusted_server_name_delegate_task" } }],
    ])
    expect(SubagentTool.hasHostDelegation({ "t3-code-spoof_delegate_task": {} }, demotedSpoof)).toBe(false)
    expect(SubagentTool.hasHostDelegation({ [aliasedId]: {} }, demotedSpoof)).toBe(false)

    // Unrelated external MCP server exposing its own delegate_task must not trigger host routing.
    const unrelated = new Map([["external_delegate_task", { options: { permission: "external_delegate_task" } }]])
    expect(SubagentTool.hasHostDelegation({ external_delegate_task: {} }, unrelated)).toBe(false)

    // Fallback when tools map is checked directly without registered metadata.
    expect(
      SubagentTool.hasHostDelegation({ "t3-code-thread_subagent_0123456789abcdef_delegate_task": {} }),
    ).toBe(true)
    expect(SubagentTool.hasHostDelegation({ other_delegate_task: {} })).toBe(false)
    expect(SubagentTool.hasHostDelegation({ mcp_t3_code_delegate_task: {} })).toBe(false)
  })
})
