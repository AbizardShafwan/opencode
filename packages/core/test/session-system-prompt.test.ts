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
  test("bundles the pinned engineering and visual policies", () => {
    // Digests and adaptation history are recorded in runner/prompt/README.md.
    expect(createHash("sha256").update(POLICY).digest("hex")).toBe(
      "23e1499cc873ade8cd5eb41a8b369587036d1dd64d8f553f69f09675e3f9752f",
    )
    expect(createHash("sha256").update(VISUAL_POLICY).digest("hex")).toBe(
      "67054ce461e1db2d0a086a4d255f9e75a55901d332230dea8ee66c2c8ae69cf7",
    )
    expect(SessionSystemPrompt.make()).toBe(`${POLICY}\n${VISUAL_POLICY}`)
    expect(SessionSystemPrompt.make()).toContain("<visual_verification>")
    expect(SessionSystemPrompt.make()).toContain("inspect the resulting image with the read tool")
    expect(SessionSystemPrompt.make()).toContain("Do not substitute a mockup for a screenshot")
    expect(VISUAL_POLICY).toContain(
      "Host or tool contracts that forbid unrequested preview or browser captures take precedence over this proactive self-verification.",
    )
    expect(VISUAL_POLICY).toContain("`html_preview` followed by `html_render`")
    expect(VISUAL_POLICY).toContain("Screen and video recordings are user-facing artifacts only")
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
