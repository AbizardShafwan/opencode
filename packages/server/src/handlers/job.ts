import { Job } from "@opencode/core/job"
import { Location } from "@opencode/core/location"
import { Session } from "@opencode/core/session"
import { SessionBackground } from "@opencode/core/session/background"
import { InvalidRequestError, SessionNotFoundError } from "@opencode/protocol/errors"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { response } from "../location"

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
        const location = yield* Location.Service
        const belongs = (session: Session.Info) =>
          session.location.directory === location.directory &&
          session.location.workspaceID === location.workspaceID
        if (ctx.query.descendants && !ctx.query.sessionID) {
          return yield* new InvalidRequestError({ message: "descendants requires sessionID" })
        }
        if (ctx.query.sessionID) {
          const session = yield* store.get(ctx.query.sessionID)
          // A session in another location is indistinguishable from an unknown one here.
          if (!session || !belongs(session)) {
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
        // Job records are process-global, so only this location's sessions may expose their work.
        const visible = new Map<string, boolean>()
        const scoped = yield* Effect.filter(data, (item) =>
          Effect.gen(function* () {
            const known = visible.get(item.sessionID)
            if (known !== undefined) return known
            const session = yield* store.get(item.sessionID)
            const owned = session !== undefined && belongs(session)
            visible.set(item.sessionID, owned)
            return owned
          }),
        )
        return yield* response(Effect.succeed({ data: scoped }))
      }),
    )
  }),
)
