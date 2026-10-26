import { Show, type JSX } from "solid-js"
import { useI18n } from "@opencode/ui/context/i18n"

/** Decorative status marker; the adjacent label supplies its accessible meaning. */
export function ToolStatusMark(props: { status?: string }) {
  return <span data-slot="tool-status-mark" data-status={props.status} aria-hidden="true" />
}

/** Optional status detail for the rune-and-line presentation, hidden by other designs. */
export function ToolStatusLabel(props: { status?: string; label?: string; children?: JSX.Element }) {
  const i18n = useI18n()
  const label = () => {
    if (props.label) return props.label
    if (props.status === "streaming") return i18n.t("ui.tool.status.running")
    if (props.status === "running") return i18n.t("ui.tool.status.running")
    if (props.status === "completed") return i18n.t("ui.tool.status.done")
    if (props.status === "error") return i18n.t("ui.tool.status.failed")
    if (props.status === "idle") return i18n.t("ui.tool.status.idle")
  }

  return (
    <Show when={label()}>
      <span data-slot="tool-status-label" data-status={props.status}>
        {label()}
        {props.children}
      </span>
    </Show>
  )
}
