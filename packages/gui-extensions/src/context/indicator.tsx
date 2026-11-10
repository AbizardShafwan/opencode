import { Show, createMemo, type ComponentProps, type JSX } from "solid-js"
import { ProgressCircle } from "@opencode/ui/progress-circle"
import { Button } from "@opencode/ui/button"
import { Tooltip } from "@opencode/ui/tooltip"
import { useI18n } from "@opencode/ui/context/i18n"
import { compactionSettings, lastAssistantWithUsage } from "@opencode/client/solid"
import { effectiveContextWindow, resolveSoftLimit } from "@opencode/util/token-limit"
import { useExtension, type MountedSession } from "../sdk"
import { catalogModel, syncCatalog } from "./catalog"

function ContextTooltipRow(props: { name: JSX.Element; value: JSX.Element }) {
  return (
    <div class="flex min-w-0 items-center gap-4">
      <span class="shrink-0 text-v2-text-text-muted">{props.name}</span>
      <span class="ml-auto min-w-0 truncate text-right text-v2-text-text-base">{props.value}</span>
    </div>
  )
}

export function SessionContextUsage(props: {
  session: MountedSession
  variant?: "button" | "composer" | "indicator" | "badge"
  placement?: ComponentProps<typeof Tooltip>["placement"]
}) {
  const ctx = useExtension()
  const layout = ctx.layout
  const i18n = useI18n()
  syncCatalog(() => props.session)

  const variant = createMemo(() => props.variant ?? "button")

  const messages = createMemo(() =>
    props.session.id ? props.session.server.data.session.message.list(props.session.id) : [],
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(i18n.locale(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const info = createMemo(() =>
    props.session.id ? props.session.server.data.session.get(props.session.id) : undefined,
  )

  // Same step as the TUI: after the last completed compaction and before an undo boundary.
  const context = createMemo(() => {
    const message = lastAssistantWithUsage(messages(), info()?.revert?.messageID)

    if (!message) return
    const model = catalogModel(props.session, message.model)?.model

    const total =
      message.tokens.input +
      message.tokens.output +
      message.tokens.reasoning +
      message.tokens.cache.read +
      message.tokens.cache.write

    const settings = compactionSettings(
      props.session.server.data.location.config.list(props.session.location),
      `${message.model.providerID}/${message.model.id}`,
    )

    const softLimit = resolveSoftLimit(info()?.metadata?.softLimit, settings.modelLimit, settings.defaultLimit)

    const hardLimit = model ? model.limit.input || model.limit.context : undefined

    const effectiveLimit = effectiveContextWindow(hardLimit ?? 0, softLimit)

    return {
      total,
      usage: effectiveLimit ? Math.round((total / effectiveLimit) * 100) : null,
      limit: effectiveLimit,
      hardLimit,
      softLimit,
    }
  })

  const tokens = createMemo(() =>
    new Intl.NumberFormat(i18n.locale(), { notation: "compact", maximumFractionDigits: 0 })
      .format(context()?.total ?? 0)
      .toLocaleLowerCase(i18n.locale()),
  )

  const limit = createMemo(() => {
    const value = context()?.limit

    if (!value) return

    return new Intl.NumberFormat(i18n.locale(), { notation: "compact", maximumFractionDigits: 0 })
      .format(value)
      .toLocaleLowerCase(i18n.locale())
  })

  // A root session's cost includes its subagent sessions, as in the TUI.
  const spent = createMemo(() => (props.session.id ? props.session.server.data.session.cost(props.session.id) : 0))

  const cost = createMemo(() => usd().format(spent()))

  // Spend anywhere in the family keeps the cost visible, even when this session's model is free.
  const showCost = createMemo(() => {
    if (spent() > 0) return true
    const ref = info()?.model ?? messages().findLast((item) => item.type === "assistant")?.model
    const model = ref ? catalogModel(props.session, ref)?.model : undefined

    if (!model) return true

    return model.cost.some((cost) => cost.input > 0 || cost.output > 0 || cost.cache.read > 0 || cost.cache.write > 0)
  })

  const openContext = () => {
    if (!props.session.id) return
    layout.toggle(`${ctx.id}:main`, props.session)
  }

  const ringProgressColor = createMemo(() => {
    const usage = context()?.usage ?? 0

    if (usage >= 90) return "var(--icon-critical-base, var(--v2-icon-icon-base))"

    if (usage >= 75) return "var(--icon-warning-base, var(--v2-icon-icon-base))"

    return "var(--v2-icon-icon-base, var(--icon-base))"
  })

  const circle = () => (
    <div class="flex items-center justify-center">
      <ProgressCircle
        appearance="indicator"
        size={15}
        strokeWidth={2}
        percentage={context()?.usage ?? 0}
        style={{
          "--progress-circle-background": "var(--v2-background-bg-layer-04, var(--border-weak-base))",
          "--progress-circle-background-overlay": "var(--v2-overlay-simple-overlay-pressed, transparent)",
          "--progress-circle-progress": ringProgressColor(),
        }}
      />
    </div>
  )

  const compactCircle = () => (
    <div class="flex items-center justify-center">
      <ProgressCircle
        appearance="indicator"
        size={14}
        strokeWidth={2}
        percentage={context()?.usage ?? 0}
        style={{
          "--progress-circle-background": "var(--border-base, var(--v2-background-bg-layer-04))",
          "--progress-circle-background-overlay": "transparent",
          "--progress-circle-progress": ringProgressColor(),
        }}
      />
    </div>
  )

  const tooltipValue = () => (
    <div class="flex w-[120px] flex-col gap-2">
      <Show when={showCost()}>
        <ContextTooltipRow name={ctx.t("usage.cost")} value={cost()} />
      </Show>
      <ContextTooltipRow name={ctx.t("usage.usage")} value={`${context()?.usage ?? 0}%`} />
      <ContextTooltipRow name={ctx.t("usage.tokens")} value={context()?.total.toLocaleString(i18n.locale()) ?? "0"} />
    </div>
  )

  const expanded = () => layout.state(`${ctx.id}:main`, props.session) === "visible"

  return (
    <Show when={props.session.id}>
      <Tooltip
        value={variant() === "indicator" || variant() === "badge" ? tooltipValue() : ctx.t("usage.toggle")}
        placement={props.placement ?? "top"}
      >
        <Show
          when={variant() === "indicator"}
          fallback={
            <Show
              when={variant() === "badge"}
              fallback={
                <Button
                  type="button"
                  variant="ghost-muted"
                  data-slot="session-context-trigger"
                  data-variant={variant()}
                  class={`group shrink-0 h-7 rounded-full border px-2.5 transition-colors ${
                    expanded()
                      ? "bg-surface-raised-base border-border-strong-base text-text-strong shadow-xs"
                      : "bg-surface-base hover:bg-surface-raised-base border-border-base text-text-weak hover:text-text-base shadow-xs"
                  }`}
                  onClick={openContext}
                  aria-expanded={expanded()}
                  aria-label={ctx.t("usage.toggle")}
                >
                  <span class="flex items-center gap-1.5 whitespace-nowrap font-mono text-11-medium tabular-nums">
                    {compactCircle()}
                    <span class="text-text-strong font-medium">{tokens()}</span>
                    <Show
                      when={variant() === "composer"}
                      fallback={
                        <Show when={showCost()}>
                          <span aria-hidden="true" class="flex w-1 shrink-0 items-center justify-center text-text-weak">
                            ·
                          </span>
                          <span class="text-text-weak group-hover:text-text-base transition-colors">{cost()}</span>
                        </Show>
                      }
                    >
                      <Show when={limit()}>
                        {(value) => (
                          <>
                            <span
                              aria-hidden="true"
                              class="flex w-1 shrink-0 items-center justify-center text-text-weak"
                            >
                              /
                            </span>
                            <span class="text-text-weak group-hover:text-text-base transition-colors">{value()}</span>
                          </>
                        )}
                      </Show>
                    </Show>
                  </span>
                </Button>
              }
            >
              <div
                data-slot="session-context-trigger"
                data-variant="badge"
                class="inline-flex shrink-0 h-7 items-center rounded-full border border-border-base bg-background-base px-2.5 shadow-xs"
              >
                <span class="flex items-center gap-1.5 whitespace-nowrap font-mono text-11-medium tabular-nums">
                  {compactCircle()}
                  <span class="text-text-strong font-medium">{tokens()}</span>
                  <Show when={limit()}>
                    {(value) => (
                      <>
                        <span aria-hidden="true" class="flex w-1 shrink-0 items-center justify-center text-text-weak">
                          /
                        </span>
                        <span class="text-text-weak">{value()}</span>
                      </>
                    )}
                  </Show>
                </span>
              </div>
            </Show>
          }
        >
          {circle()}
        </Show>
      </Tooltip>
    </Show>
  )
}
