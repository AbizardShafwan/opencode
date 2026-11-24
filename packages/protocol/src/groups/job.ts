import { Job } from "@opencode/schema/job"
import { Session } from "@opencode/schema/session"
import { Schema, SchemaGetter } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { InvalidRequestError, SessionNotFoundError } from "../errors.js"

const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value): "true" | "false" => (value ? "true" : "false")),
  }),
)

export const ListQuery = Schema.Struct({
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

export const JobGroup = HttpApiGroup.make("server.job")
  .add(
    HttpApiEndpoint.get("job.list", "/api/experimental/job", {
      query: ListQuery,
      success: Job.List,
      error: [InvalidRequestError, SessionNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.job.list",
        summary: "List background jobs",
        description: "List running and unacknowledged background jobs, optionally filtered by session and kind.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "job",
      description: "Experimental background job inspection routes.",
    }),
  )
