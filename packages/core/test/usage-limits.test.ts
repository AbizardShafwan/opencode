import { expect } from "bun:test"
import { AccountUsage } from "@opencode/core/account-usage"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Integration } from "@opencode/core/integration"
import { UsageLimits } from "@opencode/core/usage-limits"
import { Credential } from "@opencode/schema/credential"
import { Money } from "@opencode/schema/money"
import { Provider } from "@opencode/schema/provider"
import { Budget } from "@opencode/schema/usage-limits"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"

const connection = {
  type: "credential" as const,
  id: Credential.ID.create(),
  label: "OpenCode Console",
  method: "key" as const,
}
const credential = Credential.Key.make({
  type: "key",
  key: "console-secret",
  metadata: { server: "not a url", orgID: "wrk_1" },
})

// Nothing should reach the network: a malformed server must fail before any request is built.
const network = HttpClient.make(() => Effect.die(new Error("unexpected network request")))

const unused = () => Effect.die(new Error("unused integration method"))

const buildWith = (
  accountUsage: AccountUsage.Interface,
  active: typeof connection | undefined,
  resolved: Credential.Key = credential,
  http: HttpClient.HttpClient = network,
) =>
  testEffect(
    AppNodeBuilder.build(LayerNode.group([UsageLimits.node]), [
      Integration.node.replace(
        Layer.mock(Integration.Service, {
          // `Layer.mock` auto-fills Effect-returning members, but not the synchronous revision or the
          // nested oauth and command groups, so those arrive as explicit stubs.
          revision: () => 0,
          connection: {
            active: () => Effect.succeed(active),
            resolve: () => Effect.succeed(resolved),
            key: unused,
            external: unused,
            activate: unused,
            update: unused,
            remove: unused,
            status: unused,
          },
          oauth: { connect: unused, status: unused, complete: unused, cancel: unused },
          command: { connect: unused, status: unused, cancel: unused },
        }),
      ),
      AccountUsage.node.replace(Layer.mock(AccountUsage.Service, accountUsage)),
      LayerNodePlatform.httpClient.replace(Layer.succeed(HttpClient.HttpClient, http)),
    ]),
  )

const build = (accountUsage: AccountUsage.Interface, active: typeof connection | undefined) =>
  buildWith(accountUsage, active)

const unusedUsage = { read: () => Effect.succeed(undefined) }

build(unusedUsage, connection).effect("reports a malformed Console server as unavailable", () =>
  Effect.gen(function* () {
    const service = yield* UsageLimits.Service

    const error = yield* Effect.flip(service.get())

    expect(error).toBeInstanceOf(UsageLimits.UnavailableError)
    expect(error.message).toContain('invalid server URL "not a url"')
  }),
)

build(
  {
    read: ({ providerID }) =>
      Effect.succeed(
        providerID !== Provider.ID.make("ollama-cloud")
          ? undefined
          : {
              providerID: Provider.ID.make("ollama-cloud"),
              source: "ollama-balance" as const,
              fetchedAt: 1,
              windows: [
                { id: "5h", label: "5h", remainingPercent: 75, resetsAt: 1_800_000_000_000 },
                // Windows without a finite reset must be omitted so strict T3 Code v0.1.12 clients decode cleanly.
                { id: "weekly", label: "weekly", remainingPercent: 50 },
              ],
            },
      ),
  },
  undefined,
).effect("reports provider windows with limit, spent, unit, percent, and omits windows without resetsAt", () =>
  Effect.gen(function* () {
    const service = yield* UsageLimits.Service

    const info = yield* service.get()

    expect(info?.workspace).toEqual({ id: "providers", name: "Connected Providers", usageURL: "" })
    expect(info?.budgets).toHaveLength(1)
    expect(info?.budgets[0]).toMatchObject({
      id: "ollama-cloud_5h",
      unit: "percent",
      limit: 100,
      spent: 25,
      percent: 25,
      resetsAt: 1_800_000_000_000,
      vendors: ["Ollama Cloud"],
      models: [{ providerID: "ollama-cloud", modelID: "5h", name: "Ollama Cloud · 5h" }],
    })
  }),
)

const consoleCredential = Credential.Key.make({
  type: "key",
  key: "console-secret",
  metadata: { server: "https://console.example.test", orgID: "wrk_1", orgName: "Acme" },
})

const consoleHttp = HttpClient.make((request) => {
  if (request.url.endsWith("/api/policies/current-budgets")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify([
            {
              ruleID: "rule_1",
              limitDollars: 250,
              spentDollars: 42.5,
              scope: "each",
              per: "set",
              coverage: "all",
              models: [],
              vendors: [],
              picked: false,
              shared: true,
              resetsAt: "2026-12-01T00:00:00.000Z",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    )
  }
  return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 403 })))
})

const T3CodeInstant = Schema.Finite.check(Schema.isBetween({ minimum: -864e13, maximum: 864e13 }))
const T3CodeMeter = Schema.Struct({
  percent: Schema.Finite,
  limited: Schema.Boolean,
  resetsAt: T3CodeInstant,
})
const T3CodeBudgetModel = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  name: Schema.String,
  spent: Schema.optionalKey(Schema.Finite),
})
const T3CodeUsageLimitsInfo = Schema.Struct({
  workspace: Schema.Struct({
    id: Schema.String,
    name: Schema.optionalKey(Schema.String),
    usageURL: Schema.String,
  }),
  go: Schema.optionalKey(
    Schema.Struct({
      rolling: T3CodeMeter,
      weekly: T3CodeMeter,
      monthly: T3CodeMeter,
    }),
  ),
  budgets: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      limit: Schema.Finite,
      spent: Schema.Finite,
      scope: Schema.Literals(["each", "combined"]),
      per: Schema.Literals(["set", "model"]),
      coverage: Schema.Literals(["all", "models"]),
      models: Schema.Array(T3CodeBudgetModel),
      shared: Schema.Boolean,
      resetsAt: T3CodeInstant,
    }),
  ),
})

buildWith(
  {
    read: ({ providerID }) =>
      Effect.succeed(
        providerID !== Provider.ID.openai
          ? undefined
          : {
              providerID: Provider.ID.openai,
              source: "codex-rate-limit" as const,
              fetchedAt: 2,
              windows: [
                { id: "primary", label: "5h", remainingPercent: 80, resetsAt: 1_800_000_000_000 },
                { id: "secondary", label: "weekly", remainingPercent: 50 },
              ],
            },
      ),
  },
  connection,
  consoleCredential,
  consoleHttp,
).effect(
  "combines Console USD budgets with provider percentage windows compatible with T3 Code v0.1.12 and legacy decoders",
  () =>
    Effect.gen(function* () {
      const service = yield* UsageLimits.Service

      const info = yield* service.get()

      expect(info?.workspace).toEqual({
        id: "wrk_1",
        name: "Acme",
        usageURL: "https://console.example.test/wrk_1/activity/overview",
      })
      expect(info?.budgets).toHaveLength(2)
      expect(info?.budgets[0]).toMatchObject({
        id: "rule_1",
        unit: "usd",
        limit: 250,
        spent: 42.5,
        resetsAt: Date.parse("2026-12-01T00:00:00.000Z"),
      })
      expect(info?.budgets[0]?.percent).toBeUndefined()
      expect(info?.budgets[1]).toMatchObject({
        id: "openai_primary",
        unit: "percent",
        limit: 100,
        spent: 20,
        percent: 20,
        vendors: ["Codex"],
        models: [{ providerID: "openai", modelID: "primary", name: "Codex · 5h" }],
        resetsAt: 1_800_000_000_000,
      })

      const t3Decoded = Schema.decodeUnknownSync(T3CodeUsageLimitsInfo)(info)
      expect(t3Decoded.budgets).toHaveLength(2)

      const legacyDecoded = Schema.decodeUnknownSync(Budget)({
        id: "legacy_rule",
        limit: 100,
        spent: 10,
        scope: "each",
        per: "set",
        coverage: "all",
        models: [],
        vendors: [],
        picked: false,
        shared: false,
        resetsAt: 1_800_000_000_000,
      })
      expect(legacyDecoded.unit).toBeUndefined()
      expect(legacyDecoded.limit).toBe(Money.USD.make(100))
      expect(legacyDecoded.spent).toBe(Money.USD.make(10))
    }),
)
