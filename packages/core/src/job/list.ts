export * as JobList from "./list.js"

import { Job } from "@opencode/schema/job"
import { Effect, SynchronizedRef } from "effect"
import type { Background, Info, Recovery } from "../job.js"

export type Item = Job.Info

export type Live = {
  readonly info: Info
  readonly isBackgrounded: boolean
  readonly recovery?: Recovery
}

function toItem(input: {
  readonly id: string
  readonly status: Job.Status
  readonly title?: string
  readonly started: number
  readonly completed?: number
  readonly recovery: Recovery
}): Job.Info {
  const time: Job.Time = {
    started: input.started,
    ...(input.completed !== undefined ? { completed: input.completed } : {}),
  }
  const recovery = input.recovery
  if (recovery.kind === "shell") {
    return {
      kind: "shell",
      id: input.id,
      sessionID: recovery.sessionID,
      status: input.status,
      ...(input.title !== undefined ? { title: input.title } : {}),
      time,
      shellID: recovery.shellID,
      command: recovery.command,
    }
  }
  if (recovery.kind === "subagent") {
    return {
      kind: "subagent",
      id: input.id,
      sessionID: recovery.parentSessionID,
      status: input.status,
      ...(input.title !== undefined ? { title: input.title } : {}),
      time,
      childSessionID: recovery.childSessionID,
      agent: recovery.agent,
      description: recovery.description,
    }
  }
  return {
    kind: "image",
    id: input.id,
    sessionID: recovery.sessionID,
    status: input.status,
    ...(input.title !== undefined ? { title: input.title } : {}),
    time,
    path: recovery.path,
    model: recovery.model,
  }
}

export function read<Entry extends Live>(
  persisted: Effect.Effect<readonly Background[]>,
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Entry>>,
): Effect.Effect<readonly Job.Info[]> {
  return SynchronizedRef.modifyEffect(jobs, (active) =>
    persisted.pipe(
      Effect.map((rows) => {
        const seen = new Set<string>()
        const items: Job.Info[] = []
        for (const row of rows) {
          seen.add(row.notificationID)
          const live = active.get(row.id)
          const sameGeneration = live?.info.notificationID === row.notificationID
          items.push(
            toItem({
              id: row.id,
              status: sameGeneration ? live.info.status : row.status,
              title: sameGeneration && live.info.title !== undefined ? live.info.title : row.title,
              started: sameGeneration ? live.info.started_at : (row.started_at ?? 0),
              completed: sameGeneration ? live.info.completed_at : row.completed_at,
              recovery: row.recovery,
            }),
          )
        }
        for (const live of active.values()) {
          if (!live.isBackgrounded || !live.recovery) continue
          if (live.info.notificationID && seen.has(live.info.notificationID)) continue
          items.push(
            toItem({
              id: live.info.id,
              status: live.info.status,
              title: live.info.title,
              started: live.info.started_at,
              completed: live.info.completed_at,
              recovery: live.recovery,
            }),
          )
        }
        return [
          items.toSorted((left, right) => left.time.started - right.time.started || left.id.localeCompare(right.id)),
          active,
        ] as const
      }),
    ),
  ).pipe(Effect.withSpan("Job.backgroundJobs"))
}
