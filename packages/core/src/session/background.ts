export * as SessionBackground from "./background.js"

import { Effect } from "effect"
import type { Job } from "../job.js"
import type { JobList } from "../job/list.js"
import type { SessionExternalWait } from "./external-wait.js"
import type { SessionSchema } from "./schema.js"
import type { SessionStore } from "./store.js"

/** Optional live external-wait leases, so callers that only know about jobs stay unchanged. */
export interface ExternalWaits {
  readonly waits: Pick<SessionExternalWait.Interface, "list">
  readonly isServerLive?: (server: string) => Effect.Effect<boolean>
}

/**
 * Background jobs still running for a Session or any of its descendants. A child's own
 * background shell counts even after the child reported to its parent: its notice wakes
 * the child again, so the child's work is not finished. Active external waits are only
 * listed by wait owners themselves; a child's wait wakes the child, not this Session.
 */
export const outstanding = Effect.fnUntraced(function* (
  jobs: Pick<Job.Interface, "runningBackground">,
  store: Pick<SessionStore.Interface, "get">,
  sessionID: SessionSchema.ID,
  external?: ExternalWaits,
) {
  const owned = yield* Effect.filter(
    (yield* jobs.runningBackground).filter(
      (recovery): recovery is Exclude<Job.Recovery, { readonly kind: "image" }> => recovery.kind !== "image",
    ),
    (recovery) => descends(store, recovery.kind === "shell" ? recovery.sessionID : recovery.parentSessionID, sessionID),
  )
  const waits =
    external === undefined ? [] : yield* external.waits.list(sessionID, { isServerLive: external.isServerLive })
  return [
    ...owned.map((recovery) =>
      recovery.kind === "shell"
        ? {
            kind: "shell" as const,
            sessionID: recovery.sessionID,
            shellID: recovery.shellID,
            command: recovery.command,
          }
        : {
            kind: "subagent" as const,
            sessionID: recovery.parentSessionID,
            childSessionID: recovery.childSessionID,
            agent: recovery.agent,
            description: recovery.description,
          },
    ),
    ...waits.map((wait) => ({
      kind: "external" as const,
      sessionID: sessionID,
      waitID: wait.waitID,
      source: wait.source,
      server: wait.server,
      description: wait.description,
    })),
  ]
})

export const list = Effect.fnUntraced(function* (
  jobs: Pick<Job.Interface, "backgroundJobs">,
  store: Pick<SessionStore.Interface, "get">,
  input: {
    readonly sessionID?: SessionSchema.ID
    readonly kind?: JobList.Item["kind"]
    readonly descendants?: boolean
  } = {},
) {
  const items = yield* jobs.backgroundJobs
  const filtered = input.kind ? items.filter((item) => item.kind === input.kind) : items
  if (!input.sessionID) return filtered
  const target = input.sessionID
  if (!input.descendants) return filtered.filter((item) => item.sessionID === target)
  return yield* Effect.filter(filtered, (item) => descends(store, item.sessionID, target))
})

const descends = Effect.fnUntraced(function* (
  store: Pick<SessionStore.Interface, "get">,
  from: SessionSchema.ID,
  ancestor: SessionSchema.ID,
) {
  const seen = new Set<SessionSchema.ID>()
  let current: SessionSchema.ID | undefined = from
  while (current !== undefined && !seen.has(current)) {
    if (current === ancestor) return true
    seen.add(current)
    current = (yield* store.get(current))?.parentID
  }
  return false
})
