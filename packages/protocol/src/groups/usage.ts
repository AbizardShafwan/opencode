import { Location } from "@opencode/schema/location"
import { Provider } from "@opencode/schema/provider"
import { Usage } from "@opencode/schema/usage"
import { UsageLimits } from "@opencode/schema/usage-limits"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { ServiceUnavailableError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const UsageQuery = Schema.Struct({
  ...LocationQuery.fields,
  providerID: Provider.ID,
})

export const UsageGroup = HttpApiGroup.make("server.usage")
  .add(
    HttpApiEndpoint.get("usage.read", "/api/usage", {
      query: UsageQuery,
      success: Location.response(Usage.Result),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "usage.read",
          summary: "Read provider usage",
          description:
            "Read the selected model provider's account usage: DeepSeek balance, or Codex and Ollama Cloud rate-limit windows. Returns nothing when the provider has no usage to read or its endpoint fails.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("usage.limits", "/api/experimental/usage/limits", {
      query: LocationQuery,
      success: Location.response(Schema.NullOr(UsageLimits.Info)),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.usage.limits",
          summary: "Get usage limits",
          description:
            "Return the OpenCode Go allowance and Console budgets of the OpenCode Console workspace the location is signed in to, or null when it isn't signed in.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "usage",
      description: "Provider account usage for the selected model.",
    }),
  )
