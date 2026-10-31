import { useTheme } from "@opencode/ui/theme/context"
import { Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { isNorseTheme } from "@/theme/norse"
import { useTabs } from "@/shell/tabs/tabs"

const greetings = [
  { title: "norse.welcome", subtitle: "norse.subtitle" },
  { title: "norse.welcome.bifrost", subtitle: "norse.subtitle.bifrost" },
  { title: "norse.welcome.ravens", subtitle: "norse.subtitle.ravens" },
  { title: "norse.welcome.yggdrasil", subtitle: "norse.subtitle.yggdrasil" },
  { title: "norse.welcome.runes", subtitle: "norse.subtitle.runes" },
] as const

// Assign each draft once; tab memory keeps its greeting when the route remounts.
let nextGreeting = 0

export function NorseWelcome(props: { draftID: string }) {
  const theme = useTheme()
  const language = useLanguage()
  const tabs = useTabs()
  const greeting = tabs.state(tabs.draft(props.draftID), "norse-welcome", () => {
    const selected = greetings[nextGreeting % greetings.length]
    nextGreeting++
    return selected
  })

  return (
    <Show when={isNorseTheme(theme.themeId())}>
      <div data-component="norse-welcome">
        <h1 data-slot="norse-welcome-greeting">{language.t(greeting.title)}</h1>
        <p data-slot="norse-welcome-subtitle">{language.t(greeting.subtitle)}</p>
      </div>
    </Show>
  )
}
