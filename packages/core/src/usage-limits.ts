export * as UsageLimits from "./usage-limits.js"

import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Provider } from "@opencode/schema/provider"
import { UsageLimits } from "@opencode/schema/usage-limits"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { AccountUsage } from "./account-usage.js"
import { ConsoleAccess } from "./console-access.js"
import type { Credential } from "./credential.js"
import { Integration } from "./integration.js"

export const Info = UsageLimits.Info
export type Info = UsageLimits.Info

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("UsageLimits.UnavailableError", {
  message: Schema.String,
}) {}

export interface Interface {
  /** The usage limits of the OpenCode Console workspace or connected providers in this location. */
  readonly get: () => Effect.Effect<Info | undefined, UnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/UsageLimits") {}

const providerSources = [
  { providerID: Provider.ID.make("ollama-cloud"), label: "Ollama Cloud" },
  { providerID: Provider.ID.openai, label: "Codex" },
] as const

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const accountUsage = yield* AccountUsage.Service
    const http = yield* HttpClient.HttpClient

    const readProviderBudgets = Effect.fnUntraced(function* () {
      const results = yield* Effect.forEach(
        providerSources,
        ({ providerID, label }) =>
          accountUsage.read({ providerID }).pipe(
            Effect.map((usage) => {
              if (!usage?.windows?.length) return [] as UsageLimits.Budget[]
              // A provider window reports a remaining percentage, never money. Report native percentage
              // usage directly instead of scaling onto a synthetic USD budget, keeping windows without resetsAt.
              return usage.windows.map((window): UsageLimits.Budget => {
                const used = Math.round(clampPercent(100 - window.remainingPercent) * 100) / 100
                return {
                  id: `${providerID}_${window.id}`,
                  unit: "percent",
                  percent: used,
                  scope: "each",
                  per: "set",
                  coverage: "models",
                  models: [
                    {
                      providerID,
                      modelID: Model.ID.make(window.id),
                      name: `${label} · ${window.label}`,
                    },
                  ],
                  vendors: [label],
                  picked: false,
                  shared: false,
                  ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
                }
              })
            }),
            Effect.timeout(Duration.seconds(2)),
            Effect.orElseSucceed(() => [] as UsageLimits.Budget[]),
          ),
        { concurrency: "unbounded" },
      )
      return results.flat()
    })

    const get = Effect.fn("UsageLimits.get")(function* () {
      const [connection, providerBudgets] = yield* Effect.all(
        [integrations.connection.active(Integration.ID.make("opencode")), readProviderBudgets()],
        { concurrency: 2 },
      )
      if (!connection) {
        if (providerBudgets.length === 0) return undefined
        return {
          workspace: {
            id: "providers",
            name: "Connected Providers",
            usageURL: "",
          },
          budgets: providerBudgets,
        }
      }
      const credential = yield* integrations.connection
        .resolve(connection)
        .pipe(Effect.mapError((error) => new UnavailableError({ message: error.message })))
      if (!credential || credential.type === "external") {
        if (providerBudgets.length === 0) return undefined
        return {
          workspace: {
            id: "providers",
            name: "Connected Providers",
            usageURL: "",
          },
          budgets: providerBudgets,
        }
      }
      const workspaceID = credential.metadata?.orgID
      if (typeof workspaceID !== "string") {
        if (providerBudgets.length === 0) return undefined
        return {
          workspace: {
            id: "providers",
            name: "Connected Providers",
            usageURL: "",
          },
          budgets: providerBudgets,
        }
      }
      const server = ConsoleAccess.server(credential)
      // Both reads build request URLs from the stored server, so a malformed value must fail here as a typed
      // unavailability instead of throwing a defect out of `HttpClientRequest`.
      const origin = serverOrigin(server)
      if (origin === undefined)
        return yield* new UnavailableError({
          message: `OpenCode Console usage limits are unavailable: invalid server URL "${server}"`,
        })
      const [budgets, go] = yield* Effect.all(
        [readBudgets(http, server, credential), readGo(http, origin, credential, workspaceID)],
        { concurrency: 2 },
      ).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(15),
          orElse: () => Effect.fail(new UnavailableError({ message: "OpenCode Console usage limits timed out" })),
        }),
      )
      return {
        workspace: {
          id: workspaceID,
          ...(typeof credential.metadata?.orgName === "string" ? { name: credential.metadata.orgName } : {}),
          usageURL: `${server}/${workspaceID}/activity/overview`,
        },
        ...(go === undefined ? {} : { go }),
        budgets: [...budgets, ...providerBudgets],
      }
    })

    return Service.of({ get })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Integration.node, AccountUsage.node, httpClient],
})

const ConsoleBudget = Schema.Struct({
  ruleID: Schema.String,
  limitDollars: Schema.Finite,
  spentDollars: Schema.Finite,
  scope: UsageLimits.Budget.fields.scope,
  per: UsageLimits.Budget.fields.per,
  coverage: UsageLimits.Budget.fields.coverage,
  models: Schema.Array(
    Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      name: Schema.String,
      spentDollars: Schema.optional(Schema.Finite),
    }),
  ),
  vendors: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  inputPriceAtLeast: Schema.optional(Schema.Finite),
  picked: Schema.Boolean,
  shared: Schema.Boolean,
  resetsAt: Schema.DateFromString,
})

const GoMeter = Schema.Struct({
  status: Schema.Literals(["ok", "rate-limited"]),
  percent: Schema.Finite,
  resetsAt: Schema.DateFromString,
})
const GoUsage = Schema.Struct({ usage: Schema.Struct({ rolling: GoMeter, weekly: GoMeter, monthly: GoMeter }) })

function readBudgets(http: HttpClient.HttpClient, server: string, credential: Credential.Key | Credential.OAuth) {
  return HttpClient.withScope(http)
    .execute(
      HttpClientRequest.get(`${server}/api/policies/current-budgets`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeaders(ConsoleAccess.headers(credential)),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        response.status === 403
          ? Effect.succeed([])
          : HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(ConsoleBudget))),
              Effect.map((budgets) =>
                budgets.map((budget) => ({
                  id: budget.ruleID,
                  unit: "usd" as const,
                  limit: Money.USD.make(budget.limitDollars),
                  spent: Money.USD.make(budget.spentDollars),
                  scope: budget.scope,
                  per: budget.per,
                  coverage: budget.coverage,
                  models: budget.models.map((model) => ({
                    providerID: Provider.ID.make(model.providerID),
                    modelID: Model.ID.make(model.modelID),
                    name: model.name,
                    ...(model.spentDollars === undefined ? {} : { spent: Money.USD.make(model.spentDollars) }),
                  })),
                  vendors: budget.vendors.map((vendor) => vendor.name),
                  ...(budget.inputPriceAtLeast === undefined
                    ? {}
                    : { inputPriceAtLeast: Money.USDPerMillionTokens.make(budget.inputPriceAtLeast) }),
                  picked: budget.picked,
                  shared: budget.shared,
                  resetsAt: budget.resetsAt.getTime(),
                })),
              ),
            ),
      ),
      Effect.scoped,
      Effect.mapError(
        (error) => new UnavailableError({ message: `OpenCode Console budgets are unavailable: ${error.message}` }),
      ),
    )
}

function readGo(
  http: HttpClient.HttpClient,
  origin: string,
  credential: Credential.Key | Credential.OAuth,
  workspaceID: string,
) {
  return HttpClient.withScope(http)
    .execute(
      HttpClientRequest.get(`${origin}/zen/go/v1/usage`).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(credential.type === "oauth" ? credential.access : credential.key),
        HttpClientRequest.setHeader("x-opencode-org-id", workspaceID),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        response.status === 403
          ? Effect.succeed(undefined)
          : HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(GoUsage)),
              Effect.map((body) => ({
                rolling: meter(body.usage.rolling),
                weekly: meter(body.usage.weekly),
                monthly: meter(body.usage.monthly),
              })),
            ),
      ),
      Effect.scoped,
      Effect.mapError(
        (error) => new UnavailableError({ message: `OpenCode Go usage is unavailable: ${error.message}` }),
      ),
    )
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value))
}

/** The Console origin, or undefined when the stored server is not an absolute URL. */
function serverOrigin(server: string) {
  try {
    return new URL(server).origin
  } catch {
    return undefined
  }
}

function meter(value: typeof GoMeter.Type) {
  return {
    percent: clampPercent(value.percent),
    limited: value.status === "rate-limited",
    resetsAt: value.resetsAt.getTime(),
  }
}
