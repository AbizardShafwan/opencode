import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "../src/config.js"
import { ConfigAgent } from "../src/config/agent.js"
import { ConfigCompaction } from "../src/config/compaction.js"
import { ConfigMCP } from "../src/config/mcp.js"
import { ConfigProvider } from "../src/config/provider.js"
import { Mcp } from "../src/mcp.js"
import { Provider } from "../src/provider.js"
import { AbsolutePath } from "../src/schema.js"
import { WebSearch } from "../src/websearch.js"

describe("Config.Entry", () => {
  test("round-trips tool.use and rejects unsupported action spellings", () => {
    const input = {
      experimental: {
        policies: [
          { action: "tool.use", resource: "shell:*", effect: "deny" },
          { action: "tool.use", resource: "shell:git *", effect: "allow" },
        ],
      },
    } as const
    const decoded = Schema.decodeUnknownSync(Config.Info)(input)
    expect(Schema.encodeSync(Config.Info)(decoded)).toEqual(input)
    for (const action of ["permission", "tool.execute"])
      expect(() =>
        Schema.decodeUnknownSync(Config.Info)({
          experimental: { policies: [{ action, resource: "*", effect: "deny" }] },
        }),
      ).toThrow()
  })

  test("accepts directory-only worktree config and omits it when absent", () => {
    const decode = Schema.decodeUnknownSync(Config.Info)
    const input = { worktree: { directory: "../worktrees" } }
    expect(Schema.encodeSync(Config.Info)(decode(input))).toEqual(input)
    expect(Schema.encodeSync(Config.Info)(new Config.Info({ worktree: undefined }))).not.toHaveProperty("worktree")
    expect(() => decode({ worktree: {} })).toThrow()
    expect(() => decode({ worktree: { directory: " " } })).toThrow()
    expect(() => decode({ worktree: { directory: false } })).toThrow()
  })
  test("round-trips canonical provider IDs without changing config keys", () => {
    const input = { providers: { "console-anthropic": { canonical: "anthropic" } } }
    const decoded = Schema.decodeUnknownSync(Config.Info)(input)
    expect(decoded.providers?.["console-anthropic"]?.canonical).toBe(Provider.ID.anthropic)
    expect(Schema.encodeSync(Config.Info)(decoded)).toEqual(input)
    expect(() => Schema.decodeUnknownSync(Config.Info)({ providers: { custom: { canonical: 1 } } })).toThrow()
  })

  test("round-trips disabled and numeric provider HTTP timeouts", () => {
    const input = {
      providers: { custom: { settings: { timeout: 900_000, headerTimeout: 600_000, chunkTimeout: false } } },
    } as const
    const decoded = Schema.decodeUnknownSync(Config.Info)(input)
    expect(Schema.encodeSync(Config.Info)(decoded)).toEqual(input)
    expect(Schema.decodeUnknownSync(Provider.Settings)(decoded.providers?.custom?.settings)).toMatchObject({
      timeout: 900_000,
      headerTimeout: 600_000,
      chunkTimeout: false,
    })
    expect(Schema.decodeUnknownSync(Provider.Settings)({ headerTimeout: false, chunkTimeout: 600_000 })).toMatchObject({
      headerTimeout: false,
      chunkTimeout: 600_000,
    })
  })

  test("accepts disabled, fixed, and random web search selection", () => {
    const decode = Schema.decodeUnknownSync(Config.Info)

    expect(decode({ websearch: false }).websearch).toBe(false)
    expect(decode({ websearch: { provider: "exa" } }).websearch).toEqual({ provider: WebSearch.ID.make("exa") })
    expect(decode({ websearch: { provider: "random" } }).websearch).toEqual({ provider: "random" })
  })

  test("round-trips every configuration entry type", () => {
    const entries = [
      new Config.Document({
        type: "document",
        path: AbsolutePath.make("/project/opencode.json"),
        info: new Config.Info({
          permissions: [
            { action: "shell", resource: "*", effect: "ask" },
            { action: "shell", resource: "git status", effect: "allow" },
          ],
        }),
      }),
      new Config.Document({ type: "document", info: new Config.Info({ shell: "/bin/zsh" }) }),
      new Config.Directory({ type: "directory", path: AbsolutePath.make("/project/.opencode") }),
    ]

    const encoded = Schema.encodeSync(Schema.Array(Config.Entry))(entries)
    const decoded = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(encoded)

    expect(decoded).toEqual(entries)
    expect(decoded[0]).toBeInstanceOf(Config.Document)
    expect(decoded[1]).not.toHaveProperty("path")
    expect(decoded.map((entry) => entry.type)).toEqual(["document", "document", "directory"])
    expect(decoded[0]?.type === "document" ? decoded[0].info.permissions : undefined).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status", effect: "allow" },
    ])
  })

  test("has a stable public identifier", () => {
    expect(Config.Entry.ast.annotations?.identifier).toBe("Config.Entry")
  })

  test("omits undefined optional properties while encoding", () => {
    const entry = new Config.Document({
      type: "document",
      path: undefined,
      info: new Config.Info({
        default_agent: undefined,
        agents: { reviewer: new ConfigAgent.Info({ description: undefined }) },
        mcp: new ConfigMCP.Info({
          timeout: undefined,
          servers: {
            docs: new Mcp.RemoteConfig({
              type: "remote",
              url: "https://example.com/mcp",
              headers: undefined,
              oauth: new Mcp.OAuthConfig({ client_id: undefined }),
            }),
          },
        }),
        providers: { custom: new ConfigProvider.Info({ canonical: undefined, headers: undefined }) },
      }),
    })
    const encoded = Schema.encodeSync(Config.Entry)(entry)
    if (encoded.type !== "document") throw new Error("Expected a config document")

    expect(encoded).not.toHaveProperty("path")
    expect(encoded.info).not.toHaveProperty("default_agent")
    expect(encoded.info.agents?.reviewer).not.toHaveProperty("description")
    expect(encoded.info.mcp).not.toHaveProperty("timeout")
    const docs = encoded.info.mcp?.servers?.docs
    if (docs?.type !== "remote" || docs.oauth === false) throw new Error("Expected a remote MCP server")
    expect(docs).not.toHaveProperty("headers")
    expect(docs.oauth).not.toHaveProperty("client_id")
    expect(encoded.info.providers?.custom).not.toHaveProperty("headers")
    expect(encoded.info.providers?.custom).not.toHaveProperty("canonical")
  })

  test("accepts compaction soft limits and omits when undefined", () => {
    const decode = Schema.decodeUnknownSync(ConfigCompaction.Info)
    const input = {
      default_soft_limit: 372_000,
      soft_limits: {
        "anthropic/claude-3-7-sonnet": 372_000,
        "openai/gpt-4o": 128_000,
      },
    }
    const decoded = decode(input)
    expect(decoded.default_soft_limit).toBe(372_000)
    expect(decoded.soft_limits?.["anthropic/claude-3-7-sonnet"]).toBe(372_000)
    expect(Schema.encodeSync(ConfigCompaction.Info)(decoded)).toEqual(input)

    const empty = decode({})
    const encoded = Schema.encodeSync(ConfigCompaction.Info)(empty)
    expect(encoded).not.toHaveProperty("default_soft_limit")
    expect(encoded).not.toHaveProperty("soft_limits")

    expect(() => decode({ default_soft_limit: -1 })).toThrow()
    expect(() => decode({ soft_limits: { "model/a": -1 } })).toThrow()
  })

  test("validates Config.Patch with shell and softLimit fields", () => {
    const decode = Schema.decodeUnknownSync(Config.Patch)

    expect(decode({})).toEqual({})
    expect(decode({ shell: "/bin/bash" })).toEqual({ shell: "/bin/bash" })
    expect(decode({ shell: null })).toEqual({ shell: null })

    const patchWithLimit = decode({
      softLimit: { modelKey: "anthropic/claude-3-7-sonnet", limit: 372_000 },
    })
    expect(patchWithLimit).toEqual({
      softLimit: { modelKey: "anthropic/claude-3-7-sonnet", limit: 372_000 },
    })

    const patchClearLimit = decode({
      softLimit: { modelKey: "anthropic/claude-3-7-sonnet", limit: null },
    })
    expect(patchClearLimit).toEqual({
      softLimit: { modelKey: "anthropic/claude-3-7-sonnet", limit: null },
    })

    expect(() => decode({ softLimit: { modelKey: "test", limit: -100 } })).toThrow()
  })
})
