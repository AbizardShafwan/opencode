import { useTheme } from "@opencode/ui/theme/context"
import { Show } from "solid-js"
import { isNorseTheme } from "./norse"

const RUNES = ["ᛗ", "ᚨ", "ᚱ", "ᛟ", "ᛉ"]

export function NorseBackdrop() {
  const theme = useTheme()

  return (
    <Show when={isNorseTheme(theme.themeId())}>
      <div data-slot="norse-backdrop" aria-hidden="true">
        <div data-slot="norse-aurora" />
        <div data-slot="norse-runes">
          {RUNES.map((rune) => (
            <span>{rune}</span>
          ))}
        </div>
      </div>
    </Show>
  )
}
