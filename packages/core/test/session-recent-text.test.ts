import { expect, test } from "bun:test"
import { SessionRecentText } from "@opencode/core/session/recent-text"

const THREAD = "t3-thread://369a6530-69ca-404f-9e59-1c1c430cecd4"
const PULL_REQUEST = "https://github.com/anomalyco/opencode/pull/62266"
const ISSUE = "https://github.com/anomalyco/opencode/issues/1234"

test("keeps output that already fits unchanged", () => {
  expect(SessionRecentText.truncateToolOutput("short")).toBe("short")
})

test("carries thread, pull request and issue links past the truncation point", () => {
  const head = "x".repeat(1_500)
  const output = SessionRecentText.truncateToolOutput(
    `${head}\nsee [the thread](${THREAD}) and ${PULL_REQUEST} and ${ISSUE}`,
  )

  expect(output).toContain("[truncated]")
  expect(output).toContain(`[Links from truncated output: ${THREAD} ${PULL_REQUEST} ${ISSUE}]`)
  // Only the links survive from the tail; the rest of the long output stays cut.
  expect(output).not.toContain("see [the thread]")
})

test("drops sentence punctuation after a link", () => {
  const output = SessionRecentText.truncateToolOutput(`${"x".repeat(1_500)} see ${PULL_REQUEST}.`)

  expect(output).toContain(`[Links from truncated output: ${PULL_REQUEST}]`)
})

test("does not repeat links that remain inside the kept prefix", () => {
  const output = SessionRecentText.truncateToolOutput(`${PULL_REQUEST} ${"x".repeat(1_500)} tail`)

  expect(output).not.toContain("Links from truncated output")
})

test("bounds the preserved links so the notice stays compact", () => {
  const tail = Array.from({ length: 20 }, (_, index) => `https://github.com/anomalyco/opencode/pull/${index}`).join(" ")
  const output = SessionRecentText.truncateToolOutput(`x`.repeat(1_500) + tail)

  expect(output.match(/https:\/\/github\.com/g)?.length).toBe(6)
})
