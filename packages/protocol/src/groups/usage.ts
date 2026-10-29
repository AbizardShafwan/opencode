import { Location } from "@opencode/schema/location"
import { Provider } from "@opencode/schema/provider"
import { Usage } from "@opencode/schema/usage"
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
            "Read the selected model provider's account usage: DeepSeek balance, Antigravity quota pools, or Codex, Claude Code, and Ollama Cloud rate-limit windows. Returns nothing when the provider has no usage to read or its endpoint fails.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "usage",
      description: "Provider account usage for the selected model.",
    }),
  )
