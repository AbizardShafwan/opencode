import { expect } from "bun:test"
import { execFileSync } from "node:child_process"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { Permission } from "@opencode/core/permission"
import { SecretFile } from "@opencode/core/secret-file"
import { SessionExternalWait } from "@opencode/core/session/external-wait"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionStore } from "@opencode/core/session/store"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { McpTool } from "@opencode/core/tool/mcp"
import { ToolOutput } from "@opencode/core/tool-output"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Context, Effect, Layer, Logger } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { it } from "./lib/effect"

const directory = AbsolutePath.make("/tmp/opencode-mcp-host-policy-test")
const location = { directory, project: { id: Project.ID.make("proj_test"), directory, canonical: directory } }
const hostServer = Mcp.ServerName.make("t3-code-12345678-1234-1234-1234-123456789012")
const host = { trustedHost: true, permissionNamespace: "t3-code", codemode: false } as const
const rootID = Session.ID.make("ses_root")

const mcpTool = (server: Mcp.ServerName, name: string, extra: Partial<Mcp.Tool> = {}): Mcp.Tool => ({
  server,
  name,
  inputSchema: { type: "object", properties: {} },
  ...extra,
})

type CallInput = Parameters<Mcp.Interface["callTool"]>[0]
const outputData = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-mcp-host-"))

type Options = {
  readonly tools: ReadonlyArray<Mcp.Tool>
  readonly result?: (input: CallInput) => Mcp.ToolResult
  readonly denySubagent?: boolean
  /** Child session ID to parent ID; sessions absent from the map are roots. */
  readonly parents?: Readonly<Record<string, string>>
}

const build = (options: Options) =>
  Effect.gen(function* () {
    const asserted: Permission.AssertInput[] = []
    const called: CallInput[] = []
    const waitCalls: Array<{ readonly action: string; readonly waitID?: string; readonly prefix?: string }> = []
    const mcpLayer = Layer.mock(Mcp.Service, {
      tools: () => Effect.succeed([...options.tools]),
      callTool: (input) =>
        Effect.sync(() => {
          called.push(input)
          input.onProgress?.({ progress: 1, total: 2, message: "half" })
          return (
            options.result?.(input) ?? {
              server: Mcp.ServerName.make(input.server),
              tool: input.name,
              isError: false,
              content: [{ type: "text", text: "ok" }],
            }
          )
        }),
    })
    const waits = SessionExternalWait.Service.of({
      register: (input) =>
        Effect.sync(() => {
          waitCalls.push({ action: "register", waitID: input.waitID })
          return {
            waitID: input.waitID,
            sessionID: input.sessionID,
            source: input.source,
            server: input.server,
            description: input.description,
            expiresAt: 0,
            boot: "test",
          }
        }),
      clear: (_sessionID, waitID) =>
        Effect.sync(() => {
          waitCalls.push({ action: "clear", waitID })
        }),
      clearByPrefix: (_sessionID, prefix) =>
        Effect.sync(() => {
          waitCalls.push({ action: "clearByPrefix", prefix })
        }),
      clearSession: () => Effect.void,
      list: () => Effect.succeed([]),
      listAll: () => Effect.succeed([]),
    })
    const permissionLayer = Layer.mock(Permission.Service, {
      assert: (input) =>
        Effect.gen(function* () {
          asserted.push(input)
          if (options.denySubagent && input.action === "subagent")
            return yield* new Permission.BlockedError({ rules: [], permission: "subagent", resources: ["*"] })
        }),
    })
    // Only ancestry is read; the remaining Session.Info fields are irrelevant to the depth check.
    const sessionLayer = Layer.mock(SessionStore.Service, {
      get: (sessionID) =>
        Effect.succeed({ id: sessionID, parentID: options.parents?.[sessionID] } as unknown as Session.Info),
    })
    const services = yield* Layer.build(
      AppNodeBuilder.build(
        LayerNode.group([Tool.node, McpTool.node, Bus.node, SecretFile.node, SessionExternalWait.node]),
        [
          Config.node.replace(Config.testLayer()),
          Location.node.replace(Layer.succeed(Location.Service, location)),
          Mcp.node.replace(mcpLayer),
          Permission.node.replace(permissionLayer),
          SessionStore.node.replace(sessionLayer),
          SessionExternalWait.node.replace(Layer.succeed(SessionExternalWait.Service, waits)),
          ToolOutput.node.replace(Layer.succeed(ToolOutput.Service, ToolOutput.Service.of({} as ToolOutput.Interface))),
        ],
      ),
    )
    const tools = Context.get(services, Tool.Service)
    yield* Context.get(services, McpTool.Service).flush
    return { tools, asserted, called, waitCalls, waits, secretFiles: Context.get(services, SecretFile.Service) }
  })

const run = (
  tools: Tool.Interface,
  name: string,
  input: unknown,
  sessionID = rootID,
  progress?: (update: Tool.Metadata) => Effect.Effect<void>,
) =>
  tools.snapshot().pipe(
    Effect.flatMap((snapshot) =>
      snapshot.execute({
        sessionID,
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_host_policy"),
        call: { type: "tool-call", id: "call_host", name, input },
        ...(progress === undefined ? {} : { progress }),
      }),
    ),
    Effect.result,
  )

const secretID = McpTool.directName(hostServer, "request_secret")
const delegateID = McpTool.directName(hostServer, "delegate_task")

it.effect("marks only the verified host request_secret as sensitive and redacts its permission metadata", () =>
  Effect.gen(function* () {
    const spoofed = Mcp.ServerName.make("t3-code")
    const { tools, asserted, called } = yield* build({
      tools: [mcpTool(hostServer, "request_secret", host), mcpTool(spoofed, "request_secret", { codemode: false })],
      result: (input) => ({
        server: Mcp.ServerName.make(input.server),
        tool: input.name,
        isError: false,
        content: [{ type: "text", text: '{"secretRef":"sref_123"}' }],
      }),
    })
    const listed = yield* tools.list()
    expect(listed.find((tool) => tool.id === secretID)?.options?.sensitiveInputs).toEqual(["value"])
    expect(listed.find((tool) => tool.options?.permission === "mcp_t3-code_request_secret")?.options).not.toHaveProperty(
      "sensitiveInputs",
    )
    const snapshot = yield* tools.snapshot()
    expect(snapshot.sensitiveInputs?.(secretID)).toEqual(["value"])

    const result = yield* run(tools, secretID, { label: "Token", value: "ghp_secret" })
    expect(result._tag).toBe("Success")
    if (result._tag === "Success") expect(result.success.output).toEqual({ secretRef: "sref_123" })
    expect(called[0]?.args).toEqual({ label: "Token", value: "ghp_secret" })
    expect(asserted[0]?.metadata).toEqual({ input: { label: "Token", value: "[REDACTED]" } })
  }),
)

it.effect("never exposes a sensitive host tool through Code Mode", () => {
  const logs: string[] = []
  return Effect.gen(function* () {
    const { tools } = yield* build({
      tools: [mcpTool(hostServer, "request_secret", { ...host, codemode: true })],
    })
    expect((yield* tools.list()).some((tool) => tool.name === "request_secret")).toBe(false)
    expect(logs).toContain("Skipping MCP tools that take secrets but are configured for Code Mode")

    // The registry guard holds for any sensitive registration, not only MCP ones.
    yield* tools.transform((editor) =>
      editor.add({
        name: "secret_codemode",
        options: { sensitiveInputs: ["value"] },
        description: "test",
        input: { type: "object", properties: {} },
        output: {},
        execute: () => Effect.succeed({ output: null }),
      }),
    )
    const snapshot = yield* tools.snapshot()
    expect(JSON.stringify(snapshot.codeModeCatalog ?? {})).not.toContain("secret_codemode")
  }).pipe(
    Effect.provide(
      Logger.layer([
        Logger.make((options) => {
          logs.push(String(Array.isArray(options.message) ? options.message[0] : options.message))
        }),
      ]),
    ),
  )
})

it.effect("registers a delivered secret file so it stays protected", () =>
  Effect.gen(function* () {
    const { tools, secretFiles } = yield* build({
      tools: [mcpTool(hostServer, "request_secret", host)],
      result: (input) => ({
        server: Mcp.ServerName.make(input.server),
        tool: input.name,
        isError: false,
        content: [{ type: "text", text: JSON.stringify({ delivery: "file", path: path.join(outputData, "pin") }) }],
      }),
    })
    const file = path.join(outputData, "pin")
    yield* Effect.promise(() => fs.writeFile(file, "1234"))
    expect(yield* secretFiles.isProtected(file)).toBe(false)
    yield* run(tools, secretID, { label: "PIN", delivery: "file" })
    expect(yield* secretFiles.isProtected(file)).toBe(true)
  }),
)

it.effect("enforces the subagent permission before host delegation", () =>
  Effect.gen(function* () {
    const { tools, asserted, called } = yield* build({
      tools: [mcpTool(hostServer, "delegate_task", host)],
      denySubagent: true,
    })
    const result = yield* run(tools, delegateID, { task: "work" })
    expect(result._tag).toBe("Failure")
    expect(asserted.map((input) => input.action)).toEqual(["t3-code_delegate_task", "subagent"])
    expect(called).toEqual([])
  }),
)

it.effect("enforces the subagent depth limit on host delegation", () =>
  Effect.gen(function* () {
    const { tools, called } = yield* build({
      tools: [mcpTool(hostServer, "delegate_task", host)],
      parents: { ses_depth3: "ses_depth2", ses_depth2: "ses_depth1", ses_depth1: "ses_root" },
    })
    const nested = yield* run(tools, delegateID, { task: "work" }, Session.ID.make("ses_depth3"))
    expect(nested._tag).toBe("Failure")
    if (nested._tag === "Failure") expect(nested.failure.message).toContain("Subagent depth limit reached (3)")
    expect(called).toEqual([])

    const shallow = yield* run(tools, delegateID, { task: "work" }, Session.ID.make("ses_depth2"))
    expect(shallow._tag).toBe("Success")
    expect(called).toHaveLength(1)
  }),
)

it.effect("defers only the verified host worktree handoff", () =>
  Effect.gen(function* () {
    const spoofed = Mcp.ServerName.make("t3-code")
    const handoff = McpTool.directName(hostServer, "t3_worktree_handoff")
    const { tools } = yield* build({
      tools: [
        mcpTool(hostServer, "t3_worktree_handoff", host),
        mcpTool(hostServer, "delegate_task", host),
        mcpTool(spoofed, "t3_worktree_handoff", { codemode: false }),
      ],
    })
    const snapshot = yield* tools.snapshot()
    expect(snapshot.isDeferred?.(handoff)).toBe(true)
    expect(snapshot.isDeferred?.(delegateID)).toBe(false)
    expect(snapshot.isDeferred?.(McpTool.directName(spoofed, "t3_worktree_handoff"))).toBe(false)
  }),
)

it.effect("tracks external waits for the verified host's async tools", () =>
  Effect.gen(function* () {
    const { tools, waitCalls, waits } = yield* build({
      tools: [
        mcpTool(hostServer, "watch_pull_request", host),
        mcpTool(hostServer, "unwatch_pull_request", host),
        mcpTool(hostServer, "delegate_task", host),
        mcpTool(hostServer, "task_cancel", host),
        mcpTool(hostServer, "task_status", host),
        mcpTool(hostServer, "t3_background_wait", host),
      ],
      result: (input): Mcp.ToolResult => {
        const base = { server: Mcp.ServerName.make(input.server), tool: input.name, isError: false, content: [] }
        if (input.name === "delegate_task") return { ...base, structured: { taskId: "task-1" } }
        if (input.name === "task_status") {
          if (input.args?.taskId === "task-waiting-children")
            return {
              ...base,
              structured: {
                taskId: input.args.taskId,
                status: "completed",
                workState: "waiting_for_children",
                hasPendingChildRuns: true,
              },
            }
          return {
            ...base,
            structured: { taskId: input.args?.taskId, status: "completed", workState: "result_available" },
          }
        }
        if (input.name === "t3_background_wait" && input.args?.alreadyDone === true)
          return { ...base, structured: { waiting: false } }
        return base
      },
    })
    // Tool execution resolves optional services from its ambient context, so provide the lease store here.
    const call = (name: string, input: Record<string, unknown>) =>
      run(tools, McpTool.directName(hostServer, name), input).pipe(
        Effect.provideService(SessionExternalWait.Service, waits),
      )

    // URL and `{ repository, number }` canonicalize to the same key, distinct across repos, and branch unwatch doesn't wipe explicit watches.
    expect((yield* call("watch_pull_request", { url: "https://github.com/Acme/RepoA/pull/42" }))._tag).toBe("Success")
    expect((yield* call("unwatch_pull_request", { repository: "acme/repoa", number: 42 }))._tag).toBe("Success")
    expect(
      (yield* call("watch_pull_request", { url: "https://gitlab.example.com/Group/Sub/Project/-/merge_requests/42" }))
        ._tag,
    ).toBe("Success")
    expect(
      (
        yield* call("unwatch_pull_request", {
          host: "gitlab.example.com",
          repository: "group/sub/project",
          number: 42,
        })
      )._tag,
    ).toBe("Success")
    expect((yield* call("watch_pull_request", { repository: "acme/repob", number: 42 }))._tag).toBe("Success")
    expect((yield* call("unwatch_pull_request", {}))._tag).toBe("Success")
    expect((yield* call("delegate_task", { mode: "work", title: "Fix the bug" }))._tag).toBe("Success")
    expect((yield* call("task_cancel", { taskId: "task-1" }))._tag).toBe("Success")
    expect((yield* call("delegate_task", { mode: "work", title: "Fix the bug" }))._tag).toBe("Success")
    expect((yield* call("task_status", { taskId: "task-waiting-children" }))._tag).toBe("Success")
    expect((yield* call("task_status", { taskId: "task-1" }))._tag).toBe("Success")
    expect((yield* call("t3_background_wait", { taskIds: ["bg-1", "bg-2"] }))._tag).toBe("Success")
    expect((yield* call("t3_background_wait", { taskIds: ["bg-1"], waiting: false }))._tag).toBe("Success")
    expect((yield* call("t3_background_wait", { taskIds: ["bg-2"], alreadyDone: true }))._tag).toBe("Success")

    expect(waitCalls).toEqual([
      { action: "register", waitID: "pr-watch:acme/repoa#42" },
      { action: "clear", waitID: "pr-watch:acme/repoa#42" },
      { action: "register", waitID: "pr-watch:gitlab.example.com/group/sub/project#42" },
      { action: "clear", waitID: "pr-watch:gitlab.example.com/group/sub/project#42" },
      { action: "register", waitID: "pr-watch:acme/repob#42" },
      { action: "clear", waitID: "pr-watch:branch" },
      { action: "register", waitID: "delegate:task-1" },
      { action: "clear", waitID: "delegate:task-1" },
      { action: "register", waitID: "delegate:task-1" },
      { action: "clear", waitID: "delegate:task-1" },
      { action: "register", waitID: "bg:bg-1" },
      { action: "register", waitID: "bg:bg-2" },
      { action: "clear", waitID: "bg:bg-1" },
      { action: "clear", waitID: "bg:bg-2" },
    ])

    // A server that merely claims the host name cannot mask real waits.
    const spoofed = Mcp.ServerName.make("t3-code")
    const spoofedTools = yield* build({
      tools: [mcpTool(spoofed, "watch_pull_request", { codemode: false })],
    })
    yield* run(spoofedTools.tools, McpTool.directName(spoofed, "watch_pull_request"), {
      url: "https://example.com/pr/9",
    })
    expect(spoofedTools.waitCalls).toEqual([])
  }),
)

it.effect("forwards MCP progress to the tool progress channel", () =>
  Effect.gen(function* () {
    const updates: Tool.Metadata[] = []
    const { tools } = yield* build({ tools: [mcpTool(hostServer, "long_tool", host)] })
    const result = yield* run(tools, McpTool.directName(hostServer, "long_tool"), {}, rootID, (update) =>
      Effect.sync(() => void updates.push(update)),
    )
    expect(result._tag).toBe("Success")
    yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow)
    expect(updates).toEqual([{ progress: 1, total: 2, message: "half" }])
  }),
)

const fifoEffect = process.platform === "win32" ? it.effect.skip : it.effect

fifoEffect("registers FIFO secret delivery for read protection without draining the pipe", () =>
  Effect.gen(function* () {
    const fifo = path.join(outputData, "secret.fifo")
    yield* Effect.sync(() => execFileSync("mkfifo", [fifo]))
    const { tools, secretFiles } = yield* build({
      tools: [mcpTool(hostServer, "request_secret", host)],
      result: (input) => ({
        server: Mcp.ServerName.make(input.server),
        tool: input.name,
        isError: false,
        content: [{ type: "text", text: `Secret FIFO ready at ${fifo}` }],
      }),
    })
    yield* run(tools, McpTool.directName(hostServer, "request_secret"), { label: "FIFO", delivery: "fifo" })
    expect(yield* secretFiles.isProtected(fifo)).toBe(true)
    const failure = yield* Effect.flip(secretFiles.assertReadable(fifo))
    expect(failure.message).toBe(SecretFile.PROTECTED_MESSAGE)
    expect(yield* secretFiles.readSecretBytes(yield* secretFiles.active())).toEqual([])
  }),
)

it.effect("extracts POSIX, Windows drive, UNC, and quoted secret paths from host tool output", () =>
  Effect.sync(() => {
    expect(McpTool.deliveredFiles(undefined, "Saved to C:\\Users\\Alice\\secret.txt")).toEqual([
      "C:\\Users\\Alice\\secret.txt",
    ])
    expect(McpTool.deliveredFiles(undefined, "Saved to c:/Users/Alice/secret.txt")).toEqual([
      "c:/Users/Alice/secret.txt",
    ])
    expect(McpTool.deliveredFiles(undefined, 'Secret at "C:\\Users\\First Last\\secret.txt" ready')).toEqual([
      "C:\\Users\\First Last\\secret.txt",
    ])
    expect(McpTool.deliveredFiles(undefined, "Secret at 'C:/Users/First Last/secret.txt' ready")).toEqual([
      "C:/Users/First Last/secret.txt",
    ])
    expect(McpTool.deliveredFiles(undefined, "Written to \\\\fileserver\\secrets\\token.txt")).toEqual([
      "\\\\fileserver\\secrets\\token.txt",
    ])
    expect(McpTool.deliveredFiles(undefined, 'Written to "\\\\fileserver\\my share\\tok.txt"')).toEqual([
      "\\\\fileserver\\my share\\tok.txt",
    ])
    expect(McpTool.deliveredFiles(undefined, "Pipe at `/tmp/my secret/pin.fifo` and /var/run/secret")).toEqual([
      "/tmp/my secret/pin.fifo",
      "/var/run/secret",
    ])
    expect(
      McpTool.deliveredFiles({ filePath: "C:\\Users\\Alice\\secret.txt" }, "ignored https://example.com/a/b"),
    ).toEqual(["C:\\Users\\Alice\\secret.txt"])
    expect(McpTool.deliveredFiles(undefined, "See https://example.com/foo/bar for instructions")).toEqual([])
  }),
)
