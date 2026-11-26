import { expect } from "bun:test"
import { Config } from "@opencode/core/config"
import { InMemoryTransport, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { ConfigMCP } from "@opencode/schema/config/mcp"
import { McpEvent } from "@opencode/schema/mcp-event"
import { SessionEvent as SchemaSessionEvent } from "@opencode/schema/session-event"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Environment } from "@opencode/core/environment/index"
import { Image } from "@opencode/core/image"
import { Integration } from "@opencode/core/integration"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { SessionExternalWait } from "@opencode/core/session/external-wait"
import { Tool } from "@opencode/core/tool"
import { McpTool } from "@opencode/core/tool/mcp"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Exit, Layer, Schedule, Scope, Stream } from "effect"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { executeTool, toolIdentity } from "./lib/tool"

// Attached clients are never OAuth integrations.
const unused = () => Effect.die("unused integration service")

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, McpTool.node, Mcp.node, Bus.node, Location.node, SessionExternalWait.node]), [
    Config.node.replace(Config.testLayer()),
    Location.node.replace(tempLocationLayer),
    Environment.node.replace(hostEnvironmentLayer),
    Integration.node.replace(
      Layer.mock(Integration.Service, {
        revision: () => 0,
        connection: {
          active: unused,
          resolve: unused,
          key: unused,
          external: unused,
          activate: unused,
          update: unused,
          remove: unused,
          status: unused,
        },
        oauth: { connect: unused, status: unused, complete: unused, cancel: unused },
        command: { connect: unused, status: unused, cancel: unused },
      }),
    ),
    Credential.node.replace(Layer.mock(Credential.Service, {})),
    Permission.node.replace(Layer.mock(Permission.Service, { assert: () => Effect.void })),
    Image.node.replace(imagePassthrough),
  ]),
)

/** Starts an in-memory client MCP server whose tools answer with `label` and record the caller's session. */
const clientServer = (label: string, tools: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const server = new McpServer({ name: label, version: "1.0.0" })
    const sessions: Array<unknown> = []
    for (const tool of tools)
      server.registerTool(tool, { description: `${label} ${tool}` }, (ctx) => {
        sessions.push(ctx.mcpReq._meta?.["ai.opencode/sessionID"])
        return { content: [{ type: "text", text: `${label}:${tool}` }] }
      })
    const [client, transport] = InMemoryTransport.createLinkedPair()
    yield* Effect.acquireRelease(
      Effect.promise(() => server.connect(transport)),
      () => Effect.promise(() => server.close()),
    )
    return { server, client, sessions }
  })

/** Forwards a transport, answering `tools/list` with an error while `state.fail` is set. */
const failingList = (inner: Transport) => {
  const state = { fail: false }
  const transport: Transport = {
    start: () => inner.start(),
    close: () => inner.close(),
    send: async (message: JSONRPCMessage, options) => {
      if (!state.fail || !("method" in message) || message.method !== "tools/list" || !("id" in message))
        return inner.send(message, options)
      queueMicrotask(() =>
        transport.onmessage?.({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "list failed" } }),
      )
    },
  }
  inner.onmessage = (message, extra) => transport.onmessage?.(message, extra)
  inner.onclose = () => transport.onclose?.()
  inner.onerror = (error) => transport.onerror?.(error)
  return { transport, state }
}

const toolsChanged = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const servers: string[] = []
  yield* bus.subscribe(McpEvent.ToolsChanged).pipe(
    Stream.runForEach((event) => Effect.sync(() => servers.push(event.data.server))),
    Effect.forkScoped({ startImmediately: true }),
  )
  return servers
})

const waitUntil = (check: () => boolean) =>
  Effect.suspend(() => (check() ? Effect.void : Effect.fail("pending"))).pipe(
    Effect.retry({ times: 500, schedule: Schedule.spaced("2 millis") }),
  )

/** Waits until the MCP tool registration has (or has not) settled on a registry id. */
const registered = (id: string, present = true) =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    const registration = yield* McpTool.Service
    yield* registration.flush
    const ids = (yield* registry.list()).map((tool) => tool.id)
    if (ids.includes(id) !== present) return yield* Effect.fail("pending")
  }).pipe(Effect.retry({ times: 500, schedule: Schedule.spaced("2 millis") }))

// Attached tools use Code Mode by default, like any MCP server's tools.
const call = (path: string, sessionID = Session.ID.make("ses_client_mcp")) =>
  Effect.gen(function* () {
    return yield* executeTool(yield* Tool.Service, {
      sessionID,
      ...toolIdentity,
      call: {
        type: "tool-call",
        id: "call_client_mcp",
        name: "execute",
        input: { code: `return await tools.${path}({})` },
      },
    })
  })

it.live("attaches a client MCP server and routes its tools with the session", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const changes = yield* toolsChanged
    const client = yield* clientServer("tui", ["open_terminal"])

    expect(yield* mcp.isAttached("tui")).toBe(false)
    yield* mcp.attach("tui", client.client)
    yield* waitUntil(() => changes.includes("tui"))
    expect(yield* mcp.isAttached("tui")).toBe(true)
    expect(yield* mcp.isAttached("missing")).toBe(false)
    expect((yield* mcp.tools()).map((tool) => [tool.server, tool.name])).toEqual([["tui", "open_terminal"]])

    yield* registered("tui_open_terminal")
    const result = yield* call("tui.open_terminal", Session.ID.make("ses_attached"))
    expect(result.status).toBe("completed")
    expect(result.output?.output).toBe("tui:open_terminal")
    expect(client.sessions).toEqual(["ses_attached"])
  }),
)

it.live("removes an attached entry when its scope closes", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const changes = yield* toolsChanged
    const client = yield* clientServer("tui", ["open_terminal"])
    const scope = yield* Scope.make()

    yield* mcp.attach("tui", client.client).pipe(Scope.provide(scope))
    yield* registered("tui_open_terminal")
    const before = changes.length

    yield* Scope.close(scope, Exit.void)
    expect(yield* mcp.isAttached("tui")).toBe(false)
    expect(yield* mcp.tools()).toEqual([])
    yield* waitUntil(() => changes.length > before)
    yield* registered("tui_open_terminal", false)
    expect(yield* mcp.callTool({ server: "tui", name: "open_terminal" }).pipe(Effect.flip)).toBeInstanceOf(
      Mcp.NotFoundError,
    )
  }),
)

it.live("fails an attach whose initial tool list fails and closes its transport", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const first = yield* clientServer("first", ["open_terminal"])
    const second = yield* clientServer("second", ["broken"])
    const failing = failingList(second.client)
    failing.state.fail = true
    let closed = false
    const close = failing.transport.close
    failing.transport.close = () => {
      closed = true
      return close()
    }

    yield* mcp.attach("tui", first.client)
    const error = yield* mcp.attach("tui", failing.transport).pipe(Effect.flip)
    expect(error.message).toContain("list failed")
    expect(closed).toBe(true)
    expect((yield* mcp.tools()).map((tool) => tool.name)).toEqual(["open_terminal"])
  }),
)

it.live("routes an unknown tool on an attached-only name to the client", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const client = yield* clientServer("tui", ["open_terminal"])

    yield* mcp.attach("tui", client.client)
    expect(yield* mcp.callTool({ server: "tui", name: "missing" }).pipe(Effect.flip)).toBeInstanceOf(Mcp.ToolCallError)
  }),
)

it.live("removes an attached entry when the client closes the connection", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const changes = yield* toolsChanged
    const client = yield* clientServer("tui", ["open_terminal"])

    yield* mcp.attach("tui", client.client)
    yield* registered("tui_open_terminal")
    const before = changes.length

    yield* Effect.promise(() => client.server.close())
    yield* waitUntil(() => changes.length > before)
    expect(yield* mcp.tools()).toEqual([])
    yield* registered("tui_open_terminal", false)
  }),
)

it.live("stacks a second attach under the same name and keeps the first connected", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const first = yield* clientServer("first", ["old_tool", "shared"])
    const second = yield* clientServer("second", ["shared"])

    yield* mcp.attach("tui", first.client)
    yield* registered("tui_old_tool")
    yield* mcp.attach("tui", second.client)
    expect((yield* mcp.tools()).map((tool) => tool.name)).toEqual(["shared"])
    yield* registered("tui_old_tool", false)

    const result = yield* call("tui.shared")
    expect(result.output?.output).toBe("second:shared")
    expect(first.sessions).toEqual([])
    expect(first.server.isConnected()).toBe(true)
  }),
)

it.live("falls back to the previous connection when the top one closes", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const changes = yield* toolsChanged
    const first = yield* clientServer("first", ["shared"])
    const second = yield* clientServer("second", ["shared"])

    yield* mcp.attach("tui", first.client)
    yield* mcp.attach("tui", second.client)
    // Changes on an idle connection stay hidden until it takes over.
    first.server.registerTool("added", { description: "first added" }, () => ({
      content: [{ type: "text", text: "first:added" }],
    }))
    yield* registered("tui_shared")
    expect((yield* mcp.tools()).map((tool) => tool.name)).toEqual(["shared"])
    const before = changes.length

    yield* Effect.promise(() => second.server.close())
    yield* waitUntil(() => changes.length > before)
    expect((yield* mcp.tools()).map((tool) => tool.name)).toEqual(["added", "shared"])
    yield* registered("tui_added")
    expect((yield* call("tui.shared")).output?.output).toBe("first:shared")
    expect((yield* call("tui.added")).output?.output).toBe("first:added")
  }),
)

it.live("falls back to a connection with the same tools without publishing a change", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const changes = yield* toolsChanged
    // Same label, so both list identical tools; the recorded sessions tell them apart.
    const first = yield* clientServer("same", ["shared"])
    const second = yield* clientServer("same", ["shared"])
    const marker = yield* clientServer("marker", ["done"])
    const scope = yield* Scope.make()

    yield* mcp.attach("tui", first.client)
    yield* mcp.attach("tui", second.client).pipe(Scope.provide(scope))
    yield* waitUntil(() => changes.length === 2)
    yield* registered("tui_shared")

    yield* Scope.close(scope, Exit.void)
    yield* call("tui.shared", Session.ID.make("ses_fallback"))
    expect(first.sessions).toEqual(["ses_fallback"])
    expect(second.sessions).toEqual([])
    // Events arrive in order, so once the marker's attach shows up any fallback event would have too.
    yield* mcp.attach("marker", marker.client)
    yield* waitUntil(() => changes.includes("marker"))
    expect(changes).toEqual(["tui", "tui", "marker"])
  }),
)

it.live("keeps the stored tools when the fallback re-list fails", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const changes = yield* toolsChanged
    const first = yield* clientServer("first", ["kept"])
    const second = yield* clientServer("second", ["newer"])
    const failing = failingList(first.client)
    const scope = yield* Scope.make()

    yield* mcp.attach("tui", failing.transport)
    yield* mcp.attach("tui", second.client).pipe(Scope.provide(scope))
    first.server.registerTool("hidden", { description: "first hidden" }, () => ({
      content: [{ type: "text", text: "first:hidden" }],
    }))
    failing.state.fail = true
    yield* waitUntil(() => changes.length === 2)

    yield* Scope.close(scope, Exit.void)
    expect((yield* mcp.tools()).map((tool) => tool.name)).toEqual(["kept"])
    yield* waitUntil(() => changes.length === 3)
    yield* registered("tui_kept")
    expect((yield* call("tui.kept")).output?.output).toBe("first:kept")
  }),
)

it.live("refreshes the top connection's tools when it reports a change", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const changes = yield* toolsChanged
    const first = yield* clientServer("first", ["below"])
    const second = yield* clientServer("second", ["top"])

    yield* mcp.attach("tui", first.client)
    yield* mcp.attach("tui", second.client)
    yield* waitUntil(() => changes.length === 2)

    second.server.registerTool("added", { description: "second added" }, () => ({
      content: [{ type: "text", text: "second:added" }],
    }))
    yield* waitUntil(() => changes.length === 3)
    expect((yield* mcp.tools()).map((tool) => tool.name)).toEqual(["added", "top"])
    yield* registered("tui_added")
    expect((yield* call("tui.added")).output?.output).toBe("second:added")
  }),
)

it.live("closing a connection below the top changes nothing visible", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const changes = yield* toolsChanged
    const first = yield* clientServer("first", ["old_tool"])
    const second = yield* clientServer("second", ["shared"])
    const scope = yield* Scope.make()

    yield* mcp.attach("tui", first.client).pipe(Scope.provide(scope))
    yield* mcp.attach("tui", second.client)
    yield* waitUntil(() => changes.length === 2)
    yield* registered("tui_shared")

    yield* Scope.close(scope, Exit.void)
    yield* waitUntil(() => !first.server.isConnected())
    expect(changes).toHaveLength(2)
    expect((yield* mcp.tools()).map((tool) => tool.name)).toEqual(["shared"])
    expect((yield* call("tui.shared")).output?.output).toBe("second:shared")
  }),
)

it.live("removes the entry once every stacked connection closes", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const first = yield* clientServer("first", ["shared"])
    const second = yield* clientServer("second", ["shared"])

    yield* mcp.attach("tui", first.client)
    yield* mcp.attach("tui", second.client)
    yield* registered("tui_shared")

    yield* Effect.promise(() => second.server.close())
    yield* Effect.promise(() => first.server.close())
    yield* waitUntil(() => !first.server.isConnected() && !second.server.isConnected())
    yield* registered("tui_shared", false)
    expect(yield* mcp.tools()).toEqual([])
    expect(yield* mcp.callTool({ server: "tui", name: "shared" }).pipe(Effect.flip)).toBeInstanceOf(Mcp.NotFoundError)
  }),
)

it.live("hides attached entries from server status and keeps them across config reconciles", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const client = yield* clientServer("tui", ["open_terminal"])

    yield* mcp.attach("tui", client.client)
    expect(yield* mcp.servers()).toEqual([])

    // A configured server sharing the client's name neither shows the client nor captures its tools.
    yield* mcp.add("tui", new ConfigMCP.Local({ type: "local", command: ["unused"], disabled: true }))
    yield* mcp.add("other", new ConfigMCP.Local({ type: "local", command: ["unused"], disabled: true }))
    expect((yield* mcp.servers()).map((server) => [server.name, server.status.status])).toEqual([
      ["other", "disabled"],
      ["tui", "disabled"],
    ])
    yield* mcp.remove("tui")
    yield* mcp.reload()
    expect((yield* mcp.servers()).map((server) => server.name)).toEqual(["other"])

    expect((yield* mcp.tools()).map((tool) => [tool.server, tool.name])).toEqual([["tui", "open_terminal"]])
    const result = yield* mcp.callTool({ server: "tui", name: "open_terminal" })
    expect(result.content).toEqual([{ type: "text", text: "tui:open_terminal" }])
  }),
)

it.live(
  "clears matching external waits and emits SessionEvent.ExternalWait.Changed only from trusted-host attachments",
  () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp.Service
      const waits = yield* SessionExternalWait.Service
      const bus = yield* Bus.Service
      const loc = yield* Location.Service
      const settledEvents: Array<{ sessionID: string; directory?: string }> = []
      yield* bus.subscribe(SchemaSessionEvent.ExternalWait.Changed).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            settledEvents.push({ sessionID: event.data.sessionID, directory: event.location?.directory })
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )

      const host = yield* clientServer("t3-code-host", ["ping"])
      const untrusted = yield* clientServer("untrusted-mcp", ["pong"])
      yield* mcp.attach("t3-code-host", host.client, { trustedHost: true, permissionNamespace: "t3-code" })
      yield* mcp.attach("untrusted-mcp", untrusted.client)

      const s1 = Session.ID.make("ses_wait_notify_1")
      const s2 = Session.ID.make("ses_wait_notify_2")
      const wait = (sessionID: Session.ID, waitID: string) => ({
        sessionID,
        waitID,
        source: "pull_request_watch",
        server: "t3-code-host",
        description: `Wait ${waitID}`,
      })

      yield* waits.register(wait(s1, "pr-watch:1"))
      yield* waits.register(wait(s1, "pr-watch:2"))
      yield* waits.register(wait(s1, "bg:1"))
      yield* waits.register(wait(s2, "pr-watch:other"))
      settledEvents.length = 0

      // Untrusted attachments cannot clear or emit wait changes, even with `all: true`.
      yield* Effect.promise(() =>
        untrusted.server.server.notification({
          method: "notifications/opencode/external_wait_settled",
          params: { sessionID: s1, all: true },
        }),
      )
      yield* Effect.sleep("25 millis")
      expect((yield* waits.list(s1)).map((entry) => entry.waitID).toSorted()).toEqual(["bg:1", "pr-watch:1", "pr-watch:2"])
      expect(settledEvents).toEqual([])

      // Malformed trusted payloads fail schema validation and leave waits intact.
      for (const badParams of [
        { sessionID: s1 },
        { sessionID: s1, waitID: "" },
        { sessionID: s1, waitPrefix: "" },
        { sessionID: s1, all: false },
        { waitID: "pr-watch:1" },
      ]) {
        yield* Effect.promise(() =>
          host.server.server.notification({
            method: "notifications/opencode/external_wait_settled",
            params: badParams,
          }),
        )
      }
      yield* Effect.sleep("25 millis")
      expect((yield* waits.list(s1)).map((entry) => entry.waitID).toSorted()).toEqual(["bg:1", "pr-watch:1", "pr-watch:2"])
      expect(settledEvents).toEqual([])

      // Trusted host settles exact waitID.
      yield* Effect.promise(() =>
        host.server.server.notification({
          method: "notifications/opencode/external_wait_settled",
          params: { sessionID: s1, waitID: "bg:1" },
        }),
      )
      yield* waitUntil(() => settledEvents.length === 1)
      expect((yield* waits.list(s1)).map((entry) => entry.waitID).toSorted()).toEqual(["pr-watch:1", "pr-watch:2"])
      expect(settledEvents).toEqual([{ sessionID: s1, directory: loc.directory }])

      // Trusted host settles waitPrefix and leaves other sessions untouched.
      yield* Effect.promise(() =>
        host.server.server.notification({
          method: "notifications/opencode/external_wait_settled",
          params: { sessionID: s1, waitPrefix: "pr-watch:" },
        }),
      )
      yield* waitUntil(() => settledEvents.length === 2)
      expect(yield* waits.list(s1)).toEqual([])
      expect((yield* waits.list(s2)).map((entry) => entry.waitID)).toEqual(["pr-watch:other"])
      expect(settledEvents).toEqual([
        { sessionID: s1, directory: loc.directory },
        { sessionID: s1, directory: loc.directory },
      ])

      // Trusted host settles all for s2.
      yield* Effect.promise(() =>
        host.server.server.notification({
          method: "notifications/opencode/external_wait_settled",
          params: { sessionID: s2, all: true },
        }),
      )
      yield* waitUntil(() => settledEvents.length === 3)
      expect(yield* waits.list(s2)).toEqual([])
      expect(settledEvents[2]).toEqual({ sessionID: s2, directory: loc.directory })
    }),
)

it.live(
  "emits SessionEvent.ExternalWait.Changed when an attachment holding waits connects (empty->live) or disconnects (live->empty)",
  () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp.Service
      const waits = yield* SessionExternalWait.Service
      const bus = yield* Bus.Service
      const loc = yield* Location.Service
      const events: Array<{ sessionID: string; directory?: string }> = []
      yield* bus.subscribe(SchemaSessionEvent.ExternalWait.Changed).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push({ sessionID: event.data.sessionID, directory: event.location?.directory })
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )

      const ownedSession = Session.ID.make("ses_attach_edge")
      const otherServerSession = Session.ID.make("ses_attach_other")
      yield* waits.register({
        sessionID: ownedSession,
        waitID: "pr-watch:9",
        source: "pull_request_watch",
        server: "t3-code-host",
        description: "Watching PR #9",
      })
      yield* waits.register({
        sessionID: otherServerSession,
        waitID: "pr-watch:10",
        source: "pull_request_watch",
        server: "different-server",
        description: "Watching PR #10",
      })
      events.length = 0

      const first = yield* clientServer("first", ["ping"])
      const second = yield* clientServer("second", ["ping"])
      const firstScope = yield* Scope.make()
      const secondScope = yield* Scope.make()

      // empty -> live emits for sessions waiting on this server only.
      yield* mcp.attach("t3-code-host", first.client, { trustedHost: true }).pipe(Scope.provide(firstScope))
      yield* waitUntil(() => events.length === 1)
      expect(events).toEqual([{ sessionID: ownedSession, directory: loc.directory }])

      // live -> live stack push and lower-connection close emit nothing.
      yield* mcp.attach("t3-code-host", second.client, { trustedHost: true }).pipe(Scope.provide(secondScope))
      yield* Scope.close(firstScope, Exit.void)
      yield* Effect.sleep("25 millis")
      expect(events).toHaveLength(1)

      // live -> empty (last connection closed) emits again so UI/GoalPlugin notice disconnect.
      yield* Scope.close(secondScope, Exit.void)
      yield* waitUntil(() => events.length === 2)
      expect(events).toEqual([
        { sessionID: ownedSession, directory: loc.directory },
        { sessionID: ownedSession, directory: loc.directory },
      ])
    }),
)

it.live(
  "forwards onProgress and resets execution timeout on progress notifications for attached clients",
  () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp.Service
      const server = new McpServer({ name: "t3-code-progress", version: "1.0.0" })
      server.registerTool("slow_without_progress", { description: "hangs" }, async () => {
        await Bun.sleep(200)
        return { content: [{ type: "text", text: "late" }] }
      })
      server.registerTool("long_with_progress", { description: "ticks" }, async (ctx) => {
        const token = ctx.mcpReq._meta?.progressToken
        for (const step of [1, 2, 3]) {
          await Bun.sleep(45)
          if (token !== undefined) {
            await ctx.mcpReq.notify({
              method: "notifications/progress",
              params: { progressToken: token, progress: step, total: 3, message: `step-${step}` },
            })
          }
        }
        await Bun.sleep(45)
        return { content: [{ type: "text", text: "finished" }] }
      })

      const [client, transport] = InMemoryTransport.createLinkedPair()
      yield* Effect.acquireRelease(
        Effect.promise(() => server.connect(transport)),
        () => Effect.promise(() => server.close()),
      )
      yield* mcp.attach("t3-code-progress", client, {
        trustedHost: true,
        permissionNamespace: "t3-code",
        codemode: false,
        executionTimeoutMs: 80,
      })

      const err = yield* mcp.callTool({ server: "t3-code-progress", name: "slow_without_progress" }).pipe(Effect.flip)
      expect(err.message).toContain("Request timed out")

      const updates: Array<{ progress: number; total?: number; message?: string }> = []
      const ok = yield* mcp.callTool({
        server: "t3-code-progress",
        name: "long_with_progress",
        onProgress: (progress) => void updates.push(progress),
      })
      expect(ok.content).toEqual([{ type: "text", text: "finished" }])
      expect(updates).toEqual([
        { progress: 1, total: 3, message: "step-1" },
        { progress: 2, total: 3, message: "step-2" },
        { progress: 3, total: 3, message: "step-3" },
      ])
    }),
)
