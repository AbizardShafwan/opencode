import { parseCodex, parseDeepSeek, parseOllama } from "@opencode/core/account-usage"
import { expect, test } from "bun:test"

test("reads DeepSeek balances per currency", () => {
  expect(
    parseDeepSeek({
      is_available: true,
      balance_infos: [
        { currency: "USD", total_balance: "27.02", granted_balance: "0.00", topped_up_balance: "27.02" },
        { currency: "CNY", total_balance: "0.00" },
      ],
    }),
  ).toEqual([
    { currency: "USD", total: "27.02", granted: "0.00", toppedUp: "27.02" },
    { currency: "CNY", total: "0.00" },
  ])
  expect(parseDeepSeek({ is_available: false })).toBeUndefined()
})

test("labels Codex windows from their reported length and converts reset seconds", () => {
  expect(
    parseCodex({
      plan_type: "plus",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 12,
          limit_window_seconds: 18_000,
          reset_after_seconds: 600,
          reset_at: 1_800_000_000,
        },
        secondary_window: {
          used_percent: 41,
          limit_window_seconds: 604_800,
          reset_after_seconds: 86_400,
          reset_at: 1_800_086_400,
        },
      },
    }),
  ).toEqual([
    { id: "5h", label: "5h", remainingPercent: 88, resetsAt: 1_800_000_000_000 },
    { id: "weekly", label: "weekly", remainingPercent: 59, resetsAt: 1_800_086_400_000 },
  ])
  expect(parseCodex({ rate_limit: null })).toBeUndefined()
})

test("reads Ollama Cloud's remaining session and weekly limits", () => {
  expect(
    parseOllama({
      included: {
        session: { remaining_percent: 100, resets_at: "2026-10-29T05:00:00Z" },
        weekly: { remaining_percent: 89.87, resets_at: "2026-11-02T00:00:00Z" },
      },
      purchased: { balance_usd: 0 },
    }),
  ).toEqual([
    { id: "5h", label: "5h", remainingPercent: 100, resetsAt: Date.parse("2026-10-29T05:00:00Z") },
    { id: "weekly", label: "weekly", remainingPercent: 89.87, resetsAt: Date.parse("2026-11-02T00:00:00Z") },
  ])
  // Credit plans bill per token and report no windows, so the provider has no limits to show.
  expect(parseOllama({ included: { balance_usd: 72.5, allowance_usd: 100 } })).toEqual([])
  expect(parseOllama({ purchased: { balance_usd: 25 } })).toBeUndefined()
})
