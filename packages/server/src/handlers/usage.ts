import { AccountUsage } from "@opencode/core/account-usage"
import { UsageLimits } from "@opencode/core/usage-limits"
import { ServiceUnavailableError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { awaitPlugins, response } from "../location"

export const UsageHandler = HttpApiBuilder.group(Api, "server.usage", (handlers) =>
  handlers
    .handle(
      "usage.read",
      Effect.fn(function* (ctx) {
        yield* awaitPlugins
        const usage = yield* AccountUsage.Service
        return yield* response(usage.read({ providerID: ctx.query.providerID }))
      }),
    )
    .handle(
      "usage.limits",
      Effect.fn("server.usage.limits")(function* () {
        // The OpenCode Console plugin registers the sign-in method that refreshes an expired credential.
        yield* awaitPlugins
        const limits = yield* UsageLimits.Service
        return yield* response(
          limits.get().pipe(
            Effect.map((info) => info ?? null),
            Effect.mapError((error) => new ServiceUnavailableError({ message: error.message, service: "opencode" })),
          ),
        )
      }),
    ),
)
