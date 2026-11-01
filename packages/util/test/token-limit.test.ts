import { describe, expect, test } from "bun:test"
import { formatTokenLimit, parseTokenLimit, TokenLimit } from "../src/token-limit.js"

describe("TokenLimit", () => {
  describe("parseTokenLimit", () => {
    test("parses k/K suffix", () => {
      expect(parseTokenLimit("372k")).toEqual({ tokens: 372_000 })
      expect(parseTokenLimit("372K")).toEqual({ tokens: 372_000 })
      expect(parseTokenLimit("40k")).toEqual({ tokens: 40_000 })
      expect(parseTokenLimit("128k")).toEqual({ tokens: 128_000 })
      expect(parseTokenLimit("64.5k")).toEqual({ tokens: 64_500 })
    })

    test("parses m/M suffix", () => {
      expect(parseTokenLimit("1m")).toEqual({ tokens: 1_000_000 })
      expect(parseTokenLimit("1M")).toEqual({ tokens: 1_000_000 })
      expect(parseTokenLimit("1.5m")).toEqual({ tokens: 1_500_000 })
      expect(parseTokenLimit("2M")).toEqual({ tokens: 2_000_000 })
    })

    test("parses exact numeric values and comma-separated numbers", () => {
      expect(parseTokenLimit("372000")).toEqual({ tokens: 372_000 })
      expect(parseTokenLimit("372,000")).toEqual({ tokens: 372_000 })
      expect(parseTokenLimit("1,000,000")).toEqual({ tokens: 1_000_000 })
      expect(parseTokenLimit("40,000")).toEqual({ tokens: 40_000 })
    })

    test("handles whitespace and spaces before unit", () => {
      expect(parseTokenLimit("  372k  ")).toEqual({ tokens: 372_000 })
      expect(parseTokenLimit("372 k")).toEqual({ tokens: 372_000 })
      expect(parseTokenLimit(" 1 M ")).toEqual({ tokens: 1_000_000 })
    })

    test("recognizes reset keywords case-insensitively", () => {
      expect(parseTokenLimit("default")).toEqual({ clear: true })
      expect(parseTokenLimit("DEFAULT")).toEqual({ clear: true })
      expect(parseTokenLimit("reset")).toEqual({ clear: true })
      expect(parseTokenLimit("Reset")).toEqual({ clear: true })
      expect(parseTokenLimit("none")).toEqual({ clear: true })
      expect(parseTokenLimit("NONE")).toEqual({ clear: true })
    })

    test("max explicitly selects the physical window rather than inheriting defaults", () => {
      expect(parseTokenLimit("max", 1_000_000)).toEqual({ tokens: 1_000_000 })
      expect(parseTokenLimit("  MAX  ", 128_000)).toEqual({ tokens: 128_000 })
      expect(parseTokenLimit("max", 16_000)).toEqual({ tokens: 16_000 })
      expect(parseTokenLimit("max")).toEqual({ error: "Model capacity is unknown" })
      expect(parseTokenLimit("max", 0)).toEqual({ error: "Model capacity is unknown" })
    })

    test("enforces floor guardrail (< 40k tokens)", () => {
      expect(parseTokenLimit("39999")).toEqual({ error: "Soft limit must be at least 40k tokens" })
      expect(parseTokenLimit("39k")).toEqual({ error: "Soft limit must be at least 40k tokens" })
      expect(parseTokenLimit("0")).toEqual({ error: "Soft limit must be at least 40k tokens" })
      expect(parseTokenLimit("10k")).toEqual({ error: "Soft limit must be at least 40k tokens" })
      expect(parseTokenLimit("1")).toEqual({ error: "Soft limit must be at least 40k tokens" })
    })

    test("enforces ceiling guardrail with clamping", () => {
      expect(parseTokenLimit("500k", 372_000)).toEqual({ tokens: 372_000, clamped: true })
      expect(parseTokenLimit("2M", 1_000_000)).toEqual({ tokens: 1_000_000, clamped: true })
      expect(parseTokenLimit("372k", 372_000)).toEqual({ tokens: 372_000 })
      expect(parseTokenLimit("200k", 372_000)).toEqual({ tokens: 200_000 })
      expect(parseTokenLimit("500k")).toEqual({ tokens: 500_000 })
    })

    test("rejects invalid input formats", () => {
      expect(parseTokenLimit("")).toEqual({ error: "Invalid token limit format" })
      expect(parseTokenLimit("   ")).toEqual({ error: "Invalid token limit format" })
      expect(parseTokenLimit("abc")).toEqual({ error: "Invalid token limit format" })
      expect(parseTokenLimit("k")).toEqual({ error: "Invalid token limit format" })
      expect(parseTokenLimit("-50k")).toEqual({ error: "Invalid token limit format" })
      expect(parseTokenLimit("100xyz")).toEqual({ error: "Invalid token limit format" })
    })
  })

  describe("formatTokenLimit", () => {
    test("formats thousands and millions into compact notation", () => {
      expect(formatTokenLimit(372_000)).toBe("372k")
      expect(formatTokenLimit(1_000_000)).toBe("1M")
      expect(formatTokenLimit(128_000)).toBe("128k")
      expect(formatTokenLimit(40_000)).toBe("40k")
      expect(formatTokenLimit(1_500_000)).toBe("1.5M")
      expect(formatTokenLimit(2_000_000)).toBe("2M")
      expect(formatTokenLimit(372_500)).toBe("372.5k")
    })

    test("formats sub-thousand values", () => {
      expect(formatTokenLimit(500)).toBe("500")
      expect(formatTokenLimit(0)).toBe("0")
    })

    test("handles non-finite values", () => {
      expect(formatTokenLimit(Number.NaN)).toBe("0")
      expect(formatTokenLimit(Number.POSITIVE_INFINITY)).toBe("0")
    })

    test("exports namespace TokenLimit", () => {
      expect(TokenLimit.parseTokenLimit).toBe(parseTokenLimit)
      expect(TokenLimit.formatTokenLimit).toBe(formatTokenLimit)
      expect(TokenLimit.MIN_TOKEN_LIMIT).toBe(40_000)
    })
  })
})
