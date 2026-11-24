import { Job } from "@opencode/core/job"
import { Session } from "@opencode/core/session"
import { SessionBackground } from "@opencode/core/session/background"
import { InvalidRequestError, SessionNotFoundError } from "@opencode/protocol/errors"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"

export const JobHandler = HttpApiBuilder.group(Api, "server.job", (handlers) =>
  Effect.gen(function* () {
    const jobs = yield* Job.Service
    const sessions = yield* Session.Service
    const store = {
      get: (sessionID: Parameters<Session.Interface["get"]>[0]) =>
        sessions.get(sessionID).pipe(Effect.option, Effect.map(Option.getOrUndefined)),
    }

    return handlers.handle(
      "job.list",
      Effect.fn("server.job.list")(function* (ctx) {
        if (ctx.query.descendants && !ctx.query.sessionID) {
          return yield* new InvalidRequestError({ message: "descendants requires sessionID" })
        }
        if (ctx.query.sessionID) {
          const session = yield* store.get(ctx.query.sessionID)
          if (!session) {
            return yield* new SessionNotFoundError({
              sessionID: ctx.query.sessionID,
              message: `Session not found: ${ctx.query.sessionID}`,
            })
          }
        }
        const data = yield* SessionBackground.list(jobs, store, {
          sessionID: ctx.query.sessionID,
          kind: ctx.query.kind,
          descendants: ctx.query.descendants,
        })
        return { data }
      }),
    )
  }),
)
