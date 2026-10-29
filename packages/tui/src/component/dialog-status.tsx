import { useTheme } from "../context/theme"
import { DIALOG_INSET, DialogHeader, DialogLayout, dialogWidth } from "../ui/dialog"
import { useData } from "../context/data"
import { useClient } from "../context/client"
import { useLocal } from "../context/local"
import { useLocation } from "../context/location"
import { duration } from "../util/locale"
import type { UsageInfo, UsageWindow } from "@opencode/client/promise"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Match, Switch, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"

export function DialogStatus() {
  const data = useData()
  const client = useClient()
  const local = useLocal()
  const location = useLocation()
  const theme = useTheme().surface("dialog")
  const terminal = useTerminalDimensions()
  // `Dialog` caps its medium width to the terminal and `DialogLayout` insets both sides.
  const columns = () => Math.min(dialogWidth("medium"), terminal().width - 2) - DIALOG_INSET * 2

  const mcp = createMemo(() => data.location.mcp.server.list() ?? [])
  const color = (status: string) => {
    if (status === "connected") return theme.text.feedback.success.base
    if (status === "failed") return theme.text.feedback.error.base
    if (status === "needs_auth") return theme.text.feedback.warning.base
    return theme.text.muted
  }

  const [usage, setUsage] = createSignal<UsageInfo>()
  createEffect(() => {
    const providerID = local.model.current()?.providerID
    if (!providerID) {
      setUsage(undefined)
      return
    }

    let active = true
    onCleanup(() => {
      active = false
    })

    const target = location.ref ?? data.location.default()
    void client.api.usage
      .read({ providerID, location: { directory: target.directory } })
      .then((response) => {
        if (active) setUsage(response.data ?? undefined)
      })
      .catch(() => {
        if (active) setUsage(undefined)
      })
  })

  return (
    <DialogLayout header={<DialogHeader title="Status" />}>
      <box gap={1}>
        <Show when={mcp().length > 0} fallback={<text fg={theme.text.base}>No MCP servers</text>}>
          <box>
            <text fg={theme.text.base}>
              {mcp().length} MCP server{mcp().length === 1 ? "" : "s"}
            </text>
            <For each={mcp()}>
              {(item) => (
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} style={{ fg: color(item.status.status) }}>
                    •
                  </text>
                  <text fg={theme.text.base} wrapMode="word">
                    <b>{item.name}</b>{" "}
                    <span style={{ fg: theme.text.muted }}>
                      <Switch fallback={item.status.status}>
                        <Match when={item.status.status === "connected"}>Connected</Match>
                        <Match when={item.status.status === "failed" && item.status}>{(val) => val().error}</Match>
                        <Match when={item.status.status === "disabled"}>Disabled in configuration</Match>
                        <Match when={item.status.status === "needs_auth" && item.status}>
                          {(val) => `Needs authentication: ${val().error}`}
                        </Match>
                      </Switch>
                    </span>
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>

        <Show when={usage()}>
          {(value) => (
            <box>
              <text fg={theme.text.base}>{usageTitle(value().source)}</text>
              <For each={value().balances ?? []}>
                {(balance) => (
                  <text fg={theme.text.base} wrapMode="word">
                    {balance.currency}{" "}
                    <span style={{ fg: theme.text.muted }}>
                      {balance.total}
                      {balance.granted ? ` · granted ${balance.granted}` : ""}
                      {balance.toppedUp ? ` · topped up ${balance.toppedUp}` : ""}
                    </span>
                  </text>
                )}
              </For>
              <UsageSection windows={value().windows} align={allWindows(value())} columns={columns()} />
              <For each={value().groups ?? []}>
                {(group) => (
                  <box>
                    <text fg={theme.text.muted}>{group.label}</text>
                    <UsageSection windows={group.windows} align={allWindows(value())} columns={columns()} />
                  </box>
                )}
              </For>
            </box>
          )}
        </Show>
      </box>
    </DialogLayout>
  )
}

function usageTitle(source: UsageInfo["source"]) {
  switch (source) {
    case "deepseek-balance":
      return "DeepSeek balance"
    case "antigravity-quota":
      return "Antigravity quota"
    case "codex-rate-limit":
      return "Codex usage"
    case "claude-code-usage":
      return "Claude Code usage"
    case "ollama-balance":
      return "Ollama usage"
  }
}

const BAR_MAX = 20
const BAR_MIN = 6

/** Every window of one provider, so the bars of its pools stay one width. */
function allWindows(info: UsageInfo) {
  return [...(info.windows ?? []), ...(info.groups ?? []).flatMap((group) => group.windows)]
}

/**
 * The windows of one source or pool. They share the snapshot's bar width so the bars line up, and
 * the snapshot's choice between a reset beside the percentage and a reset on its own line.
 */
function UsageSection(props: {
  windows: readonly UsageWindow[] | undefined
  align: readonly UsageWindow[]
  columns: number
}) {
  const theme = useTheme().surface("dialog")

  return (
    <For each={props.windows ?? []}>
      {(window) => {
        const row = () => quotaRow(props.align, window, props.columns)

        return (
          <box>
            <text fg={theme.text.base} wrapMode="word">
              {window.label}
              <span style={{ fg: theme.text.base }}>{row().bar ? ` ${row().bar}` : ""}</span>
              <span style={{ fg: theme.text.muted }}>{` ${row().meta}`}</span>
            </text>
            <Show when={row().detail}>
              {(detail) => (
                <text fg={theme.text.muted} wrapMode="word">
                  {detail()}
                </text>
              )}
            </Show>
          </box>
        )
      }}
    </For>
  )
}

function quotaRow(windows: readonly UsageWindow[], window: UsageWindow, columns: number) {
  const percent = `${Math.round(window.remainingPercent)}% left`
  const reset = resets(window.resetsAt)
  const section = quotaSection(windows, columns)

  if (!section) return { meta: percent, detail: reset }

  return {
    bar: drawBar(window.remainingPercent, section.segments),
    meta: section.inlineReset && reset ? `${percent} · ${reset}` : percent,
    detail: section.inlineReset ? undefined : reset,
  }
}

/**
 * One bar width for every row that shares it, so the bars line up: widest first with the resets
 * beside the percentages, then with the resets on their own line, then no bars at all. The
 * percentage is the actionable value, so it outlives the bar.
 */
function quotaSection(windows: readonly UsageWindow[], columns: number) {
  const fit = (inlineReset: boolean) =>
    Math.min(
      ...windows.map((window) => {
        const percent = `${Math.round(window.remainingPercent)}% left`
        const reset = resets(window.resetsAt)
        const meta = inlineReset && reset ? `${percent} · ${reset}` : percent
        // `4` counts the two spaces and the bar's brackets.
        return columns - window.label.length - meta.length - 4
      }),
    )

  const inline = fit(true)

  if (inline >= BAR_MIN) return { segments: Math.min(BAR_MAX, inline), inlineReset: true }

  const separate = fit(false)

  if (separate >= BAR_MIN) return { segments: Math.min(BAR_MAX, separate), inlineReset: false }
}

function resets(at: number | undefined) {
  if (at === undefined) return undefined
  const left = at - Date.now()
  if (left <= 0) return "resets now"
  return `resets in ${duration(left)}`
}

/**
 * Fills the bar with what is left, so an exhausted window reads as an empty track. A share that
 * rounds to no cells still fills one, so a nearly spent window never looks spent.
 */
function drawBar(remaining: number, segments: number) {
  const share = (Math.min(100, Math.max(0, remaining)) / 100) * segments
  const filled = remaining > 0 ? Math.max(1, Math.round(share)) : 0
  const cells = Math.min(segments, filled)
  return `[${"█".repeat(cells)}${"░".repeat(segments - cells)}]`
}
