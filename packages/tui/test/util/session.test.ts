import { describe, expect, test } from "bun:test"
import { sessionFamily, contextUsage } from "../../src/util/session"
import type { ModelInfo, SessionMessageAssistant } from "@opencode/client"

describe("util.session", () => {
  test("flattens nested subagents from any session in the family", () => {
    const sessions = [
      { id: "root" },
      { id: "child-a", parentID: "root" },
      { id: "grandchild-a", parentID: "child-a" },
      { id: "great-grandchild-a", parentID: "grandchild-a" },
      { id: "grandchild-a2", parentID: "child-a" },
      { id: "child-b", parentID: "root" },
      { id: "grandchild-b", parentID: "child-b" },
    ]

    expect(sessionFamily(sessions, "great-grandchild-a")).toEqual([
      { session: sessions[1], prefix: "" },
      { session: sessions[2], prefix: "├─ " },
      { session: sessions[3], prefix: "│  └─ " },
      { session: sessions[4], prefix: "└─ " },
      { session: sessions[5], prefix: "" },
      { session: sessions[6], prefix: "└─ " },
    ])
  })

  test("calculates context usage with hard limit and soft limit clamping", () => {
    const message = {
      id: "msg_1",
      type: "assistant" as const,
      agent: "build",
      content: [],
      model: { providerID: "anthropic", id: "claude-3-7-sonnet" },
      text: "hello",
      tokens: {
        input: 90_000,
        output: 10_000,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: { created: Date.now() },
    } as SessionMessageAssistant
    const model = {
      id: "claude-3-7-sonnet",
      modelID: "claude-3-7-sonnet",
      providerID: "anthropic",
      name: "Claude 3.7 Sonnet",
      limit: { context: 1_000_000, output: 8192 },
      cost: [],
      variants: [],
      status: "active" as const,
      capabilities: { tools: true, input: [], output: [] },
      time: { released: Date.now() },
      enabled: true,
    } as ModelInfo
    const models = [model]

    // Total tokens = 100k
    // 1. Without soft limit: 100k / 1M = 10%
    const defaultUsage = contextUsage([message], models)
    expect(defaultUsage).toEqual({ tokens: 100_000, percent: 10 })

    // 2. With soft limit = 200k: 100k / 200k = 50%
    const softUsage = contextUsage([message], models, undefined, 200_000)
    expect(softUsage).toEqual({ tokens: 100_000, percent: 50 })

    // 3. With soft limit = 2M (exceeds hard limit 1M): clamped to 1M -> 10%
    const clampedUsage = contextUsage([message], models, undefined, 2_000_000)
    expect(clampedUsage).toEqual({ tokens: 100_000, percent: 10 })

    const configs = [
      {
        type: "document" as const,
        info: {
          compaction: {
            soft_limits: { "anthropic/claude-3-7-sonnet": 372_000 },
            default_soft_limit: 250_000,
          },
        },
      },
    ]
    expect(contextUsage([message], models, undefined, undefined, configs)).toEqual({ tokens: 100_000, percent: 27 })
    expect(contextUsage([message], models, undefined, 200_000, configs)).toEqual({ tokens: 100_000, percent: 50 })
    expect(
      contextUsage([message], models, undefined, undefined, [
        { type: "document", info: { compaction: { default_soft_limit: 250_000 } } },
      ]),
    ).toEqual({ tokens: 100_000, percent: 40 })
  })

  test("contextUsage handles model switch transition clamping and restoration", () => {
    const claudeModel = {
      id: "claude-3-7-sonnet",
      modelID: "claude-3-7-sonnet",
      providerID: "anthropic",
      name: "Claude 3.7 Sonnet",
      limit: { context: 1_000_000, output: 8192 },
      cost: [],
      variants: [],
      status: "active" as const,
      capabilities: { tools: true, input: [], output: [] },
      time: { released: Date.now() },
      enabled: true,
    } as ModelInfo

    const gptModel = {
      id: "gpt-4o",
      modelID: "gpt-4o",
      providerID: "openai",
      name: "GPT-4o",
      limit: { context: 128_000, output: 4096 },
      cost: [],
      variants: [],
      status: "active" as const,
      capabilities: { tools: true, input: [], output: [] },
      time: { released: Date.now() },
      enabled: true,
    } as ModelInfo

    const models = [claudeModel, gptModel]
    const softLimit = 372_000

    const claudeMessage = {
      id: "msg_claude",
      type: "assistant" as const,
      agent: "build",
      content: [],
      model: { providerID: "anthropic", id: "claude-3-7-sonnet" },
      text: "hello from claude",
      tokens: { input: 60_000, output: 4_000, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now() },
    } as SessionMessageAssistant

    const gptMessage = {
      id: "msg_gpt",
      type: "assistant" as const,
      agent: "build",
      content: [],
      model: { providerID: "openai", id: "gpt-4o" },
      text: "hello from gpt",
      tokens: { input: 60_000, output: 4_000, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now() },
    } as SessionMessageAssistant

    // Total tokens = 64,000
    // 1. On Claude 3.7 (1M): soft limit 372k is active. 64k / 372k = 17%
    const claudeUsage = contextUsage([claudeMessage], models, undefined, softLimit)
    expect(claudeUsage).toEqual({ tokens: 64_000, percent: 17 })

    // 2. Switch to GPT-4o (128k): soft limit 372k is clamped to hard limit 128k. 64k / 128k = 50%
    const gptUsage = contextUsage([gptMessage], models, undefined, softLimit)
    expect(gptUsage).toEqual({ tokens: 64_000, percent: 50 })

    // 3. Switch back to Claude 3.7 (1M): soft limit 372k is restored. 64k / 372k = 17%
    const restoredUsage = contextUsage([claudeMessage], models, undefined, softLimit)
    expect(restoredUsage).toEqual({ tokens: 64_000, percent: 17 })
  })
})
