import { Tooltip } from "@opencode/ui/tooltip"
import { useI18n } from "@opencode/ui/context/i18n"
import type { ComposerSelectControl } from "./interaction"

export function compactAgentControl(control: ComposerSelectControl) {
  const options = control.options()

  return (
    options.length === 2 &&
    options.some((option) => option.id === "plan") &&
    options.some((option) => option.id === "build")
  )
}

export function NorseAgentControl(props: { control: ComposerSelectControl; title: string }) {
  const i18n = useI18n()
  // The reference puts Plan before Build, regardless of the server's list order.
  const options = () =>
    props.control.options().toSorted((a, b) => (a.id === "plan" ? -1 : b.id === "plan" ? 1 : 0))
  const current = () => props.control.current()

  return (
    <div data-component="norse-agent-control" role="group" aria-label={props.title}>
      {options().map((option) => (
        <Tooltip
          value={i18n.t(option.id === "plan" ? "norse.agent.plan" : "norse.agent.build")}
          placement="bottom"
          gutter={8}
        >
          <button
            type="button"
            data-agent={option.id}
            aria-pressed={current() === option.id}
            onClick={() => props.control.onSelect(option.id)}
          >
            <span aria-hidden="true">{option.id === "plan" ? "ᛈ" : "ᛏ"}</span>
            {option.label}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}
