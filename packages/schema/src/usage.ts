export * as Usage from "./usage.js"

import { Schema } from "effect"
import { Provider } from "./provider.js"
import { optional } from "./schema.js"

/**
 * Where a usage snapshot came from. The selected model's provider decides which source
 * applies, so a client never mixes two providers' quotas in one view.
 *
 * - `deepseek-balance`: DeepSeek prepaid account balance.
 * - `antigravity-quota`: Antigravity / Cloud Code Assist shared quota pools.
 * - `codex-rate-limit`: OpenAI Codex subscription 5-hour and weekly windows.
 * - `claude-code-usage`: Claude Code subscription 5-hour and weekly windows.
 * - `ollama-balance`: Ollama Cloud session (5-hour) and weekly limits.
 */
export const Source = Schema.Literals([
  "deepseek-balance",
  "antigravity-quota",
  "codex-rate-limit",
  "claude-code-usage",
  "ollama-balance",
])
  .annotate({ identifier: "Usage.Source" })
export type Source = typeof Source.Type

/**
 * A quota window such as Codex, Claude Code, or Ollama Cloud's 5-hour and weekly limits, or one
 * Antigravity pool bucket. It reports what remains rather than what was consumed, because that is
 * what a client draws: the last percentage of a window is not the same as an empty allowance.
 */
export interface Window extends Schema.Schema.Type<typeof Window> {}
export const Window = Schema.Struct({
  /** Stable machine identifier, for example `5h`, `weekly`, or a quota bucket id. */
  id: Schema.String,
  /** The provider's own label for the window, for example `5h` or `weekly`. */
  label: Schema.String,
  /** Share of the window still available, 0–100. Zero means the window is spent. */
  remainingPercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  /** When the window resets, in epoch milliseconds. */
  resetsAt: Schema.Finite.pipe(optional),
}).annotate({ identifier: "Usage.Window" })

/** One currency's DeepSeek prepaid balance. Amounts keep the provider's decimal string form. */
export interface Balance extends Schema.Schema.Type<typeof Balance> {}
export const Balance = Schema.Struct({
  /** ISO 4217 currency code reported by DeepSeek, for example `USD` or `CNY`. */
  currency: Schema.String,
  /** Total available balance, including granted and topped-up amounts. */
  total: Schema.String,
  /** Non-expired granted balance. */
  granted: Schema.String.pipe(optional),
  /** Topped-up balance. */
  toppedUp: Schema.String.pipe(optional),
}).annotate({ identifier: "Usage.Balance" })

/** One Antigravity quota pool, for example the Gemini pool or the Claude and GPT pool. */
export interface Group extends Schema.Schema.Type<typeof Group> {}
export const Group = Schema.Struct({
  /** The provider's own pool label. */
  label: Schema.String,
  /** Optional provider description of what the pool covers. */
  description: Schema.String.pipe(optional),
  windows: Schema.Array(Window),
}).annotate({ identifier: "Usage.Group" })

/**
 * Usage for the selected model's provider. Only the fields owned by `source` are present:
 * `balances` for `deepseek-balance`, `groups` for `antigravity-quota`, and `windows` for
 * `codex-rate-limit`, `claude-code-usage`, and `ollama-balance`.
 */
export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  providerID: Provider.ID,
  source: Source,
  /** When the snapshot was fetched, in epoch milliseconds. */
  fetchedAt: Schema.Finite,
  /** DeepSeek balances, one per currency the account reports. */
  balances: Schema.Array(Balance).pipe(optional),
  /** Codex, Claude Code, or Ollama Cloud rate-limit windows. */
  windows: Schema.Array(Window).pipe(optional),
  /** Antigravity quota pools. */
  groups: Schema.Array(Group).pipe(optional),
}).annotate({ identifier: "Usage.Info" })

/** What a read returns: a snapshot, or nothing when the provider offers no usage to read. */
export const Result = Schema.UndefinedOr(Info).annotate({ identifier: "Usage.Result" })
export type Result = typeof Result.Type
