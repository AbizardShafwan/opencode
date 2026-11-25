export * as PermissionSaved from "./saved.js"

import { eq, inArray } from "drizzle-orm"
import { Cause, Context, DateTime, Effect, Layer, Schema } from "effect"
import { isSqlError } from "effect/sql/SqlError"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import type { Project } from "@opencode/schema/project"
import { Database } from "../database/database.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { PermissionTable } from "./sql.js"
import { PermissionSaved } from "@opencode/schema/permission-saved"

export const ID = PermissionSaved.ID
export type ID = typeof ID.Type

export const Info = PermissionSaved.Info
export type Info = typeof Info.Type

export interface ListInput {
  readonly projectID?: Project.ID
}

export interface AddInput {
  readonly projectID: Project.ID
  readonly action: string
  readonly resources: readonly string[]
}

export interface UpdateInput {
  readonly id: ID
  readonly action?: string
  readonly resource?: string
}

export type CleanupLegacyMode = "prune" | "migrate"

export interface CleanupLegacyInput {
  readonly mode: CleanupLegacyMode
  readonly dryRun?: boolean
  readonly projectID?: Project.ID
}

export interface CleanupLegacyItem {
  readonly id: ID
  readonly projectID: Project.ID
  readonly action: string
  readonly resource: string
  readonly outcome: "deleted" | "migrated" | "deduplicated"
  readonly targetAction?: string
}

export interface CleanupLegacyResult {
  readonly mode: CleanupLegacyMode
  readonly dryRun: boolean
  readonly matched: number
  readonly deleted: number
  readonly migrated: number
  readonly deduplicated: number
  readonly items: ReadonlyArray<CleanupLegacyItem>
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("PermissionSaved.NotFoundError", {
  id: ID,
}) {}

export class ConflictError extends Schema.TaggedError<ConflictError>()("PermissionSaved.ConflictError", {
  id: ID,
  action: Schema.String,
  resource: Schema.String,
}) {}

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Info>>
  readonly add: (input: AddInput) => Effect.Effect<void>
  readonly update: (input: UpdateInput) => Effect.Effect<Info, NotFoundError | ConflictError>
  readonly remove: (id: ID) => Effect.Effect<void>
  readonly cleanupLegacy: (input: CleanupLegacyInput) => Effect.Effect<CleanupLegacyResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PermissionSaved") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const list = Effect.fnUntraced(function* (input?: ListInput) {
      const rows = yield* db
        .select()
        .from(PermissionTable)
        .where(input?.projectID ? eq(PermissionTable.project_id, input.projectID) : undefined)
        .all()
        .pipe(Effect.orDie)
      return rows.map(info)
    })

    const add = Effect.fn("PermissionSaved.add")(function* (input: AddInput) {
      if (!input.resources.length) return
      yield* db
        .insert(PermissionTable)
        .values(
          input.resources.map((resource) => ({
            id: ID.create(),
            project_id: input.projectID,
            action: input.action,
            resource,
          })),
        )
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })

    const update = Effect.fn("PermissionSaved.update")(function* (input: UpdateInput) {
      const current = yield* db
        .select()
        .from(PermissionTable)
        .where(eq(PermissionTable.id, input.id))
        .get()
        .pipe(Effect.orDie)
      if (!current) return yield* new NotFoundError({ id: input.id })
      const action = input.action ?? current.action
      const resource = input.resource ?? current.resource
      // The unique index rejects an edit that duplicates another saved permission in the project.
      const updated = yield* db
        .update(PermissionTable)
        .set({ action, resource })
        .where(eq(PermissionTable.id, input.id))
        .returning()
        .get()
        .pipe(
          Effect.catchIf(isUniqueViolation, () => new ConflictError({ id: input.id, action, resource })),
          Effect.catchTag("EffectDrizzleQueryError", (error) => Effect.die(error)),
        )
      if (!updated) return yield* new NotFoundError({ id: input.id })
      return info(updated)
    })

    const remove = Effect.fn("PermissionSaved.remove")(function* (id: ID) {
      yield* db.delete(PermissionTable).where(eq(PermissionTable.id, id)).run().pipe(Effect.orDie)
    })

    const cleanupLegacy = Effect.fn("PermissionSaved.cleanupLegacy")(function* (input: CleanupLegacyInput) {
      const dryRun = input.dryRun ?? false
      const filter = input.projectID ? eq(PermissionTable.project_id, input.projectID) : undefined

      if (dryRun) {
        const rows = yield* db.select().from(PermissionTable).where(filter).all().pipe(Effect.orDie)
        return summarizeCleanup(input.mode, true, planLegacyCleanup(rows, input.mode))
      }

      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const rows = yield* tx.select().from(PermissionTable).where(filter).all()
            const planned = planLegacyCleanup(rows, input.mode)
            if (planned.length === 0) return summarizeCleanup(input.mode, false, [])

            const toDelete = planned
              .filter((entry) => entry.outcome !== "migrated")
              .map((entry) => entry.row.id)
            for (let offset = 0; offset < toDelete.length; offset += LEGACY_DELETE_BATCH) {
              yield* tx
                .delete(PermissionTable)
                .where(inArray(PermissionTable.id, toDelete.slice(offset, offset + LEGACY_DELETE_BATCH)))
                .run()
            }

            const settled = new Array<CleanupLegacyItem>()
            for (const entry of planned) {
              if (entry.outcome !== "migrated" || entry.targetAction === undefined) {
                settled.push(cleanupItem(entry.row, entry.outcome, entry.targetAction))
                continue
              }
              const targetAction = entry.targetAction
              // Re-check unique collisions at write time in case SQLite collation rejects an update anyway.
              const outcome = yield* tx
                .update(PermissionTable)
                .set({ action: targetAction })
                .where(eq(PermissionTable.id, entry.row.id))
                .run()
                .pipe(
                  Effect.as("migrated" as const),
                  Effect.catchIf(isUniqueViolation, () =>
                    tx
                      .delete(PermissionTable)
                      .where(eq(PermissionTable.id, entry.row.id))
                      .run()
                      .pipe(Effect.as("deduplicated" as const)),
                  ),
                )
              settled.push(cleanupItem(entry.row, outcome, targetAction))
            }

            return summarizeCleanup(input.mode, false, settled)
          }),
        )
        .pipe(Effect.orDie)
    })

    return Service.of({ list, add, update, remove, cleanupLegacy })
  }),
)

const LEGACY_T3_CODE_ACTION = /^t3-code-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_(.+)$/i
const LEGACY_DELETE_BATCH = 500

function canonicalLegacyAction(action: string) {
  const match = LEGACY_T3_CODE_ACTION.exec(action)
  if (!match) return undefined
  return `t3-code_${match[1]}`
}

function dedupeKey(projectID: Project.ID, action: string, resource: string) {
  // SQLite unique constraints are binary-collated while permission matching is case-insensitive on Windows.
  if (process.platform === "win32") return `${projectID}\0${action.toLowerCase()}\0${resource.toLowerCase()}`
  return `${projectID}\0${action}\0${resource}`
}

function cleanupItem(
  row: typeof PermissionTable.$inferSelect,
  outcome: CleanupLegacyItem["outcome"],
  targetAction?: string,
): CleanupLegacyItem {
  return {
    id: row.id,
    projectID: row.project_id,
    action: row.action,
    resource: row.resource,
    outcome,
    ...(targetAction === undefined ? {} : { targetAction }),
  }
}

type PlannedCleanup = {
  readonly row: typeof PermissionTable.$inferSelect
  readonly outcome: CleanupLegacyItem["outcome"]
  readonly targetAction?: string
}

function planLegacyCleanup(
  rows: ReadonlyArray<typeof PermissionTable.$inferSelect>,
  mode: CleanupLegacyMode,
): ReadonlyArray<PlannedCleanup> {
  const occupied = new Set<string>()
  const legacy = new Array<{
    readonly row: typeof PermissionTable.$inferSelect
    readonly targetAction: string
  }>()

  for (const row of rows) {
    const targetAction = canonicalLegacyAction(row.action)
    if (targetAction === undefined) {
      occupied.add(dedupeKey(row.project_id, row.action, row.resource))
      continue
    }
    legacy.push({ row, targetAction })
  }

  // Sort deterministically so duplicate legacy rows retain the oldest row when migrating.
  legacy.sort(
    (a, b) => Number(a.row.time_created) - Number(b.row.time_created) || a.row.id.localeCompare(b.row.id),
  )

  if (mode === "prune") {
    return legacy.map(({ row }) => ({ row, outcome: "deleted" as const }))
  }

  return legacy.map(({ row, targetAction }) => {
    const key = dedupeKey(row.project_id, targetAction, row.resource)
    if (occupied.has(key)) return { row, outcome: "deduplicated" as const, targetAction }
    occupied.add(key)
    return { row, outcome: "migrated" as const, targetAction }
  })
}

function summarizeCleanup(
  mode: CleanupLegacyMode,
  dryRun: boolean,
  items: ReadonlyArray<{
    readonly row?: typeof PermissionTable.$inferSelect
    readonly id?: ID
    readonly projectID?: Project.ID
    readonly action?: string
    readonly resource?: string
    readonly outcome: CleanupLegacyItem["outcome"]
    readonly targetAction?: string
  }>,
): CleanupLegacyResult {
  const normalized = items.map((entry) =>
    entry.row ? cleanupItem(entry.row, entry.outcome, entry.targetAction) : (entry as CleanupLegacyItem),
  )
  return {
    mode,
    dryRun,
    matched: normalized.length,
    deleted: normalized.filter((item) => item.outcome === "deleted").length,
    migrated: normalized.filter((item) => item.outcome === "migrated").length,
    deduplicated: normalized.filter((item) => item.outcome === "deduplicated").length,
    items: normalized,
  }
}

// Durable Object SQLite throws a plain Error without SQLite codes, so its unique violation is only in the message.
const isUniqueViolation = (error: EffectDrizzleQueryError) => {
  const sql = Cause.isCause(error.cause) ? Cause.squash(error.cause) : error.cause
  if (!isSqlError(sql)) return false
  return (
    sql.reason._tag === "UniqueViolation" ||
    (sql.reason.cause instanceof Error && sql.reason.cause.message.includes("SQLITE_CONSTRAINT_UNIQUE"))
  )
}

const info = (row: typeof PermissionTable.$inferSelect): Info => ({
  id: row.id,
  projectID: row.project_id,
  action: row.action,
  resource: row.resource,
  time: {
    created: DateTime.makeUnsafe(row.time_created),
    updated: DateTime.makeUnsafe(row.time_updated),
  },
})

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
