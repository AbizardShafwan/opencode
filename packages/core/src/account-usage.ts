export * as AccountUsage from "./account-usage.js"

/**
 * Provider account usage for the selected model: DeepSeek balance, Codex rate-limit windows,
 * and Ollama Cloud limits.
 *
 * Provider credentials live on the server, so a client never fetches these values itself.
 * A provider without a supported subscription, or one whose endpoint fails, reads as
 * `undefined` and the UI shows nothing for it.
 */

import { Credential } from "@opencode/schema/credential"
import { Provider } from "@opencode/schema/provider"
import { Usage } from "@opencode/schema/usage"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { Clock, Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Integration } from "./integration.js"
import { IntegrationConnection } from "./integration/connection.js"

/** The ChatGPT OAuth methods whose account carries Codex rate limits. */
const openAIMethods = new Set(["chatgpt-browser", "chatgpt-headless", "chatgpt-token-sharing"])

const deepseekBalanceURL = "https://api.deepseek.com/user/balance"
const ollamaBalanceURL = "https://ollama.com/api/balance"
const codexUsageURL = "https://chatgpt.com/backend-api/wham/usage"

/** Long enough that both UIs share one request, short enough that reopening a panel refetches. */
const cacheTTL = 60_000
const requestTimeout = "10 seconds"

export interface Interface {
  /** Usage for the provider the selected model belongs to, or `undefined` when it has none. */
  readonly read: (input: { providerID: Provider.ID }) => Effect.Effect<Usage.Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AccountUsage") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const http = yield* HttpClient.HttpClient
    const cache = yield* Ref.make(new Map<string, { value: Usage.Info; expires: number }>())

    // Reading a connection resolves and refreshes its credential, so an expired token refreshes here too.
    const account = (providerID: Provider.ID) =>
      Effect.gen(function* () {
        const connection = yield* integrations.connection
          .active(Integration.ID.make(providerID))
          .pipe(Effect.orElseSucceed(() => undefined))
        if (!connection) return undefined
        const value = yield* integrations.connection
          .resolve(connection)
          .pipe(Effect.orElseSucceed(() => undefined))
        if (!value) return undefined
        return { connection, value }
      })

    const read = Effect.fn("AccountUsage.read")(function* (input: { providerID: Provider.ID }) {
      const resolved = yield* account(input.providerID)
      if (!resolved) return undefined
      const source = resolveSource(input.providerID, resolved.value)
      if (!source) return undefined

      const key = `${input.providerID}:${IntegrationConnection.key(resolved.connection) ?? "env"}`
      const now = yield* Clock.currentTimeMillis
      const cached = (yield* Ref.get(cache)).get(key)
      if (cached && cached.expires > now) return cached.value

      const value = yield* fetchSource(now, http, source, input.providerID, resolved.value)
      // Failures stay uncached so the next open retries instead of hiding the section for a minute.
      if (value) yield* Ref.update(cache, (current) => current.set(key, { value, expires: now + cacheTTL }))
      return value
    })

    return Service.of({ read })
  }),
)

type Value = Credential.Value

const fetchSource = (
  fetchedAt: number,
  http: HttpClient.HttpClient,
  source: Usage.Source,
  providerID: Provider.ID,
  value: Value,
): Effect.Effect<Usage.Info | undefined> => {
  const json = (request: HttpClientRequest.HttpClientRequest) =>
    http.execute(request).pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? HttpClientResponse.schemaBodyJson(Schema.Unknown)(response)
          : Effect.succeed(undefined),
      ),
      Effect.timeout(requestTimeout),
      Effect.orElseSucceed(() => undefined),
    )

  switch (source) {
    case "deepseek-balance": {
      if (value.type !== "key") return Effect.succeed(undefined)
      return json(
        HttpClientRequest.get(deepseekBalanceURL).pipe(
          HttpClientRequest.bearerToken(value.key),
          HttpClientRequest.acceptJson,
        ),
      ).pipe(
        Effect.map((payload) => {
          const balances = payload === undefined ? undefined : parseDeepSeek(payload)
          return balances?.length ? { providerID, source, fetchedAt, balances } : undefined
        }),
      )
    }
    case "codex-rate-limit": {
      if (value.type !== "oauth") return Effect.succeed(undefined)
      const accountID = typeof value.metadata?.accountID === "string" ? value.metadata.accountID : undefined
      return json(
        HttpClientRequest.get(codexUsageURL).pipe(
          HttpClientRequest.bearerToken(value.access),
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeaders(accountID ? { "chatgpt-account-id": accountID } : {}),
        ),
      ).pipe(
        Effect.map((payload) => {
          const windows = payload === undefined ? undefined : parseCodex(payload)
          return windows?.length ? { providerID, source, fetchedAt, windows } : undefined
        }),
      )
    }
    case "ollama-balance": {
      if (value.type !== "key") return Effect.succeed(undefined)
      return json(
        HttpClientRequest.get(ollamaBalanceURL).pipe(
          HttpClientRequest.bearerToken(value.key),
          HttpClientRequest.acceptJson,
        ),
      ).pipe(
        Effect.map((payload) => {
          const windows = payload === undefined ? undefined : parseOllama(payload)
          return windows?.length ? { providerID, source, fetchedAt, windows } : undefined
        }),
      )
    }
  }
}

/** Picks the usage source the active credential supports; other API-key accounts have none. */
function resolveSource(providerID: Provider.ID, value: Value): Usage.Source | undefined {
  if (value.type === "key") {
    if (providerID === "deepseek") return "deepseek-balance"
    if (providerID === "ollama-cloud") return "ollama-balance"
    return undefined
  }
  if (value.type !== "oauth") return undefined
  if (providerID === Provider.ID.openai && openAIMethods.has(value.methodID)) return "codex-rate-limit"
  return undefined
}

const DeepSeekBalance = Schema.Struct({
  balance_infos: Schema.Array(
    Schema.Struct({
      currency: Schema.String,
      total_balance: Schema.String,
      granted_balance: Schema.optional(Schema.String),
      topped_up_balance: Schema.optional(Schema.String),
    }),
  ),
})

/** DeepSeek prepaid balances, one per currency the account reports. */
export function parseDeepSeek(payload: unknown): Usage.Balance[] | undefined {
  const decoded = Schema.decodeUnknownOption(DeepSeekBalance)(payload)
  if (Option.isNone(decoded)) return undefined
  return decoded.value.balance_infos.map((info) => ({
    currency: info.currency,
    total: info.total_balance,
    ...(info.granted_balance === undefined ? {} : { granted: info.granted_balance }),
    ...(info.topped_up_balance === undefined ? {} : { toppedUp: info.topped_up_balance }),
  }))
}

const CodexWindow = Schema.Struct({
  used_percent: Schema.Number,
  limit_window_seconds: Schema.optional(Schema.Number),
  reset_at: Schema.optional(Schema.Number),
})

const CodexPayload = Schema.Struct({
  plan_type: Schema.optional(Schema.String),
  rate_limit: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        allowed: Schema.optional(Schema.Boolean),
        limit_reached: Schema.optional(Schema.Boolean),
        primary_window: Schema.optional(Schema.NullOr(CodexWindow)),
        secondary_window: Schema.optional(Schema.NullOr(CodexWindow)),
      }),
    ),
  ),
})

/** Codex 5-hour and weekly windows, labelled from the window length the backend reports. */
export function parseCodex(payload: unknown): Usage.Window[] | undefined {
  const decoded = Schema.decodeUnknownOption(CodexPayload)(payload)
  if (Option.isNone(decoded)) return undefined
  const limit = decoded.value.rate_limit
  if (!limit) return undefined
  return percentWindows([
    { window: limit.primary_window, fallback: "5h" },
    { window: limit.secondary_window, fallback: "weekly" },
  ])
}

const OllamaLimit = Schema.Struct({
  remaining_percent: Schema.Number,
  resets_at: Schema.optional(Schema.String),
})

const OllamaBalance = Schema.Struct({
  included: Schema.optional(
    Schema.Struct({
      session: Schema.optional(Schema.NullOr(OllamaLimit)),
      weekly: Schema.optional(Schema.NullOr(OllamaLimit)),
    }),
  ),
})

/**
 * Ollama Cloud's session (5-hour) and weekly limits. Legacy plans report what is left, which is
 * already the remaining percentage the other windows carry. Credit plans omit both.
 */
export function parseOllama(payload: unknown): Usage.Window[] | undefined {
  const decoded = Schema.decodeUnknownOption(OllamaBalance)(payload)
  if (Option.isNone(decoded) || !decoded.value.included) return undefined
  const included = decoded.value.included
  return [
    { limit: included.session, id: "5h", label: "5h" },
    { limit: included.weekly, id: "weekly", label: "weekly" },
  ].flatMap(({ limit, id, label }) => {
    if (!limit || !Number.isFinite(limit.remaining_percent)) return []
    const resetsAt = resetTime(limit.resets_at)
    return [
      {
        id,
        label,
        remainingPercent: percent(limit.remaining_percent),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      },
    ]
  })
}

type PercentWindow = typeof CodexWindow.Type

/**
 * Codex reports what it consumed, while the contract carries what remains, so the windows
 * invert the provider percentage once here.
 */
function percentWindows(
  entries: readonly { window: PercentWindow | null | undefined; fallback: string }[],
): Usage.Window[] {
  return entries.flatMap(({ window, fallback }) => {
    if (!window) return []
    const used = window.used_percent
    if (!Number.isFinite(used)) return []
    const label = windowLengthLabel(window.limit_window_seconds) ?? fallback
    const resetsAt = resetTime(window.reset_at)
    return [
      {
        id: label,
        label,
        remainingPercent: percent(100 - used),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      },
    ]
  })
}

/** Clamps a provider percentage to 0–100 and drops floating-point noise such as `10.129999999`. */
function percent(value: number) {
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100
}

function windowLengthLabel(seconds: number | undefined) {
  if (!seconds || !Number.isFinite(seconds)) return undefined
  if (seconds >= 7 * 24 * 60 * 60) return "weekly"
  if (seconds >= 24 * 60 * 60) return "daily"
  if (seconds >= 5 * 60 * 60) return "5h"
  if (seconds >= 60 * 60) return "hourly"
  return undefined
}

/** Accepts epoch seconds, epoch milliseconds, or an ISO-8601 instant, and returns epoch milliseconds. */
function resetTime(value: string | number | undefined) {
  if (value === undefined) return undefined
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined
    return value > 1e12 ? value : value * 1000
  }
  const epoch = Number(value)
  if (Number.isFinite(epoch) && epoch > 0) return epoch > 1e12 ? epoch : epoch * 1000
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Integration.node, httpClient],
})
