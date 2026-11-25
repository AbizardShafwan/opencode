import { expect } from "bun:test"
import { Config } from "@opencode/core/config"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { Permission } from "@opencode/core/permission"
import { Tool } from "@opencode/core/tool"
import { McpTool } from "@opencode/core/tool/mcp"
import { ToolOutput } from "@opencode/core/tool-output"
import { McpEvent } from "@opencode/schema/mcp-event"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Context, Effect, Layer, Logger } from "effect"
import { it } from "./lib/effect"

const directory = AbsolutePath.make("/tmp/opencode-mcp-flush-test")
const location = { directory, project: { id: Project.ID.make("proj_test"), directory, canonical: directory } }

const build = (tools: () => Effect.Effect<Mcp.Tool[]>) =>
  Effect.gen(function* () {
    const mcpLayer = Layer.succeed(Mcp.Service, Mcp.Service.of({ tools } as unknown as Mcp.Interface))
    const permissionLayer = Layer.succeed(Permission.Service, Permission.Service.of({} as Permission.Interface))
    const toolOutputLayer = Layer.succeed(ToolOutput.Service, ToolOutput.Service.of({} as ToolOutput.Interface))
    const services = yield* Layer.build(
      AppNodeBuilder.build(LayerNode.group([Tool.node, McpTool.node, Bus.node]), [
        Config.node.replace(Config.testLayer()),
        Location.node.replace(Layer.succeed(Location.Service, location)),
        Mcp.node.replace(mcpLayer),
        Permission.node.replace(permissionLayer),
        ToolOutput.node.replace(toolOutputLayer),
      ]),
    )
    return {
      bus: Context.get(services, Bus.Service),
      tools: Context.get(services, Tool.Service),
      mcpTool: Context.get(services, McpTool.Service),
    }
  })

const capture = (logs: string[]) =>
  Logger.layer([
    Logger.make((options) => {
      logs.push(String(Array.isArray(options.message) ? options.message[0] : options.message))
    }),
  ])

const hostServer = Mcp.ServerName.make("t3-code-12345678-1234-1234-1234-123456789012")
const host = { trustedHost: true, permissionNamespace: "t3-code", codemode: false } as const
const mcpTool = (server: Mcp.ServerName, name: string, extra: Partial<Mcp.Tool> = {}): Mcp.Tool => ({
  server,
  name,
  inputSchema: { type: "object", properties: {} },
  ...extra,
})

it.effect("McpTool.flush reconciles tools immediately after ToolsChanged without waiting for debounce", () =>
  Effect.gen(function* () {
    let catalog: Mcp.Tool[] = []
    const { bus, tools, mcpTool: service } = yield* build(() => Effect.sync(() => catalog))

    yield* service.flush
    expect((yield* tools.list()).map((tool) => tool.name)).toEqual([])

    const spoofed = Mcp.ServerName.make("t3-code")
    const otherDirectory = AbsolutePath.make("/tmp/opencode-other-location")
    catalog = [
      mcpTool(hostServer, "preview_open", host),
      mcpTool(hostServer, "t3_environment_preferences_update", host),
      mcpTool(spoofed, "steal"),
    ]
    // Cross-location ToolsChanged must be ignored.
    yield* bus.publish(McpEvent.ToolsChanged, { server: hostServer }, { location: { directory: otherDirectory } })
    yield* service.flush
    expect((yield* tools.list()).map((tool) => tool.name)).toEqual([])

    yield* bus.publish(McpEvent.ToolsChanged, { server: hostServer }, { location })
    // Synchronous bus.listen updates `seen` before bus.publish returns — no yieldNow or TestClock advance needed.
    yield* service.flush

    const listed = yield* tools.list()
    const open = listed.find((tool) => tool.name === "preview_open")
    expect(open?.id).toBe(`${hostServer}_preview_open`)
    expect(open?.options).toMatchObject({ codemode: false, permission: "t3-code_preview_open" })
    // Over 63 characters with the server prefix: stays direct under a provider-safe alias.
    const alias = McpTool.directName(hostServer, "t3_environment_preferences_update")
    const long = listed.find((tool) => tool.id === alias)
    expect(long?.options).toMatchObject({ codemode: false, permission: "t3-code_t3_environment_preferences_update" })
    expect(alias.length).toBeLessThanOrEqual(63)
    // An untrusted server using the host name gets neither direct exposure nor host grants.
    expect(listed.find((tool) => tool.name === "steal")?.options).toMatchObject({
      codemode: true,
      permission: "mcp_t3-code_steal",
    })
  }),
)

it.effect("McpTool rejects later tools whose advertised names collide, keeping host tools", () => {
  const logs: string[] = []
  return Effect.gen(function* () {
    const { tools, mcpTool: service } = yield* build(() =>
      Effect.succeed([
        // Sorted first by server, but untrusted: the host tool must still claim the shared name.
        mcpTool(Mcp.ServerName.make("a.b"), "c"),
        mcpTool(Mcp.ServerName.make("a_b"), "c", host),
      ]),
    )
    yield* service.flush
    const listed = yield* tools.list()
    expect(listed.map((tool) => tool.id)).toEqual(["a_b_c"])
    expect(listed[0]?.options).toMatchObject({ codemode: false, permission: "t3-code_c" })
    expect(logs).toContain("Skipping MCP tools whose advertised names collide with registered tools")
  }).pipe(Effect.provide(capture(logs)))
})

it.effect("McpTool.flush latches a failed reconcile until another change arrives", () => {
  const logs: string[] = []
  return Effect.gen(function* () {
    let calls = 0
    let fail = false
    const { bus, mcpTool: service } = yield* build(() =>
      Effect.suspend(() => {
        calls += 1
        return fail ? Effect.die("catalog unavailable") : Effect.succeed([])
      }),
    )
    yield* service.flush
    expect(calls).toBe(1)

    fail = true
    yield* bus.publish(McpEvent.ToolsChanged, { server: hostServer }, { location })
    yield* service.flush
    expect(calls).toBe(2)
    expect(logs).toContain("MCP tool reconcile failed")
    yield* service.flush
    yield* service.flush
    expect(calls).toBe(2)

    fail = false
    yield* bus.publish(McpEvent.ToolsChanged, { server: hostServer }, { location })
    yield* service.flush
    expect(calls).toBe(3)
  }).pipe(Effect.provide(capture(logs)))
})

it.effect("McpTool.flush surfaces a failed initial registration once", () => {
  const logs: string[] = []
  return Effect.gen(function* () {
    const { tools, mcpTool: service } = yield* build(() => Effect.die("initial discovery failed"))
    yield* service.flush
    yield* service.flush
    expect(yield* tools.list()).toEqual([])
    expect(logs.filter((message) => message === "Initial MCP tool registration failed")).toHaveLength(1)
  }).pipe(Effect.provide(capture(logs)))
})
