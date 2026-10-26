import { useTheme } from "@opencode/ui/theme/context"
import { Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { isNorseTheme, NORSE_COPY } from "@/theme/norse"

export function NorseWelcome() {
  const theme = useTheme()
  const language = useLanguage()

  return (
    <Show when={isNorseTheme(theme.themeId())}>
      <div data-component="norse-welcome">
        <h1 data-slot="norse-welcome-greeting">{language.t(NORSE_COPY.greeting)}</h1>
        <p data-slot="norse-welcome-subtitle">{language.t(NORSE_COPY.subtitle)}</p>
      </div>
    </Show>
  )
}
