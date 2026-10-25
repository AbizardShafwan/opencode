import { describe, expect, test } from "bun:test"
import { ToolDefinition } from "@opencode/ai"
import { AnthropicMessages, OpenAIResponses, OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/schema/agent"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"
import { DateTime, Effect } from "effect"
import { SessionMessage } from "@opencode/core/session/message"
import { createHash } from "crypto"
import CODEX_POLICY from "../src/session/runner/prompt/system.txt"

const transcript = (id: string, system?: string, tools: string[] = []) =>
  SessionModelRequest.baseTranscript({
    agent: { ...Agent.Info.default(Agent.ID.make("build")), system },
    model: SessionRunnerModel.resolved(OpenAIChat.route.model({ id, provider: "test" }), {
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      cost: [],
      limit: { context: 200_000, output: 32_000 },
    }),
    tools: {
      definitions: tools.map(
        (name) => new ToolDefinition({ name, description: name, inputSchema: { type: "object" } }),
      ),
      execute: () => Effect.die("not executed"),
    },
    initial: "Project instructions",
    messages: [],
  })

describe("Codex system policy", () => {
  test("bundles the exact local Codex engineering policy", () => {
    // Source digest is recorded in runner/prompt/README.md; no external checkout is needed at runtime or in CI.
    expect(createHash("sha256").update(CODEX_POLICY).digest("hex")).toBe(
      "eb708da445b093cfd961cb6d9a428791c7ec593eb31e0f0143ea268f2a2a2afd",
    )
    expect(SessionSystemPrompt.make().startsWith(CODEX_POLICY)).toBe(true)
    expect(SessionSystemPrompt.make()).toContain("<visual_verification>")
    expect(SessionSystemPrompt.make()).toContain("inspect the resulting image with the read tool")
    expect(SessionSystemPrompt.make()).toContain("Do not substitute a mockup for a screenshot")
  })

  test.each(["gpt-6-astra", "claude-opus-4-8", "kimi-k2", "trinity", "meta/muse", "deepseek-v4-flash", "unknown"])(
    "uses the same policy for %s",
    (id) => {
      expect(transcript(id).system.map((part) => part.text)).toEqual([
        SessionSystemPrompt.make(),
        "Project instructions",
      ])
    },
  )

  test("tool availability does not rewrite the base policy", () => {
    expect(transcript("test", undefined, ["shell", "write", "edit"]).system).toEqual(transcript("test").system)
  })

  test("preserves literal custom agent overrides", () => {
    expect(transcript("gpt-6", "Custom policy").system.map((part) => part.text)).toEqual([
      "Custom policy",
      "Project instructions",
    ])
  })
})

test("keeps native policy updates in history and consolidates them on leading-only routes", () => {
  const update = SessionMessage.System.make({
    id: SessionMessage.ID.make("msg_policy_update"),
    type: "system",
    text: "Current policy",
    metadata: { instructionSources: [SessionSystemPrompt.key] },
    time: { created: DateTime.makeUnsafe(0) },
  })
  const context = SessionMessage.System.make({
    ...update,
    id: SessionMessage.ID.make("msg_context_update"),
    text: "New project context",
    metadata: { instructionSources: ["test/project"] },
  })
  const cases = [
    { route: OpenAIChat.route, id: "deepseek-v4-flash", native: false },
    { route: OpenAIResponses.route, id: "gpt-6", native: true },
    { route: AnthropicMessages.route, id: "claude-sonnet-4-6", native: false },
    { route: AnthropicMessages.route, id: "claude-opus-4-8", native: true },
  ]
  for (const item of cases) {
    const result = SessionModelRequest.baseTranscript({
      agent: { ...Agent.Info.default(Agent.ID.make("build")), system: "Current policy" },
      model: SessionRunnerModel.resolved(item.route.model({ id: item.id, provider: "test" }), {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      }),
      tools: { definitions: [], execute: () => Effect.die("not executed") },
      policy: "Initial policy",
      initial: "Project context",
      messages: [update, context],
    })
    expect(result.system[0]?.text).toBe(item.native ? "Initial policy" : "Current policy")
    expect(result.messages.map((message) => message.content)).toEqual(
      (item.native ? ["Current policy", "New project context"] : ["New project context"]).map((text) => [
        { type: "text", text },
      ]),
    )
  }
})
