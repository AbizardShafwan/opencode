import { describe, expect, test } from "bun:test"
import type { JobInfo, OpenCodeEvent } from "@opencode/client/promise"
import { createRoot, createSignal } from "solid-js"
import { createExternalWaits } from "@/session/requests/external-waits"

type ExternalWaitEvent = Extract<
  OpenCodeEvent,
  { type: "session.external_wait.changed" | "mcp.status.changed" | "session.deleted" | "session.archived" }
>

function createWait(id: string, sessionID: string, status: JobInfo["status"] = "running"): JobInfo {
  return {
    kind: "external",
    id,
    sessionID,
    status,
    time: { started: 1 },
    waitID: `wait-${id}`,
    source: "github.pr_watch",
    server: "github",
    description: `Wait ${id}`,
    expiresAt: 100_000,
  }
}

function createFixture(initialConnected = true) {
  const listeners = new Map<string, Set<(event: OpenCodeEvent) => void>>()

  const calls: {
    query: { sessionID: string; kind: "external"; location: { directory: string } }
    resolve: (items: JobInfo[]) => void
    reject: (error: Error) => void
  }[] = []

  const [sessionID, setSessionID] = createSignal<string | undefined>("ses-1")
  const [directory, setDirectory] = createSignal("/repo-a")
  const [connected, setConnected] = createSignal(initialConnected)

  const emit = (event: ExternalWaitEvent) => listeners.get(event.type)?.forEach((handler) => handler(event))

  const state = createRoot((dispose) => ({
    dispose,
    waits: createExternalWaits({
      sessionID,
      directory,
      connected,
      list: (query) =>
        new Promise<JobInfo[]>((resolve, reject) => {
          calls.push({ query, resolve, reject })
        }),
      events: {
        on(type, handler) {
          const set = listeners.get(type) ?? new Set()
          // SAFETY: `emit` dispatches only events matching the subscribed `type` key.
          const listener = handler as (event: OpenCodeEvent) => void
          set.add(listener)
          listeners.set(type, set)

          return () => set.delete(listener)
        },
      },
    }),
  }))

  return {
    waits: state.waits,
    calls,
    listeners,
    setSessionID,
    setDirectory,
    setConnected,
    emit,
    dispose: state.dispose,
  }
}

describe("createExternalWaits", () => {
  test("loads active waits on connect, filters completed jobs, and reloads on relevant events", async () => {
    const fixture = createFixture(false)

    try {
      expect(fixture.calls).toHaveLength(0)

      // Events are ignored while disconnected.
      fixture.emit({ id: "evt", created: 0, type: "session.external_wait.changed", data: { sessionID: "ses-1" } })
      expect(fixture.calls).toHaveLength(0)

      fixture.setConnected(true)
      await Promise.resolve()
      expect(fixture.calls).toHaveLength(1)
      expect(fixture.calls[0]?.query).toEqual({
        sessionID: "ses-1",
        kind: "external",
        location: { directory: "/repo-a" },
      })

      fixture.calls[0]?.resolve([createWait("1", "ses-1"), createWait("2", "ses-1", "completed")])
      await Promise.resolve()
      expect(fixture.waits().map((item) => item.id)).toEqual(["1"])

      // Unrelated session events do not trigger a fetch.
      fixture.emit({ id: "evt", created: 0, type: "session.external_wait.changed", data: { sessionID: "ses-other" } })
      expect(fixture.calls).toHaveLength(1)

      // MCP status transitions for another directory are ignored; matching directory refreshes and restores waits.
      fixture.emit({
        id: "evt",
        created: 0,
        type: "mcp.status.changed",
        location: { directory: "/repo-other" },
        data: { server: "github" },
      })
      expect(fixture.calls).toHaveLength(1)

      fixture.emit({
        id: "evt",
        created: 0,
        type: "mcp.status.changed",
        location: { directory: "/repo-a" },
        data: { server: "github" },
      })
      expect(fixture.calls).toHaveLength(2)
      fixture.calls[1]?.resolve([])
      await Promise.resolve()
      expect(fixture.waits()).toEqual([])

      fixture.emit({
        id: "evt",
        created: 0,
        type: "mcp.status.changed",
        data: { server: "github" },
      })
      expect(fixture.calls).toHaveLength(3)
      fixture.calls[2]?.resolve([createWait("3", "ses-1")])
      await Promise.resolve()
      expect(fixture.waits().map((item) => item.id)).toEqual(["3"])

      // Failed list calls do not wipe existing waits or reject unhandled.
      fixture.emit({ id: "evt", created: 0, type: "session.external_wait.changed", data: { sessionID: "ses-1" } })
      expect(fixture.calls).toHaveLength(4)
      fixture.calls[3]?.reject(new Error("offline"))
      await Promise.resolve()
      expect(fixture.waits().map((item) => item.id)).toEqual(["3"])
    } finally {
      fixture.dispose()
    }

    expect([...fixture.listeners.values()].every((set) => set.size === 0)).toBeTrue()
  })

  test("clears immediately on delete/archive/session switch and drops stale responses", async () => {
    const fixture = createFixture(true)

    try {
      expect(fixture.calls).toHaveLength(1)
      fixture.calls[0]?.resolve([createWait("1", "ses-1")])
      await Promise.resolve()
      expect(fixture.waits().map((item) => item.id)).toEqual(["1"])

      fixture.emit({ id: "evt", created: 0, type: "session.deleted", data: { sessionID: "ses-other" } })
      expect(fixture.waits()).toHaveLength(1)
      fixture.emit({ id: "evt", created: 0, type: "session.deleted", data: { sessionID: "ses-1" } })
      expect(fixture.waits()).toEqual([])

      fixture.emit({ id: "evt", created: 0, type: "session.external_wait.changed", data: { sessionID: "ses-1" } })
      expect(fixture.calls).toHaveLength(2)
      fixture.calls[1]?.resolve([createWait("2", "ses-1")])
      await Promise.resolve()
      expect(fixture.waits().map((item) => item.id)).toEqual(["2"])

      fixture.emit({ id: "evt", created: 0, type: "session.archived", data: { sessionID: "ses-1" } })
      expect(fixture.waits()).toEqual([])

      // Keep a response in flight while switching session and directory.
      fixture.emit({ id: "evt", created: 0, type: "session.external_wait.changed", data: { sessionID: "ses-1" } })
      expect(fixture.calls).toHaveLength(3)
      fixture.setSessionID("ses-2")
      fixture.setDirectory("/repo-b")
      await Promise.resolve()
      expect(fixture.calls.length).toBeGreaterThanOrEqual(4)
      const latest = fixture.calls[fixture.calls.length - 1]!
      expect(latest.query).toEqual({
        sessionID: "ses-2",
        kind: "external",
        location: { directory: "/repo-b" },
      })

      latest.resolve([createWait("new", "ses-2")])
      await Promise.resolve()
      fixture.calls[2]?.resolve([createWait("stale", "ses-1")])
      await Promise.resolve()
      expect(fixture.waits().map((item) => item.id)).toEqual(["new"])
    } finally {
      fixture.dispose()
    }
  })
})
