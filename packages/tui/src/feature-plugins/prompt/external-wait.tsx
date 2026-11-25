import type { JobExternal } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, on, onCleanup, Show, type Accessor } from "solid-js"
import { useTheme } from "../../context/theme"
import { DialogHeader, DialogLayout } from "../../ui/dialog"
import { duration } from "../../util/locale"

/**
 * Active external wait leases for a Session, fetched from `/api/experimental/job` when the Session changes or the
 * server reconnects and kept current via `session.external_wait.changed` and MCP status transitions.
 */
export function createExternalWaits(context: Plugin.Context, sessionID: Accessor<string | undefined>) {
  const [waits, setWaits] = createSignal<readonly JobExternal[]>([])
  // A newer load or session change supersedes any in-flight list response.
  const turn = { value: 0 }
  const load = (id: string, directoryOverride?: string) => {
    const current = ++turn.value
    const directory = directoryOverride ?? context.data.session.get(id)?.location.directory ?? context.location?.directory
    void context.client.job
      .list({
        sessionID: id,
        kind: "external",
        ...(directory ? { location: { directory } } : {}),
      })
      .then(
        (response) => {
          if (current !== turn.value || sessionID() !== id) return
          setWaits(
            response.data.data.filter(
              (item): item is JobExternal => item.kind === "external" && item.status === "running",
            ),
          )
        },
        () => undefined,
      )
  }

  onCleanup(
    context.data.on("session.external_wait.changed", (event) => {
      if (event.data.sessionID !== sessionID()) return
      load(event.data.sessionID, event.location?.directory)
    }),
  )
  onCleanup(
    context.data.on("mcp.status.changed", () => {
      const id = sessionID()
      if (id) load(id)
    }),
  )
  onCleanup(
    context.data.on("session.moved", (event) => {
      if (event.data.sessionID !== sessionID()) return
      load(event.data.sessionID, event.data.location.directory)
    }),
  )
  onCleanup(
    context.data.on("session.deleted", (event) => {
      if (event.data.sessionID !== sessionID()) return
      turn.value++
      setWaits([])
    }),
  )
  onCleanup(
    context.data.on("session.archived", (event) => {
      if (event.data.sessionID !== sessionID()) return
      turn.value++
      setWaits([])
    }),
  )
  onCleanup(
    context.data.on("server.connected", () => {
      const id = sessionID()
      if (id) load(id)
    }),
  )
  createEffect(
    on(sessionID, (id) => {
      turn.value++
      setWaits([])
      if (id) load(id)
    }),
  )
  return waits
}

function waitLabel(count: number) {
  return `${count} wait${count === 1 ? "" : "s"}`
}

function formatExpiry(expiresAt: number) {
  const remaining = expiresAt - Date.now()
  if (remaining <= 0) return "expired"
  return `expires in ${duration(remaining)}`
}

/**
 * Compact external-wait indicator beside `GoalStatus` in the prompt footer; clicking opens a dialog listing each
 * active wait's description, source, server, and expiry.
 */
export function ExternalWaitStatus(props: {
  context: Plugin.Context
  waits: Accessor<readonly JobExternal[]>
}) {
  const [hovered, setHovered] = createSignal(false)

  return (
    <Show when={props.waits().length > 0}>
      <box
        flexShrink={0}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseUp={() => showExternalWaits(props.context, props.waits)}
      >
        <text fg={hovered() ? props.context.theme.text.base : props.context.theme.text.muted} wrapMode="none">
          ◷ {waitLabel(props.waits().length)}
        </text>
      </box>
    </Show>
  )
}

function showExternalWaits(context: Plugin.Context, waits: Accessor<readonly JobExternal[]>) {
  if (waits().length === 0) return
  context.ui.dialog.show(() => <ExternalWaitDialog waits={waits} />)
}

function ExternalWaitDialog(props: { waits: Accessor<readonly JobExternal[]> }) {
  const theme = useTheme().surface("dialog")

  return (
    <DialogLayout header={<DialogHeader title="External waits" />}>
      <Show when={props.waits().length > 0} fallback={<text fg={theme.text.muted}>No active external waits.</text>}>
        <box gap={1}>
          <For each={props.waits()}>
            {(wait) => (
              <box>
                <text fg={theme.text.base} wrapMode="word">
                  ◷ {wait.description}
                </text>
                <text fg={theme.text.muted} wrapMode="word">
                  {wait.source} · {wait.server} · {formatExpiry(wait.expiresAt)}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </DialogLayout>
  )
}
