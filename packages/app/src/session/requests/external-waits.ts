import type { JobExternal, JobInfo } from "@opencode/client/promise"
import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { OpenCodeEventStream } from "@/runtime/server/client"

export function createExternalWaits(input: {
  sessionID: () => string | undefined
  directory: () => string
  connected: () => boolean
  list: (query: { sessionID: string; kind: "external"; location: { directory: string } }) => Promise<JobInfo[]>
  events: Pick<OpenCodeEventStream, "on">
}) {
  const [store, setStore] = createStore<{ waits: JobExternal[] }>({ waits: [] })
  // A newer load or session change supersedes any in-flight list response.
  const turn = { value: 0 }

  const load = (sessionID: string, directory: string) => {
    const current = ++turn.value
    void input.list({ sessionID, kind: "external", location: { directory } }).then(
      (items) => {
        if (current !== turn.value || input.sessionID() !== sessionID || input.directory() !== directory) return
        setStore(
          "waits",
          items.filter((item): item is JobExternal => item.kind === "external" && item.status === "running"),
        )
      },
      () => undefined,
    )
  }

  const refresh = () => {
    const id = input.sessionID()

    if (!id || !input.connected()) return
    load(id, input.directory())
  }

  onCleanup(
    input.events.on("session.external_wait.changed", (event) => {
      if (event.data.sessionID !== input.sessionID()) return
      refresh()
    }),
  )
  onCleanup(
    input.events.on("mcp.status.changed", () => {
      refresh()
    }),
  )
  onCleanup(
    input.events.on("session.deleted", (event) => {
      if (event.data.sessionID !== input.sessionID()) return
      turn.value++
      setStore("waits", [])
    }),
  )
  onCleanup(
    input.events.on("session.archived", (event) => {
      if (event.data.sessionID !== input.sessionID()) return
      turn.value++
      setStore("waits", [])
    }),
  )

  createEffect(
    on(input.sessionID, () => {
      turn.value++
      setStore("waits", [])
    }),
  )

  createEffect(
    on(
      () => [input.sessionID(), input.directory(), input.connected()] as const,
      ([id, directory, connected]) => {
        if (!id || !connected) return
        load(id, directory)
      },
    ),
  )

  return () => store.waits
}
