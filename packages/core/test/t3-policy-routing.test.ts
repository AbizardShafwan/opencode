import { describe, expect } from "bun:test"
import { LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Effect, Layer, Stream } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Environment } from "@opencode/core/environment/index"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PlanPlugin } from "@opencode/core/plugin/plan"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { SecretFile } from "@opencode/core/secret-file"
import { Session } from "@opencode/core/session"
import { SessionContext } from "@opencode/core/session/context"
import { SessionExternalWait } from "@opencode/core/session/external-wait"
import { ReviewAuthority } from "@opencode/core/session/review-authority"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTable } from "@opencode/core/session/sql"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Tool } from "@opencode/core/tool"
import { McpTool } from "@opencode/core/tool/mcp"
import { SubagentTool } from "@opencode/core/tool/plugin/subagent"
import { ToolOutput } from "@opencode/core/tool-output"
import { AbsolutePath } from "@opencode/schema/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { testEffect } from "./lib/effect"
import { readInitial } from "./lib/instructions"
import { agentHost, host } from "./plugin/host"

const directory = AbsolutePath.make("/project")
const schema = { type: "object" as const, properties: {} }

const threadAServer = Mcp.ServerName.make("t3-code-thread_subagent_0123456789abcdef")
const threadBServer = Mcp.ServerName.make("t3-code-thread_b")
const longThreadServer = Mcp.ServerName.make("t3-code-thread_project_0123456789abcdef_0123456789abcdef_exceeding")
const spoofServer = Mcp.ServerName.make("t3-code-spoof")

const hostExtra: Partial<Mcp.Tool> = {
  trustedHost: true,
  permissionNamespace: "t3-code",
  preserveServerPermission: true,
  codemode: false,
}

const mcpTool = (server: Mcp.ServerName, name: string, extra: Partial<Mcp.Tool> = {}): Mcp.Tool => ({
  server,
  name,
  inputSchema: schema,
  ...extra,
})

const testMcpTools: Mcp.Tool[] = [
  // Thread A verified host tools covering read-only, plan-only, explore/plan-shared, and mutating actions.
  mcpTool(threadAServer, "pull_request_read", hostExtra),
  mcpTool(threadAServer, "t3_project_read", hostExtra),
  mcpTool(threadAServer, "t3_preview_list", hostExtra),
  mcpTool(threadAServer, "preview_wait_for", hostExtra),
  mcpTool(threadAServer, "t3_background_wait", hostExtra),
  mcpTool(threadAServer, "t3_thread_wait", hostExtra),
  mcpTool(threadAServer, "t3_submit_output", hostExtra),
  mcpTool(threadAServer, "send_to_user", hostExtra),
  mcpTool(threadAServer, "preview_snapshot", hostExtra),
  mcpTool(threadAServer, "pull_request_merge", hostExtra),
  mcpTool(threadAServer, "t3_worktree_remove", hostExtra),
  mcpTool(threadAServer, "delegate_task", hostExtra),
  // Thread B verified host tools that must stay isolated by session.permissions.
  mcpTool(threadBServer, "pull_request_read", hostExtra),
  mcpTool(threadBServer, "pull_request_merge", hostExtra),
  // Long verified server name pushing tool IDs past 63 chars (`m_<16hex>_<tool>`).
  mcpTool(longThreadServer, "list_thread_pull_requests", hostExtra),
  mcpTool(longThreadServer, "t3_worktree_handoff", hostExtra),
  mcpTool(longThreadServer, "delegate_task", hostExtra),
  // Untrusted spoof server claiming `t3-code-*` without verified host trust.
  mcpTool(spoofServer, "pull_request_read", { codemode: false }),
  mcpTool(spoofServer, "delegate_task", { codemode: false }),
]

const mcpCatalog: Mcp.ServerInstructions[] = [
  { server: threadAServer, instructions: "Thread A instructions" },
  { server: threadBServer, instructions: "Thread B instructions" },
  { server: longThreadServer, instructions: "Long Thread A instructions" },
  { server: spoofServer, instructions: "Spoof instructions" },
]

const noopInstructions = Effect.succeed(Instructions.empty)
const globalLayer = Layer.succeed(
  Global.Service,
  Global.Service.of(Global.make({ data: "/data", config: "/config", tmp: "/tmp/t3-policy-test" })),
)
const model = LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route })
const modelCatalog = Layer.mock(Model.Service, {
  available: () => Effect.succeed([]),
  get: () => Effect.succeed(undefined),
  small: () => Effect.succeed(undefined),
})
const runnerModel = Layer.mock(SessionRunnerModel.Service, {
  resolve: () =>
    Effect.succeed(
      SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 128_000, output: 8_000 },
      }),
    ),
})

const driver = Environment.makeMemoryDriver()
const envService = Environment.Service.of({ files: Environment.makeFiles(driver), spawner: driver.spawner })

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Agent.node,
      Bus.node,
      Config.node,
      Database.node,
      Global.node,
      Mcp.node,
      McpInstructions.node,
      McpTool.node,
      Permission.node,
      PermissionSaved.node,
      PluginHooks.node,
      Project.node,
      SecretFile.node,
      SessionContext.node,
      SessionExternalWait.node,
      Tool.node,
      ToolOutput.node,
    ]),
    [
      Config.node.replace(Config.testLayer()),
      Global.node.replace(globalLayer),
      Location.node.replace(Location.boundNode({ directory })),
      Mcp.node.replace(
        Layer.mock(Mcp.Service, {
          tools: () => Effect.succeed(testMcpTools),
          instructions: () => Effect.succeed(mcpCatalog),
        }),
      ),
      Model.node.replace(modelCatalog),
      SessionRunnerModel.node.replace(runnerModel),
      InstructionBuiltIns.node.replace(Layer.mock(InstructionBuiltIns.Service, { load: () => noopInstructions })),
      InstructionDiscovery.node.replace(
        Layer.mock(InstructionDiscovery.Service, { project: true, global: true, load: () => noopInstructions }),
      ),
      SkillInstructions.node.replace(Layer.mock(SkillInstructions.Service, { load: () => noopInstructions })),
      ReferenceInstructions.node.replace(Layer.mock(ReferenceInstructions.Service, { load: () => noopInstructions })),
      PluginSupervisor.node.replace(Layer.empty),
      SessionExternalWait.node.replace(Layer.mock(SessionExternalWait.Service, { clearSession: () => Effect.void })),
      ToolOutput.node.replace(Layer.succeed(ToolOutput.Service, ToolOutput.Service.of({} as ToolOutput.Interface))),
    ],
  ),
)

const setupPlugins = Effect.gen(function* () {
  const agents = yield* Agent.Service
  const tools = yield* Tool.Service
  const hooks = yield* PluginHooks.Service
  const ctx = host({
    agent: agentHost(agents),
    tool: {
      list: () => tools.list(),
      transform: (callback) => tools.transform(callback),
      reload: tools.reload,
      hook: (name, callback) => hooks.register("tool", name, callback).pipe(Effect.as({ dispose: Effect.void })),
    },
    event: { subscribe: () => Stream.empty },
    session: {
      hook: (name, callback) =>
        hooks.register("session", name, callback as never).pipe(Effect.as({ dispose: Effect.void })),
      synthetic: () => Effect.die(new Error("unused synthetic")),
    },
  })
  yield* AgentPlugin.Plugin.effect(ctx)
  yield* PlanPlugin.Plugin.effect(ctx).pipe(Effect.provideService(Environment.Service, envService))
  const mcpTools = yield* McpTool.Service
  yield* mcpTools.flush
})

const seedSession = Effect.fnUntraced(function* (input: {
  readonly id: Session.ID
  readonly agent: Agent.ID
  readonly permission: Permission.Ruleset
  readonly authority?: ReadonlyArray<Permission.Ruleset>
}) {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: input.id,
      project_id: Project.ID.global,
      slug: input.id,
      directory,
      title: input.id,
      version: "test",
      agent: input.agent,
      permission: [...input.permission],
      ...(input.authority === undefined ? {} : { authority: input.authority.map((rules) => [...rules]) }),
    })
    .run()
    .pipe(Effect.orDie)
})

const threadAPermissions: Permission.Ruleset = [
  { action: "t3-code-*", resource: "*", effect: "deny" },
  { action: `${threadAServer}_*`, resource: "*", effect: "allow" },
  { action: `${longThreadServer}_*`, resource: "*", effect: "allow" },
]

const fullAccessThreadAPermissions: Permission.Ruleset = [
  { action: "*", resource: "*", effect: "allow" },
  ...threadAPermissions,
]

describe("T3 Code per-thread policy enforcement across SessionContext and Permission.Service", () => {
  const longReadOnlyID = McpTool.directName(longThreadServer, "list_thread_pull_requests")
  const longMutatingID = McpTool.directName(longThreadServer, "t3_worktree_handoff")
  const longDelegateID = McpTool.directName(longThreadServer, "delegate_task")
  const spoofDelegateID = McpTool.directName(spoofServer, "delegate_task")

  it.effect("keeps catalog visibility and call-time checks aligned for plan, explore, review, compaction, and build", () =>
    Effect.gen(function* () {
      expect(longReadOnlyID.startsWith("m_")).toBe(true)
      expect(longMutatingID.startsWith("m_")).toBe(true)
      expect(longDelegateID.startsWith("m_")).toBe(true)

      yield* setupPlugins
      const context = yield* SessionContext.Service
      const permissions = yield* Permission.Service
      const tools = yield* Tool.Service
      const registeredTools = new Map((yield* tools.list()).map((tool) => [tool.id, tool]))

      const askEffect = (sessionID: Session.ID, action: string, resource = "*") =>
        permissions
          .ask({
            id: Permission.ID.create(),
            sessionID,
            action,
            resources: [resource],
          })
          .pipe(Effect.map((result) => result.effect))

      // 1a. Plan agent with T3 restricted-mode permissions (no `* -> allow`): denies spoof & mutating host tools
      const planRestrictedID = Session.ID.make("ses_t3_plan_restricted")
      yield* seedSession({
        id: planRestrictedID,
        agent: Agent.ID.make("plan"),
        permission: [
          ...threadAPermissions,
          { action: "edit", resource: "*", effect: "deny" },
          { action: "edit", resource: "/tmp/t3-plan.md", effect: "allow" },
        ],
      })
      const planRestrictedSelection = yield* context.select(planRestrictedID)
      const planRestrictedToolNames = planRestrictedSelection.tools.definitions.map((def) => def.name)
      const planRestrictedMcpText = (yield* readInitial(planRestrictedSelection.instructions)).text
      expect(planRestrictedToolNames).toContain(`${threadAServer}_pull_request_read`)
      expect(planRestrictedToolNames).not.toContain(`${spoofServer}_pull_request_read`)
      expect(planRestrictedToolNames).not.toContain(spoofDelegateID)
      expect(planRestrictedMcpText).not.toContain(spoofServer)
      expect(yield* askEffect(planRestrictedID, `mcp_${spoofServer}_pull_request_read`)).toBe("deny")

      // 1b. Plan agent with T3 full-access permissions + custom plan edit path
      const planID = Session.ID.make("ses_t3_plan")
      yield* seedSession({
        id: planID,
        agent: Agent.ID.make("plan"),
        permission: [
          ...fullAccessThreadAPermissions,
          { action: "edit", resource: "*", effect: "deny" },
          { action: "edit", resource: "/tmp/t3-plan.md", effect: "allow" },
        ],
      })
      const planSelection = yield* context.select(planID)
      const planToolNames = planSelection.tools.definitions.map((def) => def.name)
      const planMcpText = (yield* readInitial(planSelection.instructions)).text

      expect(planToolNames).toContain(`${threadAServer}_pull_request_read`)
      expect(planToolNames).toContain(`${threadAServer}_t3_project_read`)
      expect(planToolNames).toContain(`${threadAServer}_preview_wait_for`)
      expect(planToolNames).toContain(`${threadAServer}_t3_background_wait`)
      expect(planToolNames).toContain(`${threadAServer}_t3_thread_wait`)
      expect(planToolNames).toContain(`${threadAServer}_t3_submit_output`)
      expect(planToolNames).toContain(`${threadAServer}_send_to_user`)
      expect(planToolNames).toContain(longReadOnlyID)

      expect(planToolNames).not.toContain(`${threadAServer}_preview_snapshot`)
      expect(planToolNames).not.toContain(`${threadAServer}_pull_request_merge`)
      expect(planToolNames).not.toContain(`${threadAServer}_t3_worktree_remove`)
      expect(planToolNames).not.toContain(`${threadAServer}_delegate_task`)
      expect(planToolNames).not.toContain(longMutatingID)
      expect(planToolNames).not.toContain(`${threadBServer}_pull_request_read`)
      expect(planToolNames).not.toContain(`${threadBServer}_pull_request_merge`)

      expect(planMcpText).toContain(threadAServer)
      expect(planMcpText).toContain(longThreadServer)
      expect(planMcpText).not.toContain(threadBServer)

      expect(yield* askEffect(planID, "edit", "/tmp/t3-plan.md")).toBe("allow")
      expect(yield* askEffect(planID, `${threadAServer}_t3_submit_output`)).toBe("allow")
      expect(yield* askEffect(planID, `${longThreadServer}_list_thread_pull_requests`)).toBe("allow")
      expect(yield* askEffect(planID, `${threadAServer}_preview_snapshot`)).toBe("deny")
      expect(yield* askEffect(planID, `${threadAServer}_pull_request_merge`)).toBe("deny")
      expect(yield* askEffect(planID, `${longThreadServer}_t3_worktree_handoff`)).toBe("deny")
      expect(yield* askEffect(planID, `${threadBServer}_pull_request_read`)).toBe("deny")

      // 2. Explore agent with T3 permissions
      const exploreID = Session.ID.make("ses_t3_explore")
      yield* seedSession({
        id: exploreID,
        agent: Agent.ID.make("explore"),
        permission: threadAPermissions,
      })
      const exploreSelection = yield* context.select(exploreID)
      const exploreToolNames = exploreSelection.tools.definitions.map((def) => def.name)
      expect(exploreToolNames).toContain(`${threadAServer}_pull_request_read`)
      expect(exploreToolNames).toContain(`${threadAServer}_t3_project_read`)
      expect(exploreToolNames).toContain(`${threadAServer}_t3_preview_list`)
      expect(exploreToolNames).toContain(`${threadAServer}_preview_wait_for`)
      expect(exploreToolNames).toContain(`${threadAServer}_t3_background_wait`)
      expect(exploreToolNames).toContain(`${threadAServer}_t3_thread_wait`)
      expect(exploreToolNames).not.toContain(`${threadAServer}_send_to_user`)
      expect(exploreToolNames).not.toContain(`${threadAServer}_t3_submit_output`)
      expect(exploreToolNames).not.toContain(`${threadAServer}_preview_snapshot`)
      expect(exploreToolNames).not.toContain(`${threadAServer}_pull_request_merge`)
      expect(exploreToolNames).not.toContain(`${threadBServer}_pull_request_read`)

      expect(yield* askEffect(exploreID, `${threadAServer}_t3_preview_list`)).toBe("allow")
      expect(yield* askEffect(exploreID, `${threadAServer}_send_to_user`)).toBe("deny")
      expect(yield* askEffect(exploreID, `${threadAServer}_t3_submit_output`)).toBe("deny")
      expect(yield* askEffect(exploreID, `${threadAServer}_pull_request_merge`)).toBe("deny")
      expect(yield* askEffect(exploreID, `${threadBServer}_pull_request_read`)).toBe("deny")

      // 3. Review agent (both direct subagent without session authority and /review authority)
      for (const reviewCase of [
        { id: Session.ID.make("ses_t3_review_direct"), authority: undefined },
        { id: Session.ID.make("ses_t3_review_authority"), authority: [ReviewAuthority.rules] },
      ]) {
        yield* seedSession({
          id: reviewCase.id,
          agent: Agent.ID.make("review"),
          permission: fullAccessThreadAPermissions,
          authority: reviewCase.authority,
        })
        const reviewSelection = yield* context.select(reviewCase.id)
        const reviewToolNames = reviewSelection.tools.definitions.map((def) => def.name)
        expect(reviewToolNames).toContain(`${threadAServer}_pull_request_read`)
        expect(reviewToolNames).toContain(`${threadAServer}_t3_project_read`)
        expect(reviewToolNames).toContain(longReadOnlyID)
        expect(reviewToolNames).not.toContain(`${threadAServer}_t3_preview_list`)
        expect(reviewToolNames).not.toContain(`${threadAServer}_send_to_user`)
        expect(reviewToolNames).not.toContain(`${threadAServer}_t3_submit_output`)
        expect(reviewToolNames).not.toContain(`${threadAServer}_pull_request_merge`)
        expect(reviewToolNames).not.toContain(longMutatingID)
        expect(reviewToolNames).not.toContain(`${threadBServer}_pull_request_read`)

        expect(yield* askEffect(reviewCase.id, `${threadAServer}_t3_project_read`)).toBe("allow")
        expect(yield* askEffect(reviewCase.id, `${threadAServer}_t3_preview_list`)).toBe("deny")
        expect(yield* askEffect(reviewCase.id, `${threadAServer}_pull_request_merge`)).toBe("deny")
        expect(yield* askEffect(reviewCase.id, `${threadBServer}_pull_request_read`)).toBe("deny")
      }

      // 4. Compaction agent: zero t3-code* tools and zero MCP instructions under both default and full-access rules
      const compactionRestrictedID = Session.ID.make("ses_t3_compaction_restricted")
      yield* seedSession({
        id: compactionRestrictedID,
        agent: Agent.ID.make("compaction"),
        permission: threadAPermissions,
      })
      const compactionRestrictedSelection = yield* context.select(compactionRestrictedID)
      expect(compactionRestrictedSelection.tools.definitions).toEqual([])
      expect((yield* readInitial(compactionRestrictedSelection.instructions)).text).not.toContain("<mcp_instructions>")

      const compactionID = Session.ID.make("ses_t3_compaction")
      yield* seedSession({
        id: compactionID,
        agent: Agent.ID.make("compaction"),
        permission: fullAccessThreadAPermissions,
      })
      const compactionSelection = yield* context.select(compactionID)
      const compactionNames = compactionSelection.tools.definitions.map((def) => def.name)
      expect(
        compactionNames.filter((defName) => defName !== "execute" && !defName.startsWith(`${spoofServer}_`)),
      ).toEqual([])
      expect(compactionSelection.tools.codeModeCatalog?.tools ?? []).toEqual([])
      const compactionMcpText = (yield* readInitial(compactionSelection.instructions)).text
      expect(compactionMcpText).not.toContain(threadAServer)
      expect(compactionMcpText).not.toContain(longThreadServer)
      expect(compactionMcpText).not.toContain(threadBServer)
      expect(yield* askEffect(compactionID, `${threadAServer}_pull_request_read`)).toBe("deny")
      expect(yield* askEffect(compactionID, `${threadAServer}_pull_request_merge`)).toBe("deny")

      // 5. Build agent: retains full Thread A access while Thread B remains denied
      const buildID = Session.ID.make("ses_t3_build")
      yield* seedSession({
        id: buildID,
        agent: Agent.ID.make("build"),
        permission: fullAccessThreadAPermissions,
      })
      const buildSelection = yield* context.select(buildID)
      const buildToolNames = buildSelection.tools.definitions.map((def) => def.name)
      const buildMcpText = (yield* readInitial(buildSelection.instructions)).text
      expect(buildToolNames).toContain(`${threadAServer}_pull_request_merge`)
      expect(buildToolNames).toContain(`${threadAServer}_delegate_task`)
      expect(buildToolNames).toContain(`${threadAServer}_preview_snapshot`)
      expect(buildToolNames).toContain(longMutatingID)
      expect(buildToolNames).toContain(longDelegateID)
      expect(buildToolNames).not.toContain(`${threadBServer}_pull_request_read`)
      expect(buildToolNames).not.toContain(`${threadBServer}_pull_request_merge`)
      expect(buildMcpText).toContain(threadAServer)
      expect(buildMcpText).not.toContain(threadBServer)

      // Host delegate_task detection resolves aliased long host names and rejects demoted spoofs.
      expect(SubagentTool.hasHostDelegation({ [longDelegateID]: {} }, registeredTools)).toBe(true)
      expect(SubagentTool.hasHostDelegation({ [spoofDelegateID]: {} }, registeredTools)).toBe(false)
      expect(
        SubagentTool.hasHostDelegation(
          Object.fromEntries(planToolNames.map((toolName) => [toolName, {}])),
          registeredTools,
        ),
      ).toBe(false)

      expect(yield* askEffect(buildID, `${threadAServer}_pull_request_merge`)).toBe("allow")
      expect(yield* askEffect(buildID, `${longThreadServer}_t3_worktree_handoff`)).toBe("allow")
      expect(yield* askEffect(buildID, `${threadBServer}_pull_request_read`)).toBe("deny")
    }),
  )
})
