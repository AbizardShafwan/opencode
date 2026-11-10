import { createMemo, on, onCleanup, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { JSX } from "solid-js"
import { checksum } from "@opencode/util/encode"
import { Icon } from "@opencode/ui/icon"
import { Button } from "@opencode/ui/button"
import { Checkbox } from "@opencode/ui/checkbox"
import { Accordion } from "@opencode/ui/accordion"
import { StickyAccordionHeader } from "@opencode/ui/sticky-accordion-header"
import { ScrollView } from "@opencode/ui/scroll-view"
import { showToast } from "@opencode/ui/toast"
import { useI18n } from "@opencode/ui/context/i18n"
import { File } from "@opencode/session-ui/file"
import { Markdown } from "@opencode/session-ui/markdown"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { compactionSettings, lastAssistantWithUsage } from "@opencode/client/solid"
import {
  calculateCompactionCeiling,
  effectiveContextWindow,
  parseTokenLimit,
  formatTokenLimit,
  resolveSoftLimit,
} from "@opencode/util/token-limit"
import { createKeyed, useExtension, type MountedSession } from "../sdk"
import { catalogModel, syncCatalog } from "./catalog"
import { fetchSessionExport, sessionExportFilename } from "./export"
import { createSessionContextFormatter } from "./format"
import { SessionProviderUsage } from "./usage"

function RawMessageContent(props: { message: SessionMessageInfo; onRendered: () => void }) {
  const file = createMemo(() => {
    const contents = JSON.stringify(props.message, null, 2)

    return {
      name: `${props.message.type}-${props.message.id}.json`,
      contents,
      cacheKey: checksum(contents),
    }
  })

  return (
    <File
      mode="text"
      file={file()}
      overflow="wrap"
      class="select-text"
      onRendered={() => requestAnimationFrame(props.onRendered)}
    />
  )
}

function RawMessage(props: {
  message: SessionMessageInfo
  onRendered: () => void
  time: (value: number | undefined) => string
}) {
  return (
    <Accordion.Item value={props.message.id}>
      <StickyAccordionHeader>
        <Accordion.Trigger>
          <div class="flex items-center justify-between gap-2 w-full">
            <div class="min-w-0 truncate">
              {props.message.type} <span class="text-text-base">• {props.message.id}</span>
            </div>
            <div class="flex items-center gap-3">
              <div class="shrink-0 text-12-regular text-text-weak">{props.time(props.message.time.created)}</div>
              <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
            </div>
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content class="bg-background-base">
        <div class="p-3">
          <RawMessageContent message={props.message} onRendered={props.onRendered} />
        </div>
      </Accordion.Content>
    </Accordion.Item>
  )
}

const emptyMessages: SessionMessageInfo[] = []

export default function SessionContextTab(props: { session: MountedSession }) {
  const ctx = useExtension()
  const layout = ctx.layout
  const system = ctx.system
  const i18n = useI18n()
  const data = () => props.session.server.data
  syncCatalog(() => props.session)

  const info = createMemo(() => (props.session.id ? data().session.get(props.session.id) : undefined))

  const messages = createMemo(
    () => {
      const id = props.session.id

      if (!id) return emptyMessages

      return data().session.message.list(id)
    },
    emptyMessages,
    { equals: same },
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(i18n.locale(), {
        style: "currency",
        currency: "USD",
      }),
  )

  // Same step as the TUI and the header button: after the last completed compaction and before an undo boundary.
  const context = createMemo(() => {
    const message = lastAssistantWithUsage(messages(), info()?.revert?.messageID)

    if (!message) return
    const entry = catalogModel(props.session, message.model)

    const total =
      message.tokens.input +
      message.tokens.output +
      message.tokens.reasoning +
      message.tokens.cache.read +
      message.tokens.cache.write

    const settings = compactionSettings(
      data().location.config.list(props.session.location),
      `${message.model.providerID}/${message.model.id}`,
    )

    const softLimit = resolveSoftLimit(info()?.metadata?.softLimit, settings.modelLimit, settings.defaultLimit)

    const hardLimit = entry?.model ? entry.model.limit.input || entry.model.limit.context : undefined

    const effectiveLimit = effectiveContextWindow(hardLimit ?? 0, softLimit)

    return {
      message,
      tokens: message.tokens,
      providerLabel: entry?.provider.name ?? message.model.providerID,
      modelLabel: entry?.model?.name ?? message.model.id,
      limit: effectiveLimit,
      hardLimit,
      softLimit,
      input: message.tokens.input,
      total,
      usage: effectiveLimit ? Math.round((total / effectiveLimit) * 100) : null,
    }
  })

  const usageProviderID = createMemo(() => (info()?.model ?? context()?.message.model)?.providerID)

  const modelRef = createMemo(() => info()?.model ?? context()?.message.model)

  const modelEntry = createMemo(() => {
    const ref = modelRef()

    if (!ref) return undefined

    return catalogModel(props.session, ref)
  })

  const activeModel = createMemo(() => modelEntry()?.model)

  const hardLimit = createMemo(() => {
    const m = activeModel()

    return m ? m.limit.input || m.limit.context : 0
  })

  const modelKey = createMemo(() => {
    const m = activeModel()

    if (m) return `${m.providerID}/${m.id}`

    const r = modelRef()

    return r ? `${r.providerID}/${r.id}` : undefined
  })

  const settings = createMemo(() => compactionSettings(data().location.config.list(props.session.location), modelKey()))

  const currentSoftLimit = createMemo(() =>
    resolveSoftLimit(info()?.metadata?.softLimit, settings().modelLimit, settings().defaultLimit),
  )

  const effectiveLimit = createMemo(() => effectiveContextWindow(hardLimit(), currentSoftLimit()))

  // Edits and delayed writes belong to one visit, location, model, and server connection, not the live route.
  const limitTarget = createMemo(() => ({
    id: Symbol(),
    visit: props.session.visit,
    sessionID: props.session.id,
    directory: props.session.directory,
    server: props.session.server,
    client: props.session.server.client,
    modelKey: modelKey(),
  }))

  const [edit, setEdit] = createStore<{ target?: symbol; text: string | null; save: boolean | null }>({
    text: null,
    save: null,
  })

  const textOverride = () => (edit.target === limitTarget().id ? edit.text : null)
  const saveDefault = () => (edit.target === limitTarget().id ? edit.save : null) ?? settings().modelLimit !== undefined
  const setTextOverride = (text: string | null) => setEdit({ target: limitTarget().id, text, save: saveDefault() })
  const setSaveDefaultOverride = (save: boolean) => setEdit({ target: limitTarget().id, text: textOverride(), save })

  const candidatePresets = [1_500_000, 1_000_000, 750_000, 500_000, 372_000, 250_000, 128_000, 100_000, 80_000, 64_000]

  const presetTokens = createMemo(() => {
    const hard = hardLimit()

    if (hard <= 0) return []

    return candidatePresets.filter((p) => p < hard && (hard >= 1_000_000 ? p >= 128_000 : p >= 40_000))
  })

  const ceilingTokens = createMemo(() => {
    const eff = effectiveLimit()

    if (eff <= 0) return 0

    return calculateCompactionCeiling(hardLimit(), settings().buffer, currentSoftLimit())
  })

  const clampingNotice = createMemo(() => {
    const def = currentSoftLimit()
    const hard = hardLimit()

    if (def && hard > 0 && def > hard) {
      return ctx.t("contextLimit.clampingNotice", {
        hardLimit: formatTokenLimit(hard),
        defaultLimit: formatTokenLimit(def),
      })
    }

    return undefined
  })

  const displayInputText = createMemo(() => {
    const override = textOverride()

    if (override !== null) return override

    const current = currentSoftLimit()

    return current ? formatTokenLimit(current) : hardLimit() > 0 ? formatTokenLimit(hardLimit()) : ""
  })

  const sliderValue = createMemo(() => {
    const hard = hardLimit()

    if (hard <= 0) return 40000

    const override = textOverride()

    if (override !== null) {
      const parsed = parseTokenLimit(override, hard)

      if (!parsed.error && parsed.tokens) return Math.min(parsed.tokens, hard)

      if (parsed.clear) return hard
    }

    const current = currentSoftLimit()

    return Math.min(current ?? hard, hard)
  })

  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const controller = new AbortController()

  const signal = AbortSignal.any([ctx.signal, controller.signal])

  onCleanup(() => {
    controller.abort()

    if (debounceTimer) clearTimeout(debounceTimer)
  })

  const isCurrent = (target: ReturnType<typeof limitTarget>) => !signal.aborted && target === limitTarget()

  const commitLimit = async (tokens: number | undefined) => {
    const target = limitTarget()
    const save = saveDefault()
    const sessionID = target.sessionID

    const meta = { ...(info()?.metadata ?? {}) }

    if (tokens === undefined) {
      delete meta.softLimit
    } else {
      meta.softLimit = tokens
    }

    try {
      if (sessionID) {
        await target.server.client.session.update(
          {
            sessionID,
            metadata: meta,
          },
          { signal },
        )
      }

      if (!isCurrent(target)) return

      if (save && target.modelKey) {
        await target.server.client.config.update(
          {
            softLimit: {
              modelKey: target.modelKey,
              limit: tokens ?? null,
            },
          },
          { signal },
        )

        if (!isCurrent(target)) return

        showToast({
          variant: "success",
          icon: () => <Icon name="circle-check" />,
          title: ctx.t("contextLimit.title"),
          description: ctx.t("contextLimit.savedToast"),
        })
      }
    } catch (err) {
      if (!isCurrent(target)) return

      showToast({
        variant: "error",
        title: ctx.t("contextLimit.title"),
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const debounceCommit = (val: number) => {
    if (debounceTimer) clearTimeout(debounceTimer)
    const target = limitTarget()

    debounceTimer = setTimeout(() => {
      if (!isCurrent(target)) return

      setTextOverride(null)

      void commitLimit(val)
    }, 250)
  }

  const handleSliderInput = (event: Event & { currentTarget: HTMLInputElement }) => {
    const val = Number(event.currentTarget.value)

    setTextOverride(formatTokenLimit(val))
    debounceCommit(val)
  }

  const handleSliderChange = (event: Event & { currentTarget: HTMLInputElement }) => {
    if (debounceTimer) clearTimeout(debounceTimer)

    const val = Number(event.currentTarget.value)

    setTextOverride(null)

    void commitLimit(val)
  }

  const handleTextInput = (event: Event & { currentTarget: HTMLInputElement }) => {
    setTextOverride(event.currentTarget.value)
  }

  const handleTextSubmit = (raw: string) => {
    if (debounceTimer) clearTimeout(debounceTimer)

    setTextOverride(null)

    const parsed = parseTokenLimit(raw, hardLimit() || undefined)

    if (parsed.error) {
      showToast({
        variant: "error",
        title: ctx.t("contextLimit.title"),
        description: parsed.error,
      })

      return
    }

    if (parsed.clear) {
      void commitLimit(undefined)

      return
    }

    void commitLimit(parsed.tokens)
  }

  const handleTextKeyDown = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (event.key === "Enter") {
      handleTextSubmit(event.currentTarget.value)
    }
  }

  const handleTextBlur = (event: FocusEvent & { currentTarget: HTMLInputElement }) => {
    if (textOverride() === null) return

    handleTextSubmit(event.currentTarget.value)
  }

  const handlePresetClick = (tokens: number | undefined) => {
    if (debounceTimer) clearTimeout(debounceTimer)

    setTextOverride(null)

    void commitLimit(tokens)
  }

  const handleToggleSaveDefault = async (checked: boolean) => {
    setSaveDefaultOverride(checked)

    const target = limitTarget()
    const key = target.modelKey

    if (!key) return

    try {
      const cur = currentSoftLimit()

      await target.server.client.config.update(
        {
          softLimit: {
            modelKey: key,
            limit: checked ? (cur ?? null) : null,
          },
        },
        { signal },
      )

      if (!isCurrent(target)) return

      showToast({
        variant: "success",
        icon: () => <Icon name="circle-check" />,
        title: ctx.t("contextLimit.title"),
        description: ctx.t("contextLimit.savedToast"),
      })
    } catch (err) {
      if (!isCurrent(target)) return

      showToast({
        variant: "error",
        title: ctx.t("contextLimit.title"),
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const formatter = createMemo(() => createSessionContextFormatter(i18n.locale()))

  // A root session's cost includes its subagent sessions, as in the TUI.
  const cost = createMemo(() => usd().format(props.session.id ? data().session.cost(props.session.id) : 0))

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, message) => count + (message.type === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, message) => count + (message.type === "assistant" ? 1 : 0), 0)

    return {
      all: all.length,
      user,
      assistant,
    }
  })

  const systemPrompt = createMemo(() => {
    const system = messages().findLast((message) => message.type === "system")?.text

    if (!system) return
    const trimmed = system.trim()

    if (!trimmed) return

    return trimmed
  })

  const providerLabel = createMemo(() => {
    const c = context()

    if (!c) return "—"

    return c.providerLabel
  })

  const modelLabel = createMemo(() => {
    const c = context()

    if (!c) return "—"

    return c.modelLabel
  })

  const tokenSegments = createMemo(() => {
    const c = context()
    const limit = c?.limit ?? 0

    if (!c || limit <= 0) return { cache: 0, input: 0, output: 0, reasoning: 0 }

    const pct = (value: number) => Math.min(100, Math.max(0, (value / limit) * 100))
    const cache = pct(c.tokens.cache.read + c.tokens.cache.write)
    const input = Math.min(100 - cache, pct(c.tokens.input))
    const output = Math.min(100 - cache - input, pct(c.tokens.output))
    const reasoning = Math.min(100 - cache - input - output, pct(c.tokens.reasoning))

    return { cache, input, output, reasoning }
  })

  const tokenBreakdown = [
    {
      label: "stats.inputTokens",
      dot: "bg-icon-base",
      value: () => formatter().number(context()?.input),
    },
    {
      label: "stats.outputTokens",
      dot: "bg-icon-success-base",
      value: () => formatter().number(context()?.tokens.output),
    },
    {
      label: "stats.reasoningTokens",
      dot: "bg-icon-warning-base",
      value: () => formatter().number(context()?.tokens.reasoning),
    },
    {
      label: "stats.cacheTokens",
      dot: "bg-icon-info-base",
      value: () =>
        `${formatter().number(context()?.tokens.cache.read)} / ${formatter().number(context()?.tokens.cache.write)}`,
    },
  ] satisfies { label: string; dot: string; value: () => JSX.Element }[]

  const exportSession = async () => {
    const sessionID = props.session.id

    if (!sessionID) return

    try {
      const data = await fetchSessionExport({
        sessionID,
        api: props.session.server.client,
      })

      const filename = sessionExportFilename(data.info)

      if (!(await system.save({ name: filename, content: JSON.stringify(data, null, 2) }))) return
      showToast({
        variant: "success",
        // Solid resolves JSX accessors under the toast's render owner, not this imperative call site.
        icon: () => <Icon name="circle-check" />,
        title: ctx.t("export.success.title"),
        description: ctx.t("export.success.description", { filename }),
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: ctx.t("export.failed.title"),
        description: err instanceof Error ? err.message : ctx.t("export.failed.description"),
      })
    }
  }

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined

  const restoreScroll = () => {
    const el = scroll

    if (!el) return

    const s = layout.scroll.get(props.session, "context")

    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y

    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }

    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined

      if (!next) return

      layout.scroll.set(props.session, "context", next)
    })
  }

  // Restores the stored scroll a frame after the messages change; on mount the viewport ref restores it.
  createKeyed(
    createMemo(on(messages, (list) => list, { defer: true })),
    () => void requestAnimationFrame(restoreScroll),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <ScrollView
      class="@container h-full"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div data-slot="session-usage-content" class="px-4 pt-4 pb-6 flex flex-col gap-6 md:px-6 md:pb-10 md:gap-10">
        <div data-slot="session-context-summary" class="flex flex-col gap-3">
          <div
            data-slot="session-context-identity"
            class="flex flex-col gap-3 p-4 rounded-xl border border-border-base bg-surface-base shadow-xs"
          >
            <div class="flex items-start justify-between gap-3 flex-wrap">
              <div class="flex flex-col gap-0.5 min-w-[8rem] flex-1">
                <span class="text-11-regular text-text-weak">{ctx.t("stats.session")}</span>
                <span class="text-14-medium text-text-strong font-medium truncate">
                  {info()?.title ?? (props.session.id || "—")}
                </span>
              </div>

              <div class="flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-background-base border border-border-base shadow-xs shrink-0 max-w-full">
                <span class="sr-only">{ctx.t("stats.provider")}:</span>
                <span class="text-11-medium text-text-weak truncate">{providerLabel()}</span>
                <span aria-hidden="true" class="text-11-regular text-text-weak">
                  ·
                </span>
                <span class="sr-only">{ctx.t("stats.model")}:</span>
                <span class="text-11-medium text-text-strong font-medium truncate">{modelLabel()}</span>
              </div>
            </div>

            <div class="grid grid-cols-1 @[24rem]:grid-cols-2 gap-2 pt-2.5 border-t border-border-base/50">
              <div class="flex items-baseline justify-between @[24rem]:justify-start gap-2 min-w-0">
                <span class="text-11-regular text-text-weak shrink-0">{ctx.t("stats.sessionCreated")}</span>
                <span class="text-11-medium text-text-base font-mono tabular-nums truncate">
                  {formatter().time(info()?.time.created)}
                </span>
              </div>

              <div class="flex items-baseline justify-between @[24rem]:justify-end gap-2 min-w-0">
                <span class="text-11-regular text-text-weak shrink-0">{ctx.t("stats.lastActivity")}</span>
                <span class="text-11-medium text-text-base font-mono tabular-nums truncate">
                  {formatter().time(context()?.message.time.created)}
                </span>
              </div>
            </div>
          </div>

          <div
            data-slot="session-context-occupancy"
            class="flex flex-col gap-3.5 p-4 rounded-xl border border-border-base bg-surface-base shadow-xs"
          >
            <div class="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
              <div class="flex flex-col gap-0.5 shrink-0">
                <span class="text-11-regular text-text-weak">{ctx.t("stats.usage")}</span>
                <span class="text-16-medium font-semibold text-text-strong font-mono tabular-nums">
                  {formatter().percent(context()?.usage)}
                </span>
              </div>

              <div class="flex flex-col @[22rem]:items-end gap-0.5 min-w-0">
                <div class="flex items-center @[22rem]:justify-end gap-1 text-11-regular text-text-weak flex-wrap">
                  <span>{ctx.t("stats.totalTokens")}</span>
                  <span aria-hidden="true">/</span>
                  <span>{ctx.t("stats.limit")}</span>
                </div>

                <div class="flex items-baseline @[22rem]:justify-end gap-1 font-mono tabular-nums text-12-medium">
                  <span class="text-text-strong font-semibold">{formatter().number(context()?.total)}</span>
                  <span aria-hidden="true" class="text-text-weak">
                    /
                  </span>
                  <span class="text-text-weak">{formatter().number(context()?.limit)}</span>
                </div>
              </div>
            </div>

            <div
              role="progressbar"
              aria-label={ctx.t("stats.usage")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={context()?.usage ?? 0}
              class="h-2.5 w-full rounded-full bg-surface-inset-base overflow-hidden flex gap-px p-0.5"
            >
              <Show when={tokenSegments().cache > 0}>
                <div
                  class="h-full bg-icon-info-base rounded-l-full first:rounded-l-full last:rounded-r-full transition-all duration-200"
                  style={{ width: `${tokenSegments().cache}%` }}
                />
              </Show>
              <Show when={tokenSegments().input > 0}>
                <div
                  class="h-full bg-icon-base first:rounded-l-full last:rounded-r-full transition-all duration-200"
                  style={{ width: `${tokenSegments().input}%` }}
                />
              </Show>
              <Show when={tokenSegments().output > 0}>
                <div
                  class="h-full bg-icon-success-base first:rounded-l-full last:rounded-r-full transition-all duration-200"
                  style={{ width: `${tokenSegments().output}%` }}
                />
              </Show>
              <Show when={tokenSegments().reasoning > 0}>
                <div
                  class="h-full bg-icon-warning-base first:rounded-l-full last:rounded-r-full transition-all duration-200"
                  style={{ width: `${tokenSegments().reasoning}%` }}
                />
              </Show>
            </div>

            <div class="grid grid-cols-1 @[24rem]:grid-cols-2 @[38rem]:grid-cols-4 gap-2 pt-0.5">
              <For each={tokenBreakdown}>
                {(item) => (
                  <div class="flex items-center justify-between @[24rem]:flex-col @[24rem]:items-stretch gap-2 @[24rem]:gap-1 p-2.5 rounded-lg bg-background-base border border-border-base min-w-0">
                    <div class="flex items-center @[24rem]:items-start gap-1.5 min-w-0">
                      <span class={`w-2 h-2 @[24rem]:mt-1 rounded-full shrink-0 ${item.dot}`} />
                      <span class="text-11-regular text-text-weak leading-4 min-w-0">{ctx.t(item.label)}</span>
                    </div>
                    <div class="text-12-medium font-mono text-text-strong tabular-nums shrink-0 @[24rem]:truncate">
                      {item.value()}
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>

          <div
            data-slot="session-context-totals"
            class="grid grid-cols-1 @[24rem]:grid-cols-2 gap-3"
          >
            <div class="flex flex-col justify-between gap-2 p-4 rounded-xl border border-border-base bg-surface-base shadow-xs">
              <span class="text-11-regular text-text-weak">{ctx.t("stats.totalCost")}</span>
              <span class="text-16-medium font-semibold text-text-strong font-mono tabular-nums">{cost()}</span>
            </div>

            <div class="flex flex-col justify-between gap-2 p-4 rounded-xl border border-border-base bg-surface-base shadow-xs">
              <div class="flex items-baseline justify-between gap-2">
                <span class="text-11-regular text-text-weak">{ctx.t("stats.messages")}</span>
                <span class="text-16-medium font-semibold text-text-strong font-mono tabular-nums">
                  {counts().all.toLocaleString(i18n.locale())}
                </span>
              </div>

              <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-2 border-t border-border-base/50 text-11-regular">
                <div class="flex items-baseline gap-1.5">
                  <span class="text-text-weak">{ctx.t("stats.userMessages")}</span>
                  <span class="font-mono text-11-medium text-text-strong tabular-nums">
                    {counts().user.toLocaleString(i18n.locale())}
                  </span>
                </div>

                <div class="flex items-baseline gap-1.5">
                  <span class="text-text-weak">{ctx.t("stats.assistantMessages")}</span>
                  <span class="font-mono text-11-medium text-text-strong tabular-nums">
                    {counts().assistant.toLocaleString(i18n.locale())}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <SessionProviderUsage session={props.session} providerID={usageProviderID()} />

        <Show when={hardLimit() > 0}>
          <div
            class="flex flex-col gap-3.5 p-4 rounded-xl border border-border-base bg-surface-base shadow-xs"
            data-slot="session-context-limit"
          >
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <div class="flex items-center gap-2 flex-wrap">
                <Icon name="outline-sliders" size="small" class="text-text-weak" />

                <span class="text-13-medium text-text-strong font-medium">{ctx.t("contextLimit.title")}</span>

                <span class="inline-flex items-center px-2 py-0.5 rounded-full text-11-medium bg-surface-inset-base text-text-weak border border-border-base">
                  {modelLabel()}
                </span>
              </div>

              <div class="flex items-center gap-1.5 px-2.5 py-1 bg-surface-inset-base border border-border-base rounded-md focus-within:border-border-strong-base transition-all">
                <input
                  type="text"
                  value={displayInputText()}
                  onInput={handleTextInput}
                  onKeyDown={handleTextKeyDown}
                  onBlur={handleTextBlur}
                  placeholder={ctx.t("contextLimit.inputPlaceholder")}
                  aria-label={ctx.t("contextLimit.title")}
                  class="w-16 font-mono text-12-medium text-text-strong bg-transparent text-right focus:outline-none"
                />

                <span class="text-11-regular text-text-weak select-none">tokens</span>
              </div>
            </div>

            <div class="flex flex-col gap-1.5 pt-1">
              <div class="relative w-full h-5 flex items-center">
                <div class="absolute inset-x-0 h-2 rounded-full bg-surface-inset-base overflow-hidden">
                  <div
                    class="h-full rounded-full bg-icon-base transition-all duration-150 pointer-events-none"
                    style={{ width: `${Math.min(100, Math.max(0, (sliderValue() / hardLimit()) * 100))}%` }}
                  />
                </div>

                <Show when={ceilingTokens() > 0 && ceilingTokens() < hardLimit()}>
                  <div
                    class="absolute w-1 h-3 bg-icon-warning-base z-10 pointer-events-none rounded-full"
                    style={{ left: `calc(${Math.min(99, (ceilingTokens() / hardLimit()) * 100)}% - 2px)` }}
                  />
                </Show>

                <div
                  class="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-surface-raised-base shadow-md border-2 border-icon-base pointer-events-none z-10"
                  style={{ left: `calc(${Math.min(98, Math.max(0, (sliderValue() / hardLimit()) * 100))}% - 8px)` }}
                />

                <input
                  type="range"
                  min={40000}
                  max={hardLimit()}
                  step={10000}
                  value={sliderValue()}
                  onInput={handleSliderInput}
                  onChange={handleSliderChange}
                  aria-label={ctx.t("contextLimit.slider")}
                  class="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-20"
                />
              </div>

              <div class="grid grid-cols-[auto_1fr_auto] gap-2 items-start text-10-medium text-text-weak px-0.5 font-mono">
                <span>40k</span>

                <Show when={ceilingTokens() > 0 && ceilingTokens() < hardLimit()}>
                  <span class="min-w-0 text-center text-text-base">
                    <span class="inline-block w-1.5 h-1.5 mr-1 rounded-full bg-icon-warning-base" />~
                    {formatTokenLimit(ceilingTokens())} {ctx.t("contextLimit.compactionThreshold")}
                  </span>
                </Show>

                <span class="col-start-3">{formatTokenLimit(hardLimit())}</span>
              </div>
            </div>

            <div class="flex flex-wrap gap-1.5 items-center">
              <For each={presetTokens()}>
                {(preset) => {
                  const active = () => currentSoftLimit() === preset

                  return (
                    <button
                      type="button"
                      class={`px-2.5 py-1 text-11-medium rounded-full border transition-all ${
                        active()
                          ? "bg-surface-raised-base border-border-strong-base text-text-strong font-semibold shadow-xs"
                          : "bg-background-base hover:bg-surface-raised-base border-border-base text-text-weak hover:text-text-base cursor-pointer"
                      }`}
                      onClick={() => handlePresetClick(preset)}
                    >
                      {formatTokenLimit(preset)}
                    </button>
                  )
                }}
              </For>

              <button
                type="button"
                class={`px-2.5 py-1 text-11-medium rounded-full border transition-all ${
                  effectiveLimit() === hardLimit()
                    ? "bg-surface-raised-base border-border-strong-base text-text-strong font-semibold shadow-xs"
                    : "bg-background-base hover:bg-surface-raised-base border-border-base text-text-weak hover:text-text-base cursor-pointer"
                }`}
                onClick={() => handlePresetClick(hardLimit())}
              >
                {ctx.t("contextLimit.presetMax")}
              </button>
              <button
                type="button"
                class="px-2.5 py-1 text-11-medium rounded-full border border-border-base text-text-weak hover:text-text-base"
                onClick={() => handlePresetClick(undefined)}
              >
                {ctx.t("contextLimit.presetDefault")}
              </button>
            </div>

            <div class="grid grid-cols-1 @[24rem]:grid-cols-2 gap-2 pt-1">
              <div class="flex items-center gap-2.5 p-2.5 rounded-lg bg-background-base border border-border-base">
                <div class="w-2 h-2 rounded-full bg-icon-warning-base shrink-0" />

                <div class="flex flex-col min-w-0">
                  <span class="text-10-regular text-text-weak uppercase tracking-wider break-words">
                    {ctx.t("contextLimit.compactionThreshold")}
                  </span>

                  <span class="text-12-medium text-text-strong font-mono">~{formatTokenLimit(ceilingTokens())}</span>
                </div>
              </div>

              <div class="flex items-center gap-2.5 p-2.5 rounded-lg bg-background-base border border-border-base">
                <div class="w-2 h-2 rounded-full bg-icon-info-base shrink-0" />

                <div class="flex flex-col min-w-0">
                  <span class="text-10-regular text-text-weak uppercase tracking-wider break-words">
                    {ctx.t("contextLimit.physicalCapacity")}
                  </span>

                  <span class="text-12-medium text-text-strong font-mono">{formatTokenLimit(hardLimit())}</span>
                </div>
              </div>
            </div>

            <div class="flex flex-wrap gap-2 items-center justify-between pt-2 border-t border-border-base/40">
              <Checkbox checked={saveDefault()} onChange={handleToggleSaveDefault}>
                <span class="text-12-regular text-text-weak">
                  {ctx.t("contextLimit.saveDefault", { model: modelLabel() })}
                </span>
              </Checkbox>

              <Show when={saveDefault()}>
                <span class="flex shrink-0 items-center gap-1 text-11-medium text-text-base font-medium">
                  <Icon name="circle-check" size="small" />

                  {ctx.t("contextLimit.savedBadge")}
                </span>
              </Show>
            </div>

            <Show when={clampingNotice()}>
              {(notice) => (
                <div class="text-11-regular text-text-warning bg-surface-warning-subtle/20 border border-border-warning/30 rounded px-2.5 py-1.5">
                  {notice()}
                </div>
              )}
            </Show>
          </div>
        </Show>

        <Show when={systemPrompt()}>
          {(prompt) => (
            <div class="flex flex-col gap-2">
              <div class="text-12-regular text-text-weak">{ctx.t("systemPrompt.title")}</div>
              <div class="border border-border-base rounded-md bg-surface-base px-3 py-2">
                <Markdown text={prompt()} class="text-12-regular" />
              </div>
            </div>
          )}
        </Show>

        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <div class="text-12-regular text-text-weak">{ctx.t("rawMessages.title")}</div>
            <Button
              size="small"
              variant="ghost"
              class="gap-1.5 px-2 text-text-weak hover:text-text-base"
              onClick={exportSession}
            >
              <Icon name="download" size="small" />
              <span>{ctx.t("export.session")}</span>
            </Button>
          </div>
          <Accordion multiple>
            <For each={messages()}>
              {(message) => <RawMessage message={message} onRendered={restoreScroll} time={formatter().time} />}
            </For>
          </Accordion>
        </div>
      </div>
    </ScrollView>
  )
}

function same<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  if (a === b) return true

  if (!a || !b) return false

  if (a.length !== b.length) return false

  return a.every((x, i) => x === b[i])
}
