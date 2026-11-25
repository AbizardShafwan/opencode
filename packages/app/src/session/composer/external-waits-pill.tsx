import type { JobExternal } from "@opencode/client/promise"
import { Popover } from "@kobalte/core/popover"
import { Icon } from "@opencode/ui/icon"
import { createEffect, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"

const capsule =
  "pointer-events-auto flex h-7 min-w-0 max-w-full items-center gap-2 rounded-[12px] border-[0.5px] border-v2-border-border-muted bg-v2-background-bg-base ps-2.5 pe-2.5 text-[13px] font-[440] leading-text-compact tracking-[-0.04px] whitespace-nowrap text-v2-text-text-base shadow-[var(--v2-elevation-raised)] outline-none"

function formatDuration(remaining: number) {
  if (remaining < 60_000) return `${Math.ceil(remaining / 1_000)}s`

  if (remaining < 3_600_000) return `${Math.floor(remaining / 60_000)}m`

  if (remaining < 86_400_000) {
    return `${Math.floor(remaining / 3_600_000)}h ${Math.floor((remaining % 3_600_000) / 60_000)}m`
  }

  return `${Math.floor(remaining / 86_400_000)}d ${Math.floor((remaining % 86_400_000) / 3_600_000)}h`
}

export function SessionExternalWaitsPill(props: { waits: readonly JobExternal[]; sessionID?: string }) {
  const language = useLanguage()
  const [state, setState] = createStore({ open: false })

  const label = () => language.plural("session.externalWait.count", props.waits.length)

  const expiry = (expiresAt: number) => {
    const remaining = expiresAt - Date.now()

    if (remaining <= 0) return language.t("session.externalWait.expired")

    return language.t("session.externalWait.expiresIn", { duration: formatDuration(remaining) })
  }

  createEffect(
    on(
      () => [props.sessionID, props.waits.length] as const,
      ([, count]) => {
        if (count === 0) setState("open", false)
      },
    ),
  )

  createEffect(
    on(
      () => props.sessionID,
      () => setState("open", false),
      { defer: true },
    ),
  )

  return (
    <Show when={props.waits.length > 0}>
      <Popover open={state.open} onOpenChange={(open) => setState("open", open)} placement="top-end" gutter={8}>
        <Popover.Trigger as="button" type="button" data-slot="session-external-wait-pill" aria-label={label()} class={capsule}>
          <Icon name="outline-rotate-clockwise" size="small" class="shrink-0 text-v2-icon-icon-muted" />
          <span dir="auto" class="min-w-0 max-w-[260px] truncate">
            {label()}
          </span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            data-slot="session-external-wait-popover"
            aria-label={language.t("session.externalWait.title")}
            class="w-80 max-w-[calc(100vw-56px)] rounded-[10px] border-[0.5px] border-v2-border-border-muted bg-v2-background-bg-layer-01 p-1 shadow-[var(--v2-elevation-floating)] outline-none"
          >
            <div class="px-2 pt-1 pb-1.5 text-[11px] font-[530] tracking-[0.05px] leading-text-compact text-v2-text-text-faint">
              {language.t("session.externalWait.title")}
            </div>
            <div class="flex max-h-72 flex-col gap-1 overflow-y-auto px-1 pb-1">
              <For each={props.waits}>
                {(wait) => (
                  <div data-slot="session-external-wait-item" class="flex flex-col gap-0.5 rounded-[6px] px-1.5 py-1.5">
                    <div dir="auto" class="text-[13px] font-[440] leading-text-compact text-v2-text-text-base break-words">
                      {wait.description}
                    </div>
                    <div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-text-compact text-v2-text-text-muted">
                      <span dir="auto">{wait.source}</span>
                      <span aria-hidden="true">·</span>
                      <span dir="auto">{wait.server}</span>
                      <span aria-hidden="true">·</span>
                      <span>{expiry(wait.expiresAt)}</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    </Show>
  )
}
