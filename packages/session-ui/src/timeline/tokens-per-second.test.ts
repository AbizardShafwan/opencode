import { expect, test } from "bun:test"
import { turnTokensPerSecond } from "./tokens-per-second"

const step = (created: number, streamed: number | undefined, output: number, reasoning = 0) => ({
  time: { created, streamed },
  tokens: { input: 0, output, reasoning, cache: { read: 0, write: 0 } },
})

test("weights each step by its own streamed duration", () => {
  expect(turnTokensPerSecond([step(1_000, 2_000, 40), step(2_000, 4_000, 120)])).toBeCloseTo(160 / 3)
})

test("counts reasoning tokens as output like the TUI", () => {
  expect(turnTokensPerSecond([step(0, 1_000, 20, 30)])).toBe(50)
})

test("is unavailable until every step reports when it streamed", () => {
  expect(turnTokensPerSecond([step(0, 1_000, 20), step(1_000, undefined, 20)])).toBeUndefined()
})

test("is unavailable without output or elapsed generation time", () => {
  expect(turnTokensPerSecond([step(0, 1_000, 0)])).toBeUndefined()
  expect(turnTokensPerSecond([step(1_000, 1_000, 20)])).toBeUndefined()
  expect(turnTokensPerSecond([])).toBeUndefined()
})
