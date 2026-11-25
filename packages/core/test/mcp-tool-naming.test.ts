import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Mcp } from "@opencode/core/mcp/index"
import { McpTool } from "@opencode/core/tool/mcp"
import { MAX_DIRECT_TOOL_NAME_LENGTH, PROVIDER_SAFE_TOOL_NAME } from "@opencode/schema/tool"

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")
const uuidServer = "t3-code-12345678-1234-1234-1234-123456789012"

describe("McpTool.directName", () => {
  test("keeps provider-safe names unchanged", () => {
    expect(McpTool.directName(uuidServer, "preview_open")).toBe(`${uuidServer}_preview_open`)
    expect(McpTool.directName("github", "search")).toBe("github_search")
  })

  test("aliases names longer than 63 characters with a server digest", () => {
    const tool = "t3_environment_preferences_update"
    const alias = McpTool.directName(uuidServer, tool)
    expect(`${uuidServer}_${tool}`.length).toBeGreaterThan(MAX_DIRECT_TOOL_NAME_LENGTH)
    expect(alias).toBe(`m_${sha256(uuidServer).slice(0, 16)}_${tool}`)
    expect(alias).toMatch(PROVIDER_SAFE_TOOL_NAME)
  })

  test("keeps a 44-character tool name whole at exactly 63 characters", () => {
    const tool = "a".repeat(44)
    const alias = McpTool.directName(uuidServer, tool)
    expect(alias).toBe(`m_${sha256(uuidServer).slice(0, 16)}_${tool}`)
    expect(alias.length).toBe(MAX_DIRECT_TOOL_NAME_LENGTH)
  })

  test("truncates longer tool names with a tool digest at exactly 63 characters", () => {
    const tool = `${"b".repeat(40)}.extra-long/tool`
    const alias = McpTool.directName(uuidServer, tool)
    expect(alias).toBe(`m_${sha256(uuidServer).slice(0, 16)}_${"b".repeat(35)}_${sha256(tool).slice(0, 8)}`)
    expect(alias.length).toBe(MAX_DIRECT_TOOL_NAME_LENGTH)
    expect(alias).toMatch(PROVIDER_SAFE_TOOL_NAME)
    expect(McpTool.directName(uuidServer, tool)).toBe(alias)
    expect(McpTool.directName(uuidServer, `${"b".repeat(40)}.other-long/tool`)).not.toBe(alias)
  })

  test("aliases non-letter-initial names", () => {
    expect(McpTool.directName("1password", "list")).toBe(`m_${sha256("1password").slice(0, 16)}_list`)
    expect(McpTool.directName("_internal", "list")).toMatch(PROVIDER_SAFE_TOOL_NAME)
  })
})

describe("McpTool.permissionAction", () => {
  const tool = (server: string, extra: Partial<Mcp.Tool> = {}) => ({
    server: Mcp.ServerName.make(server),
    name: "preview_open",
    ...extra,
  })

  test("grants the host namespace only to verified host tools", () => {
    expect(McpTool.permissionAction(tool(uuidServer, { trustedHost: true, permissionNamespace: "t3-code" }))).toBe(
      "t3-code_preview_open",
    )
  })

  test("moves untrusted servers claiming the host name to an unprivileged prefix", () => {
    expect(McpTool.permissionAction(tool("t3-code"))).toBe("mcp_t3-code_preview_open")
    expect(McpTool.permissionAction(tool("T3-CODE"))).toBe("mcp_T3-CODE_preview_open")
    expect(McpTool.permissionAction(tool("T3-Code-abc"))).toBe("mcp_T3-Code-abc_preview_open")
    expect(McpTool.permissionAction(tool(uuidServer))).toBe(`mcp_${uuidServer}_preview_open`)
    expect(McpTool.permissionAction(tool("t3-code_x"))).toBe("mcp_t3-code_x_preview_open")
    // A namespace without the trusted flag is ignored.
    expect(McpTool.permissionAction(tool("t3-code", { permissionNamespace: "t3-code" }))).toBe(
      "mcp_t3-code_preview_open",
    )
  })

  test("keeps ordinary server actions unchanged", () => {
    expect(McpTool.permissionAction(tool("github"))).toBe("github_preview_open")
  })
})

describe("McpTool.isCodeMode", () => {
  test("never derives direct exposure from the server name", () => {
    expect(McpTool.isCodeMode({})).toBe(true)
    expect(McpTool.isCodeMode({ codemode: false })).toBe(false)
  })
})
