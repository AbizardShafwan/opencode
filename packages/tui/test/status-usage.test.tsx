/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { UsageInfo } from "@opencode/client"
import { DialogStatus } from "../src/component/dialog-status"
import { model, renderLocal } from "./fixture/local"
import { json } from "./fixture/tui-client"

const balance: UsageInfo = {
  providerID: "deepseek",
  source: "deepseek-balance",
  fetchedAt: 0,
  balances: [{ currency: "USD", total: "27.02", granted: "0.00", toppedUp: "27.02" }],
}

const antigravity: UsageInfo = {
  providerID: "google",
  source: "antigravity-quota",
  fetchedAt: 0,
  groups: [
    {
      label: "Gemini Models",
      windows: [{ id: "gemini-weekly", label: "Weekly Limit Remaining", remainingPercent: 0 }],
    },
    {
      label: "Claude and GPT models",
      windows: [{ id: "3p-weekly", label: "Weekly Limit Remaining", remainingPercent: 100 }],
    },
  ],
}

const windows: UsageInfo = {
  providerID: "openai",
  source: "codex-rate-limit",
  fetchedAt: 0,
  windows: [
    { id: "5h", label: "5h", remainingPercent: 88, resetsAt: Date.now() + 3 * 60 * 60 * 1000 },
    { id: "weekly", label: "weekly", remainingPercent: 59 },
  ],
}

function renderStatus(width: number, input: { providerID: string; usage: UsageInfo }) {
  return renderLocal({
    width,
    models: [{ ...model("selected"), providerID: input.providerID }],
    children: () => <DialogStatus />,
    fetch: (url) =>
      url.pathname === "/api/usage"
        ? json({
            location: { directory: url.searchParams.get("location[directory]") ?? "" },
            data: input.usage,
          })
        : undefined,
  })
}

async function settled(matches: (frame: string) => boolean, frame: () => string) {
  const started = Date.now()
  while (!matches(frame())) {
    if (Date.now() - started > 2_000) throw new Error(`Timed out waiting for usage:\n${frame()}`)
    await Bun.sleep(10)
  }
  return frame()
}

test.each([100, 44])("status shows the selected model provider's balance at width %s", async (width) => {
  await using setup = await renderStatus(width, { providerID: "deepseek", usage: balance })
  const frame = await settled(
    (frame) => frame.includes("DeepSeek balance"),
    () => setup.captureCharFrame(),
  )
  expect(frame).toContain("USD")
  expect(frame).toContain("27.02")
  // Only the selected model's account is read, so no other provider's balances are listed.
  expect(frame).not.toContain("CNY")
})

test("status groups Antigravity quota into the service's pools", async () => {
  await using setup = await renderStatus(100, { providerID: "google", usage: antigravity })
  const frame = await settled(
    (frame) => frame.includes("Claude and GPT models"),
    () => setup.captureCharFrame(),
  )
  expect(frame).toContain("Antigravity quota")
  expect(frame).toContain("Gemini Models")
  // A spent pool draws an empty track; a full one draws only filled cells.
  expect(bar(frame, 0)).toMatch(/^░+$/)
  expect(bar(frame, 100)).toMatch(/^█+$/)
  // Both pools draw the same width, so their bars line up under one another.
  expect(bar(frame, 0)).toHaveLength(bar(frame, 100)!.length)
})

test("status shows rate-limit windows with their reset time", async () => {
  await using setup = await renderStatus(100, { providerID: "openai", usage: windows })
  const frame = await settled(
    (frame) => frame.includes("Codex usage"),
    () => setup.captureCharFrame(),
  )
  expect(frame).toContain("88% left")
  expect(frame).toContain("59% left")
  expect(frame).toMatch(/resets in (2h 59m|3h 0m)/)
  // The bar tracks what is left, so 88% of it is lit.
  expect(bar(frame, 88)).toBe(`${"█".repeat(18)}${"░".repeat(2)}`)
  expect(bar(frame, 59)).toBe(`${"█".repeat(12)}${"░".repeat(8)}`)
})

test("status keeps the percentage when a pool label leaves no room for a bar", async () => {
  await using setup = await renderStatus(44, { providerID: "google", usage: antigravity })
  const frame = await settled(
    (frame) => frame.includes("Gemini Models"),
    () => setup.captureCharFrame(),
  )
  expect(frame).toContain("Weekly Limit Remaining 0% left")
  // The label alone fills the row, so no bar is drawn rather than a truncated one.
  expect(frame).not.toContain("░")
})

/** The bar glyphs of the row that reports `percent` left, so assertions do not fix a bar width. */
function bar(frame: string, percent: number) {
  return frame.match(new RegExp(`\\[([█░]*)\\] ${percent}% left`))?.[1]
}
