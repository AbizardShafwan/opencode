import { Job } from "@opencode/core/job"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { Session } from "@opencode/core/session"
import { SessionBackground } from "@opencode/core/session/background"
import { SessionExternalWait } from "@opencode/core/session/external-wait"
import { InvalidRequestError, SessionNotFoundError } from "@opencode/protocol/errors"
import type { Job as JobSchema } from "@opencode/schema/job"
import { sameDirectory } from "@opencode/util/path"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { response } from "../location"

type SessionStore = {
  readonly get: (sessionID: Session.ID) => Effect.Effect<Session.Info | undefined>
}

type ExternalWaitService = SessionExternalWait.Interface & {
  readonly listAll?: (options?: SessionExternalWait.ListOptions) => Effect.Effect<ReadonlyArray<SessionExternalWait.Entry>>
}

const descends = Effect.fnUntraced(function* (store: SessionStore, from: Session.ID, ancestor: Session.ID) {
  const seen = new Set<Session.ID>()
  let current: Session.ID | undefined = from
  while (current !== undefined && !seen.has(current)) {
    if (current === ancestor) return true
    seen.add(current)
    current = (yield* store.get(current))?.parentID
  }
  return false
})

function toExternalJob(entry: SessionExternalWait.Entry): JobSchema.External {
  return {
    kind: "external",
    id: `${entry.sessionID}:${entry.waitID}`,
    sessionID: Session.ID.make(entry.sessionID),
    status: "running",
    title: entry.description,
    // ExternalWait leases store expiresAt rather than startedAt, so keep a deterministic placeholder.
    time: { started: 0 },
    waitID: entry.waitID,
    source: entry.source,
    server: entry.server,
    description: entry.description,
    expiresAt: entry.expiresAt,
  }
}

export const JobHandler = HttpApiBuilder.group(Api, "server.job", (handlers) =>
  Effect.gen(function* () {
    const jobs = yield* Job.Service
    const sessions = yield* Session.Service
    const externalWaits: ExternalWaitService = yield* SessionExternalWait.Service
    const store: SessionStore = {
      get: (sessionID: Session.ID) => sessions.get(sessionID).pipe(Effect.option, Effect.map(Option.getOrUndefined)),
    }

    return handlers.handle(
      "job.list",
      Effect.fn("server.job.list")(function* (ctx) {
        const location = yield* Location.Service
        const mcp = yield* Mcp.Service
        const belongs = (session: Session.Info) =>
          sameDirectory(session.location.directory, location.directory) &&
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

        const visible = new Map<string, boolean>()
        const ownsSession = Effect.fnUntraced(function* (sessionID: Session.ID) {
          const known = visible.get(sessionID)
          if (known !== undefined) return known
          const session = yield* store.get(sessionID)
          const owned = session !== undefined && belongs(session)
          visible.set(sessionID, owned)
          return owned
        })

        const background =
          ctx.query.kind === "external"
            ? ([] as ReadonlyArray<JobSchema.Info>)
            : yield* SessionBackground.list(jobs, store, {
                sessionID: ctx.query.sessionID,
                kind: ctx.query.kind,
                descendants: ctx.query.descendants,
              })
        // Job records are process-global, so only this location's sessions may expose their work.
        const scopedBackground = yield* Effect.filter(background, (item) => ownsSession(item.sessionID))

        if (ctx.query.kind !== undefined && ctx.query.kind !== "external") {
          return yield* response(Effect.succeed({ data: scopedBackground }))
        }

        const isServerLive = (server: string) => mcp.isAttached(server)
        const waitEntries = yield* Effect.gen(function* () {
          if (ctx.query.sessionID && !ctx.query.descendants) {
            return yield* externalWaits.list(ctx.query.sessionID, { isServerLive })
          }
          if (externalWaits.listAll) {
            return yield* externalWaits.listAll({ isServerLive })
          }
          const items = new Array<SessionExternalWait.Entry>()
          const seen = new Set<string>()
          let cursor: Session.ListCursor | undefined
          do {
            const page = yield* sessions.list(cursor ? { cursor } : undefined).pipe(Effect.orDie)
            for (const session of page.data) {
              if (!belongs(session) || seen.has(session.id)) continue
              seen.add(session.id)
              visible.set(session.id, true)
              items.push(...(yield* externalWaits.list(session.id, { isServerLive })))
            }
            cursor = page.cursor.next
          } while (cursor !== undefined)
          return items
        })

        const scopedWaits = yield* Effect.filter(waitEntries, (entry) =>
          Effect.gen(function* () {
            const waitSessionID = Session.ID.make(entry.sessionID)
            if (!(yield* ownsSession(waitSessionID))) return false
            if (!ctx.query.sessionID) return true
            if (!ctx.query.descendants) return waitSessionID === ctx.query.sessionID
            return yield* descends(store, waitSessionID, ctx.query.sessionID)
          }),
        )

        const externalJobs = scopedWaits
          .map(toExternalJob)
          .toSorted((left, right) => left.expiresAt - right.expiresAt || left.id.localeCompare(right.id))

        return yield* response(Effect.succeed({ data: [...scopedBackground, ...externalJobs] }))
      }),
    )
  }),
)
