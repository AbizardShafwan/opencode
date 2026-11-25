import { expect } from "bun:test"
import { PermissionSaved } from "@opencode/schema/permission-saved"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const AskResponse = Schema.Struct({ data: Schema.Struct({ id: Schema.String, effect: Schema.String }) })
const SavedList = Schema.Struct({ data: Schema.Array(Schema.toEncoded(PermissionSaved.Info)) })
const SavedResponse = Schema.Struct({ data: Schema.toEncoded(PermissionSaved.Info) })

it.live("edits saved permissions through PATCH", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const request = (path: string, method: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        return { status: response.status, body: response.status === 204 ? undefined : await response.json() }
      })

    const session = Schema.decodeUnknownSync(SessionResponse)(
      (yield* request("/api/session", "POST", {
        permissions: [{ action: "deploy", resource: "*", effect: "ask" }],
      })).body,
    )
    // Saved permissions are only created by answering "always", so save two through the real request flow.
    for (const resource of ["src/*", "docs/*"]) {
      const asked = Schema.decodeUnknownSync(AskResponse)(
        (yield* request(`/api/session/${session.data.id}/permission`, "POST", {
          action: "deploy",
          resources: [resource],
          save: [resource],
        })).body,
      )
      expect(asked.data.effect).toBe("ask")
      expect(
        (yield* request(`/api/session/${session.data.id}/permission/${asked.data.id}/reply`, "POST", {
          decision: "always",
        })).status,
      ).toBe(204)
    }
    const saved = Schema.decodeUnknownSync(SavedList)((yield* request("/api/permission/saved", "GET")).body)
    const src = saved.data.find((item) => item.resource === "src/*")!

    const updated = yield* request(`/api/permission/saved/${src.id}`, "PATCH", { resource: "src/allowed.ts" })
    expect(updated.status).toBe(200)
    expect(Schema.decodeUnknownSync(SavedResponse)(updated.body).data).toMatchObject({
      id: src.id,
      action: "deploy",
      resource: "src/allowed.ts",
    })
    expect(
      Schema.decodeUnknownSync(SavedList)((yield* request("/api/permission/saved", "GET")).body)
        .data.map((item) => item.resource)
        .toSorted(),
    ).toEqual(["docs/*", "src/allowed.ts"])

    expect((yield* request(`/api/permission/saved/${src.id}`, "PATCH", { resource: "docs/*" })).status).toBe(409)
    expect((yield* request("/api/permission/saved/psv_missing", "PATCH", { resource: "x" })).status).toBe(404)
  }).pipe(Effect.scoped),
)

const CleanupLegacyResponse = Schema.Struct({
  data: Schema.Struct({
    mode: Schema.Literals(["prune", "migrate"]),
    dryRun: Schema.Boolean,
    matched: Schema.Int,
    deleted: Schema.Int,
    migrated: Schema.Int,
    deduplicated: Schema.Int,
    items: Schema.Array(
      Schema.Struct({
        id: PermissionSaved.ID,
        projectID: Schema.String,
        action: Schema.String,
        resource: Schema.String,
        outcome: Schema.Literals(["deleted", "migrated", "deduplicated"]),
        targetAction: Schema.optional(Schema.String),
      }),
    ),
  }),
})

it.live("exposes opt-in legacy saved permission migrate and prune via POST /api/permission/saved/legacy", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const request = (path: string, method: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://opencode.local${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        return { status: response.status, body: response.status === 204 ? undefined : await response.json() }
      })

    const session = Schema.decodeUnknownSync(SessionResponse)(
      (yield* request("/api/session", "POST", {
        permissions: [{ action: "*", resource: "*", effect: "ask" }],
      })).body,
    )

    const saveAlways = (action: string, resource: string) =>
      Effect.gen(function* () {
        const asked = Schema.decodeUnknownSync(AskResponse)(
          (yield* request(`/api/session/${session.data.id}/permission`, "POST", {
            action,
            resources: [resource],
            save: [resource],
          })).body,
        )
        expect(asked.data.effect).toBe("ask")
        expect(
          (yield* request(`/api/session/${session.data.id}/permission/${asked.data.id}/reply`, "POST", {
            decision: "always",
          })).status,
        ).toBe(204)
      })

    yield* saveAlways("t3-code_pull_request_read", "*")
    yield* saveAlways("t3-code-550e8400-e29b-41d4-a716-446655440000_pull_request_read", "*")
    yield* saveAlways("T3-CODE-11111111-1111-1111-1111-111111111111_open_terminal", "*")
    yield* saveAlways("t3-code-22222222-2222-2222-2222-222222222222_open_terminal", "*")

    const dryMigrate = yield* request("/api/permission/saved/legacy", "POST", { mode: "migrate", dryRun: true })
    expect(dryMigrate.status).toBe(200)
    expect(Schema.decodeUnknownSync(CleanupLegacyResponse)(dryMigrate.body).data).toMatchObject({
      mode: "migrate",
      dryRun: true,
      matched: 3,
      migrated: 1,
      deduplicated: 2,
      deleted: 0,
    })

    const migrated = yield* request("/api/permission/saved/legacy", "POST", { mode: "migrate" })
    expect(migrated.status).toBe(200)
    expect(Schema.decodeUnknownSync(CleanupLegacyResponse)(migrated.body).data).toMatchObject({
      mode: "migrate",
      dryRun: false,
      matched: 3,
      migrated: 1,
      deduplicated: 2,
      deleted: 0,
    })
    expect(
      Schema.decodeUnknownSync(SavedList)((yield* request("/api/permission/saved", "GET")).body)
        .data.map((item) => item.action)
        .toSorted(),
    ).toEqual(["t3-code_open_terminal", "t3-code_pull_request_read"])

    yield* saveAlways("t3-code-33333333-3333-3333-3333-333333333333_preview_status", "*")
    const pruned = yield* request("/api/permission/saved/legacy", "POST", { mode: "prune" })
    expect(pruned.status).toBe(200)
    const prunedData = Schema.decodeUnknownSync(CleanupLegacyResponse)(pruned.body).data
    expect(prunedData).toMatchObject({
      mode: "prune",
      dryRun: false,
      matched: 1,
      deleted: 1,
      migrated: 0,
      deduplicated: 0,
    })
    expect(prunedData.items[0]).not.toHaveProperty("targetAction")
    expect(
      Schema.decodeUnknownSync(SavedList)((yield* request("/api/permission/saved", "GET")).body)
        .data.map((item) => item.action)
        .toSorted(),
    ).toEqual(["t3-code_open_terminal", "t3-code_pull_request_read"])
  }).pipe(Effect.scoped),
)
