import { expect, test } from "bun:test"
import type { Permission } from "@opencode/schema/permission"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { BrowserConnection } from "../src/connection.js"

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
