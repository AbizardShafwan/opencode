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
import POLICY from "../src/session/runner/prompt/system.txt"
import VISUAL_POLICY from "../src/session/runner/prompt/visual-verification.txt"

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

describe("Memyr system policy", () => {
  test("bundles the pinned lean engineering and visual policies", () => {
    // Digests and adaptation history are recorded in runner/prompt/README.md.
    expect(createHash("sha256").update(POLICY).digest("hex")).toBe(
      "c5fa9b9f8f5a30c69d094b95ba15070ab16c400cd159df9ae70fd34b6ffe0436",
    )
    expect(createHash("sha256").update(VISUAL_POLICY).digest("hex")).toBe(
      "8bfbb5d25ed5decf81a7320715125c58943570ab11db8a63ce902fda07170243",
    )
    expect(SessionSystemPrompt.make()).toBe(`${POLICY}\n${VISUAL_POLICY}`)
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
