import { expect, test } from "bun:test"
import {
  parseAntigravityGroups,
  parseAntigravityModels,
  parseClaudeCode,
  parseCodex,
  parseDeepSeek,
  parseOllama,
} from "@opencode/core/account-usage"

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

test("reads Claude Code percentages and ISO reset times", () => {
  expect(
    parseClaudeCode({
      five_hour: { utilization: 22, resets_at: "2026-10-28T12:00:00Z" },
      seven_day: { utilization: 64.5, resets_at: "2026-11-02T12:00:00Z" },
    }),
  ).toEqual([
    { id: "5h", label: "5h", remainingPercent: 78, resetsAt: Date.parse("2026-10-28T12:00:00Z") },
    { id: "weekly", label: "weekly", remainingPercent: 35.5, resetsAt: Date.parse("2026-11-02T12:00:00Z") },
  ])
  expect(parseClaudeCode({ five_hour: null, seven_day: null })).toEqual([])
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

test("keeps Antigravity pools and their buckets as the service reports them", () => {
  expect(
    parseAntigravityGroups({
      groups: [
        {
          displayName: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            {
              bucketId: "gemini-weekly",
              displayName: "Weekly Limit Remaining",
              window: "weekly",
              resetTime: "2026-11-03T12:00:00Z",
              remainingFraction: 0.25,
            },
          ],
        },
        { displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-weekly", remainingFraction: 1 }] },
        { displayName: "Empty", buckets: [{ bucketId: "no-fraction" }] },
      ],
    }),
  ).toEqual([
    {
      label: "Gemini Models",
      description: "Models within this group: Gemini Flash, Gemini Pro",
      windows: [
        {
          id: "gemini-weekly",
          label: "Weekly Limit Remaining",
          remainingPercent: 25,
          resetsAt: Date.parse("2026-11-03T12:00:00Z"),
        },
      ],
    },
    {
      label: "Claude and GPT models",
      windows: [{ id: "3p-weekly", label: "3p-weekly", remainingPercent: 100 }],
    },
  ])
})

test("groups per-model Antigravity quota into the Gemini and Claude/GPT pools", () => {
  expect(
    parseAntigravityModels({
      models: {
        "gemini-3.8-flash-tiered": {
          displayName: "Gemini 3.8 Flash (High)",
          quotaInfo: { remainingFraction: 0.5, resetTime: "2026-11-03T12:00:00Z" },
        },
        "claude-opus-4-6-thinking": {
          displayName: "Claude Opus 4.6 (Thinking)",
          quotaInfo: { remainingFraction: 1 },
        },
        "gpt-oss-120b-medium": { quotaInfo: { remainingFraction: 0.75 } },
        "gemini-3-pro-image": { quotaInfo: { remainingFraction: 0 } },
        "chat_hidden": { quotaInfo: { remainingFraction: 0 } },
      },
    }),
  ).toEqual([
    {
      label: "Gemini",
      windows: [
        {
          id: "gemini-3.8-flash-tiered",
          label: "Gemini 3.8 Flash (High)",
          remainingPercent: 50,
          resetsAt: Date.parse("2026-11-03T12:00:00Z"),
        },
      ],
    },
    {
      label: "Claude and GPT",
      windows: [
        { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", remainingPercent: 100 },
        { id: "gpt-oss-120b-medium", label: "gpt-oss-120b-medium", remainingPercent: 75 },
      ],
    },
  ])
})
