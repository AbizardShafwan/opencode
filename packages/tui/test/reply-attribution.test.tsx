import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { waitForHighlightedFrame } from "./fixture/frame"
import { thinkingLabel } from "../src/util/model"

test("thinking labels distinguish defaults, historical settings, and budgets", () => {
  expect(thinkingLabel({})).toBe("Thinking: provider default")
  expect(thinkingLabel(undefined, "high")).toBe("Thinking: unrecorded (variant high)")
  expect(thinkingLabel({ mode: "disabled" })).toBe("Thinking: disabled")
  expect(thinkingLabel({ mode: "enabled", budget: 4096 })).toBe("Thinking: enabled · budget 4096")
})

test.each([24, 100])("shows historical reply attribution at %i columns without hovering", async (width) => {
  const session = {
    id: "ses_attribution",
    title: "Reply attribution",
    projectID: "project",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 2 },
    model: { providerID: "demo", id: "new-model", variant: "low" },
  }
  const message = {
    type: "assistant",
    id: "msg_reply",
    agent: "build",
    model: { providerID: "demo", id: "old-model" },
    thinking: { effort: "high" },
    content: [{ type: "text", text: "Verified reply" }],
    time: { created: 1 },
  }
  await using setup = await createAppFixture({
    width,
    height: 35,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { enabled: false } },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [message], cursor: {} })
      if (
        url.pathname === `/api/session/${session.id}/inbox` ||
        url.pathname === `/api/session/${session.id}/permission`
      )
        return json({ data: [] })
    },
  })
  await waitForHighlightedFrame(setup, (frame) => frame.includes("Verified reply") && frame.includes("old-model"))
  expect(setup.captureCharFrame().replace(/\s+/g, " ")).toContain("Thinking: high")
})
