import { expect } from "bun:test"
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
import { Context, Effect, Layer } from "effect"
import { it } from "./lib/effect"

it.effect("McpTool.flush reconciles tools immediately after ToolsChanged without waiting for debounce", () =>
  Effect.gen(function* () {
    let catalog: Mcp.Tool[] = []
    const mcpLayer = Layer.succeed(
      Mcp.Service,
      Mcp.Service.of({
        tools: () => Effect.sync(() => catalog),
        status: () => Effect.succeed([]),
        add: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
        connect: () => Effect.die("unused"),
        disconnect: () => Effect.die("unused"),
        callTool: () => Effect.die("unused"),
        prompts: () => Effect.succeed([]),
        getPrompt: () => Effect.die("unused"),
        resources: () => Effect.succeed([]),
        readResource: () => Effect.die("unused"),
        authenticate: () => Effect.die("unused"),
        startAuth: () => Effect.die("unused"),
        finishAuth: () => Effect.die("unused"),
        removeAuth: () => Effect.die("unused"),
        attach: () => Effect.die("unused"),
      } as unknown as Mcp.Interface),
    )
    const permissionLayer = Layer.succeed(Permission.Service, Permission.Service.of({} as Permission.Interface))
    const toolOutputLayer = Layer.succeed(ToolOutput.Service, ToolOutput.Service.of({} as ToolOutput.Interface))
    const directory = AbsolutePath.make("/tmp/opencode-mcp-flush-test")
    const location = { directory, project: { id: Project.ID.make("proj_test"), directory, canonical: directory } }

    const services = yield* Layer.build(
      AppNodeBuilder.build(LayerNode.group([Tool.node, McpTool.node, Bus.node]), [
        Location.node.replace(Layer.succeed(Location.Service, location)),
        Mcp.node.replace(mcpLayer),
        Permission.node.replace(permissionLayer),
        ToolOutput.node.replace(toolOutputLayer),
      ]),
    )

    const bus = Context.get(services, Bus.Service)
    const tools = Context.get(services, Tool.Service)
    const mcpTool = Context.get(services, McpTool.Service)

    yield* mcpTool.flush
    expect((yield* tools.list()).map((tool) => tool.name)).toEqual([])

    const server = Mcp.ServerName.make("t3-code-12345678-1234-1234-1234-123456789012")
    const otherDirectory = AbsolutePath.make("/tmp/opencode-other-location")
    catalog = [
      {
        server,
        name: "preview_open",
        description: "Open page in T3 browser",
        inputSchema: { type: "object", properties: {} },
      },
      {
        server,
        name: "t3_environment_preferences_update",
        description: "Long tool name (> 64 chars with server prefix)",
        inputSchema: { type: "object", properties: {} },
      },
    ]
    // Cross-location ToolsChanged must be ignored.
    yield* bus.publish(McpEvent.ToolsChanged, { server }, { location: { directory: otherDirectory } })
    yield* mcpTool.flush
    expect((yield* tools.list()).map((tool) => tool.name)).toEqual([])

    yield* bus.publish(McpEvent.ToolsChanged, { server }, { location })
    // Synchronous bus.listen updates `seen` before bus.publish returns — no yieldNow or TestClock advance needed.
    yield* mcpTool.flush

    const listed = yield* tools.list()
    expect(listed.find((tool) => tool.name === "preview_open")?.options?.codemode).toBe(false)
    expect(listed.find((tool) => tool.name === "t3_environment_preferences_update")?.options?.codemode).toBe(true)
  }),
)
