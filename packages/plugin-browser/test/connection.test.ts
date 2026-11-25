import { expect, test } from "bun:test"
import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import type { Permission } from "@opencode/schema/permission"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { Effect, Exit, Fiber } from "effect"
import { BrowserConnection } from "../src/connection.js"
import { Browser } from "../src/rpc.js"

const allow = { action: "browser", resource: "*", effect: "allow" } satisfies Permission.Rule
const narrow = { action: "browser", resource: "https://example.com", effect: "allow" } satisfies Permission.Rule
const workspace = { directory: AbsolutePath.make("/workspace") }

const session = (id: string, permissions: Permission.Ruleset, directory = workspace.directory) =>
  ({ id: Session.ID.make(id), permissions, location: { directory } }) as Session.Info

test("prunes stale blanket browser grants across every page", async () => {
  const updates: Array<{ sessionID: string; permissions: Permission.Ruleset }> = []
  const pages = [
    {
      data: [
        session("ses_one", [allow, narrow]),
        // Another Location may still hold a live attachment, so its grant is not ours to prune.
        session("ses_other", [allow], AbsolutePath.make("/elsewhere")),
      ],
      cursor: { next: "page-2" as Session.ListCursor },
    },
    {
      data: [session("ses_two", [narrow]), session("ses_three", [])],
      cursor: {},
    },
  ]
  const sessions: Parameters<typeof BrowserConnection.pruneStaleGrants>[0] = {
    list: (input) => Effect.succeed(pages[input?.cursor === undefined ? 0 : 1]!),
    update: (input) =>
      Effect.sync(() => {
        updates.push({ sessionID: input.sessionID, permissions: input.permissions! })
      }),
  }

  await Effect.runPromise(BrowserConnection.pruneStaleGrants(sessions, workspace))

  // Only the blanket allow in this Location goes; a narrower browser rule and other sessions stay untouched.
  expect(updates.map((entry) => entry.sessionID)).toEqual(["ses_one"])
  expect(updates[0]?.permissions).toEqual([narrow])
})

test("matches Windows and UNC directory equivalents in pruneStaleGrants and attach", async () => {
  const updates: Array<{ sessionID: string; permissions: Permission.Ruleset }> = []
  const winSession = session("ses_win", [allow], AbsolutePath.make("C:\\Work\\App"))
  const uncSession = session("ses_unc", [allow], AbsolutePath.make("\\\\Server\\Share\\Repo\\"))
  const otherSession = session("ses_other", [allow], AbsolutePath.make("/elsewhere"))

  await Effect.runPromise(
    BrowserConnection.pruneStaleGrants(
      {
        list: () => Effect.succeed({ data: [winSession, otherSession], cursor: {} }),
        update: (input) =>
          Effect.sync(() => {
            updates.push({ sessionID: input.sessionID, permissions: input.permissions ?? [] })
          }),
      },
      { directory: AbsolutePath.make("c:/work/app/") },
    ),
  )
  expect(updates.map((entry) => entry.sessionID)).toEqual(["ses_win"])

  await Effect.runPromise(
    BrowserConnection.pruneStaleGrants(
      {
        list: () => Effect.succeed({ data: [uncSession, otherSession], cursor: {} }),
        update: (input) =>
          Effect.sync(() => {
            updates.push({ sessionID: input.sessionID, permissions: input.permissions ?? [] })
          }),
      },
      { directory: AbsolutePath.make("//server/share/repo") },
    ),
  )
  expect(updates.map((entry) => entry.sessionID)).toEqual(["ses_win", "ses_unc"])

  const records = new Map<Session.ID, Session.Info>([
    [winSession.id, session("ses_win", [], AbsolutePath.make("C:\\Work\\App"))],
    [otherSession.id, session("ses_other", [], AbsolutePath.make("/elsewhere"))],
  ])
  let registered: RpcHandlers<typeof Browser.Definition> | undefined
  const emitted: unknown[] = []
  const attached = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // SAFETY: Test double implements the subset of Context methods called by BrowserConnection.make.
        const ctx = {
          agent: { transform: () => Effect.void },
          location: { directory: AbsolutePath.make("c:/work/app/") },
          event: { subscribe: () => Effect.die("unused") },
          session: {
            list: () => Effect.succeed({ data: [], cursor: {} }),
            get: ({ sessionID }: { sessionID: Session.ID }) => Effect.sync(() => records.get(sessionID)!),
            update: ({
              sessionID,
              permissions,
            }: {
              sessionID: Session.ID
              permissions?: Session.Info["permissions"]
            }) =>
              Effect.sync(() => {
                const current = records.get(sessionID)!
                records.set(sessionID, { ...current, permissions })
              }),
          },
          rpc: {
            register: (_definition: unknown, handlers: RpcHandlers<typeof Browser.Definition>) => {
              registered = handlers
              return Effect.succeed({
                dispose: Effect.void,
                events: {
                  emit: (_event: string, data: unknown) =>
                    Effect.sync(() => {
                      emitted.push(data)
                    }),
                },
              })
            },
          },
        } as unknown as Parameters<typeof BrowserConnection.make>[0]

        yield* BrowserConnection.make(ctx)
        const handlers = registered!
        // SAFETY: Test call context supplies the error constructor expected by Browser.Definition handlers.
        const errorContext = {
          error: (code: string, message: string) => ({ code, message }),
        } as unknown as Parameters<typeof handlers.attach>[1]

        const badExit = yield* handlers
          .attach({ sessionID: otherSession.id, connectionID: "conn_bad", version: 4 }, errorContext)
          .pipe(Effect.exit)
        expect(Exit.isFailure(badExit)).toBe(true)

        const firstFiber = yield* handlers
          .attach({ sessionID: winSession.id, connectionID: "conn_1", version: 4 }, errorContext)
          .pipe(Effect.forkScoped)
        while (emitted.length === 0) {
          yield* Effect.yieldNow
        }
        const secondFiber = yield* handlers
          .attach({ sessionID: winSession.id, connectionID: "conn_2", version: 4 }, errorContext)
          .pipe(Effect.forkScoped)
        const firstResult = yield* Fiber.join(firstFiber)
        while (emitted.length < 2) {
          yield* Effect.yieldNow
        }
        yield* Fiber.interrupt(secondFiber)
        return firstResult
      }),
    ),
  )

  expect(attached).toBe("replaced")
  expect(emitted).toContainEqual({ type: "attached", connectionID: "conn_1", version: 4 })
  expect(emitted).toContainEqual({ type: "attached", connectionID: "conn_2", version: 4 })
})
