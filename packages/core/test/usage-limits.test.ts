import { expect } from "bun:test"
import { AccountUsage } from "@opencode/core/account-usage"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Integration } from "@opencode/core/integration"
import { UsageLimits } from "@opencode/core/usage-limits"
import { Credential } from "@opencode/schema/credential"
import { Provider } from "@opencode/schema/provider"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/http"
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

const unused = () => Effect.die("unused integration method")

const build = (accountUsage: AccountUsage.Interface, active: typeof connection | undefined) =>
  testEffect(
    AppNodeBuilder.build(LayerNode.group([UsageLimits.node]), [
      Integration.node.replace(
        Layer.mock(Integration.Service, {
          // `Layer.mock` auto-fills Effect-returning members, but not the synchronous revision or the
          // nested oauth and command groups, so those arrive as explicit stubs.
          revision: () => 0,
          connection: {
            active: () => Effect.succeed(active),
            resolve: () => Effect.succeed(credential),
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
      LayerNodePlatform.httpClient.replace(Layer.succeed(HttpClient.HttpClient, network)),
    ]),
  )

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
                // A window without a reported reset is omitted rather than given a fabricated one.
                { id: "weekly", label: "weekly", remainingPercent: 50 },
              ],
            },
      ),
  },
  undefined,
).effect("reports provider windows without a fabricated reset", () =>
  Effect.gen(function* () {
    const service = yield* UsageLimits.Service

    const info = yield* service.get()

    expect(info?.workspace).toEqual({ id: "providers", name: "Connected Providers", usageURL: "" })
    expect(info?.budgets).toHaveLength(1)
    expect(info?.budgets[0]).toMatchObject({
      id: "ollama-cloud_5h",
      limit: 100,
      spent: 25,
      resetsAt: 1_800_000_000_000,
      vendors: ["Ollama Cloud"],
      models: [{ providerID: "ollama-cloud", modelID: "5h", name: "Ollama Cloud · 5h" }],
    })
  }),
)
