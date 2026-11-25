import { Job } from "@opencode/schema/job"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { Context, Schema, SchemaGetter } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/http-api"
import { InvalidRequestError, SessionNotFoundError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value): "true" | "false" => (value ? "true" : "false")),
  }),
)

export const ListQuery = Schema.Struct({
  ...LocationQuery.fields,
  sessionID: Schema.optional(Session.ID).annotate({
    description: "Filter to background jobs owned by this session.",
  }),
  kind: Schema.optional(Job.Kind).annotate({
    description: "Filter to background jobs of one kind.",
  }),
  descendants: Schema.optional(BooleanFromString).annotate({
    description: "Include background jobs owned by descendant sessions. Requires sessionID.",
  }),
})

export const makeJobGroup = <LocationId extends HttpApiMiddleware.AnyId, LocationService>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
) =>
  HttpApiGroup.make("server.job")
    .add(
      HttpApiEndpoint.get("job.list", "/api/experimental/job", {
        query: ListQuery,
        success: Location.response(Job.List),
        error: [InvalidRequestError, SessionNotFoundError],
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.job.list",
            summary: "List background jobs",
            description:
              "List running and unacknowledged background jobs and active external waits of this location, optionally filtered by session and kind.",
          }),
        ),
    )
    .middleware(locationMiddleware)
    .annotateMerge(
      OpenApi.annotations({
        title: "job",
        description: "Experimental background job inspection routes.",
      }),
    )
