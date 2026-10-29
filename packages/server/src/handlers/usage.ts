import { AccountUsage } from "@opencode/core/account-usage"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { awaitPlugins, response } from "../location"

export const UsageHandler = HttpApiBuilder.group(Api, "server.usage", (handlers) =>
  handlers.handle(
    "usage.read",
    Effect.fn(function* (ctx) {
      yield* awaitPlugins
      const usage = yield* AccountUsage.Service
      return yield* response(usage.read({ providerID: ctx.query.providerID }))
    }),
  ),
)
