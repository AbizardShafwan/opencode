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
})
