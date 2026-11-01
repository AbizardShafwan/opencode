import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "../src/promise"
import { compactionSettings, lastAssistantWithUsage } from "../src/solid/usage"

test("compaction fields merge independently across config documents, including explicit zero", () => {
  const entries = [
    { type: "document" as const, info: { compaction: { soft_limits: { "provider/model": 372_000 }, buffer: 8_000 } } },
    { type: "document" as const, info: { compaction: { default_soft_limit: 250_000 } } },
  ]
  expect(compactionSettings(entries, "provider/model")).toEqual({
    modelLimit: 372_000,
    defaultLimit: 250_000,
    buffer: 8_000,
  })
  expect(
    compactionSettings(
      [...entries, { type: "document", info: { compaction: { soft_limits: { "provider/model": 0 }, buffer: 0 } } }],
      "provider/model",
    ),
  ).toEqual({ modelLimit: 0, defaultLimit: 250_000, buffer: 0 })
})

const assistant = (id: string, input: number): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: [],
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0 },
})

describe("lastAssistantWithUsage", () => {
  test("tracks usage across undo and redo boundaries", () => {
    const messages = [assistant("msg_z", 10), assistant("msg_a", 30)]

    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(30)
    expect(lastAssistantWithUsage(messages, "msg_a")?.tokens.input).toBe(10)
    expect(lastAssistantWithUsage(messages, "msg_missing")).toBeUndefined()
    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(30)
  })

  test("resets usage at completed compaction until the next assistant reports it", () => {
    const compaction: SessionMessageInfo = {
      id: "msg_compaction",
      type: "compaction",
      status: "completed",
      reason: "manual",
      summary: "Current state",
      time: { created: 0 },
    }

    const messages = [assistant("msg_before", 30), compaction]

    expect(lastAssistantWithUsage(messages)).toBeUndefined()

    messages.push(assistant("msg_after", 5))
    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(5)
  })
})
