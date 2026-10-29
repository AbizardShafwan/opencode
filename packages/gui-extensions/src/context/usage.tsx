import { For, Show } from "solid-js"
import type { UsageBalance, UsageInfo } from "@opencode/client/promise"
import { createLatest, useExtension, type MountedSession } from "../sdk"

/**
 * The selected model's provider usage inside the context panel: DeepSeek balance, Codex,
 * Claude Code, or Ollama Cloud windows, or Antigravity quota pools. The server picks the
 * source from the provider's active credential, so a provider with nothing to read renders
 * nothing here.
 */
export function SessionProviderUsage(props: { session: MountedSession; providerID: string | undefined }) {
  const ctx = useExtension()

  const usage = createLatest(
    () => props.providerID,
    async (providerID, signal) => {
      const response = await props.session.server.client.usage.read(
        { providerID, location: { directory: props.session.directory } },
        { signal },
      )

      return response.data ?? undefined
    },
  )

  // A value read for the previous provider must not describe the newly selected model.
  const current = () => (usage.latest && usage.latest.providerID === props.providerID ? usage.latest : undefined)

  const reset = (at: number | undefined) => {
    if (at === undefined) return undefined

    const remaining = at - Date.now()

    if (remaining <= 0) return ctx.t("usage.reset.imminent")

    return ctx.t("usage.reset", { duration: duration(remaining) })
  }

  const percent = (value: number) => `${Math.round(value)}%`

  const balanceDetail = (balance: UsageBalance) => {
    const parts = [
      balance.granted === undefined ? undefined : ctx.t("usage.balance.granted", { amount: balance.granted }),
      balance.toppedUp === undefined ? undefined : ctx.t("usage.balance.toppedUp", { amount: balance.toppedUp }),
    ].filter((item) => item !== undefined)

    return parts.length > 0 ? parts.join(" · ") : undefined
  }

  const title = (source: UsageInfo["source"]) => {
    switch (source) {
      case "deepseek-balance":
        return ctx.t("usage.deepseek.title")
      case "antigravity-quota":
        return ctx.t("usage.antigravity.title")
      case "codex-rate-limit":
        return ctx.t("usage.codex.title")
      case "claude-code-usage":
        return ctx.t("usage.claude.title")
      case "ollama-balance":
        return ctx.t("usage.ollama.title")
    }
  }

  return (
    <Show when={current()}>
      {(value) => (
        <div class="flex flex-col gap-3" data-slot="session-usage-provider">
          <div class="text-12-regular text-text-weak">{title(value().source)}</div>
          <div class="grid grid-cols-1 @[32rem]:grid-cols-2 gap-4">
            <For each={value().balances ?? []}>
              {(balance) => <UsageRow label={balance.currency} value={balance.total} detail={balanceDetail(balance)} />}
            </For>
            <For each={value().windows ?? []}>
              {(window) => (
                <QuotaRow
                  label={window.label}
                  remaining={window.remainingPercent}
                  value={ctx.t("usage.remaining", { percent: percent(window.remainingPercent) })}
                  detail={reset(window.resetsAt)}
                />
              )}
            </For>
            <For each={value().groups ?? []}>
              {(group) => (
                <div class="flex flex-col gap-3">
                  <div class="flex flex-col">
                    <div class="text-12-medium text-text-base">{group.label}</div>
                    <Show when={group.description}>
                      {(description) => <div class="text-12-regular text-text-weak">{description()}</div>}
                    </Show>
                  </div>
                  <For each={group.windows}>
                    {(window) => (
                      <QuotaRow
                        label={window.label}
                        remaining={window.remainingPercent}
                        value={ctx.t("usage.remaining", { percent: percent(window.remainingPercent) })}
                        detail={reset(window.resetsAt)}
                      />
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </div>
      )}
    </Show>
  )
}

/** Reset countdowns span days, so the largest two units stay readable at a glance. */
function duration(remaining: number) {
  if (remaining < 60_000) return `${Math.ceil(remaining / 1_000)}s`

  if (remaining < 3_600_000) return `${Math.floor(remaining / 60_000)}m`

  if (remaining < 86_400_000)
    return `${Math.floor(remaining / 3_600_000)}h ${Math.floor((remaining % 3_600_000) / 60_000)}m`

  return `${Math.floor(remaining / 86_400_000)}d ${Math.floor((remaining % 86_400_000) / 3_600_000)}h`
}

/**
 * A rate-limit window: a bar that empties when the window is spent, the percentage beside it, and
 * when it resets. The bar repeats the number rather than replacing it, so the exact share stays
 * readable and a screen reader announces a percentage, not a shape.
 */
function QuotaRow(props: { label: string; value: string; remaining: number; detail?: string }) {
  return (
    <div class="flex flex-col gap-1">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="flex items-center gap-2">
        <div
          data-slot="session-usage-bar"
          role="progressbar"
          aria-label={props.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(props.remaining)}
          class="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-v2-background-bg-layer-04"
        >
          <div class="h-full rounded-full bg-v2-icon-icon-base" style={{ width: `${props.remaining}%` }} />
        </div>
        <div class="shrink-0 text-12-medium text-text-strong">{props.value}</div>
      </div>
      <Show when={props.detail}>
        {(detail) => <div class="text-12-regular text-text-weak">{detail()}</div>}
      </Show>
    </div>
  )
}

function UsageRow(props: { label: string; value: string; detail?: string }) {
  return (
    <div class="flex flex-col gap-1">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="text-12-medium text-text-strong">{props.value}</div>
      <Show when={props.detail}>
        {(detail) => <div class="text-12-regular text-text-weak">{detail()}</div>}
      </Show>
    </div>
  )
}
