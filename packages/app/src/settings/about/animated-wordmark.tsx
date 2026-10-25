import { createEffect, For, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

const target = ["m", "e", "m", "y", "r"] as const

const choices = ["m", "e", "y", "r"] as const

const paths: Record<(typeof choices)[number], string> = {
  m: "M0 6H4L12 20L20 6H24V36H20V19L12 31L4 19V36H0Z",
  e: "M0 6H24V11H4V20H20V25H4V31H24V36H0Z",
  y: "M0 6H5L12 19L19 6H24L14 26V36H10V26Z",
  r: "M0 6H20V25H12L24 36H18L8 25H4V36H0V6ZM4 11V20H16V11H4Z",
}

export function AnimatedWordmark(props: { active: boolean }) {
  const [state, setState] = createStore({ letters: [...target] })
  const timers = new Set<ReturnType<typeof setTimeout>>()

  createEffect(
    on(
      () => props.active,
      (active) => {
        timers.forEach(clearTimeout)
        timers.clear()

        if (!active || matchMedia("(prefers-reduced-motion: reduce)").matches) {
          setState("letters", [...target])

          return
        }

        const starts = target.map(() => choices[Math.floor(Math.random() * choices.length)])
        const settles = target.map(() => 6 + Math.floor(Math.random() * 8))
        const last = Math.max(...settles)
        setState("letters", starts)

        Array.from({ length: last }, (_, index) => index + 1).forEach((tick) => {
          const timer = setTimeout(() => {
            setState(
              "letters",
              target.map((letter, index) =>
                tick >= settles[index] ? letter : choices[Math.floor(Math.random() * choices.length)],
              ),
            )
            timers.delete(timer)
          }, tick * 75)

          timers.add(timer)
        })
      },
    ),
  )

  onCleanup(() => timers.forEach(clearTimeout))

  return (
    <svg class="settings-about-wordmark" viewBox="0 0 144 42" aria-hidden="true">
      <defs>
        {choices.map((letter) => (
          <symbol id={`settings-about-letter-${letter}`} viewBox="0 0 24 42">
            <path d={paths[letter]} fill-rule={letter === "r" ? "evenodd" : undefined} />
          </symbol>
        ))}
      </defs>
      <For each={state.letters}>
        {(letter, index) => (
          <use href={`#settings-about-letter-${letter}`} x={index() * 30} width="24" height="42" />
        )}
      </For>
    </svg>
  )
}
