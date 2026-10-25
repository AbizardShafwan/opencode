import { RGBA, TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { logo } from "../logo"

const GOLD = RGBA.fromHex("#B8860B")

export function Logo() {
  const dimensions = useTerminalDimensions()
  const lines = () => (dimensions().width < 31 ? logo.mark : logo.lines)

  return (
    <box>
      <For each={lines()}>
        {(line) => (
          <box flexDirection="row">
            <text fg={GOLD} attributes={TextAttributes.BOLD} selectable={false}>
              {line}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}
