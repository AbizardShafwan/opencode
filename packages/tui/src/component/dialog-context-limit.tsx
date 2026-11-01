import { createMemo } from "solid-js"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect, type DialogSelectAction, type DialogSelectOption } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useLocal } from "../context/local"
import { useLocation } from "../context/location"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { parseTokenLimit, formatTokenLimit, resolveSoftLimit } from "@opencode/util/token-limit"
import { compactionSettings } from "@opencode/client/solid"

const CANDIDATE_PRESETS = [1_500_000, 1_000_000, 750_000, 500_000, 372_000, 250_000, 128_000, 100_000, 80_000, 64_000]

export function DialogContextLimit(props: { sessionID?: string }) {
  const dialog = useDialog()
  const client = useClient()
  const data = useData()
  const local = useLocal()
  const location = useLocation()
  const toast = useToast()

  const session = createMemo(() => (props.sessionID ? data.session.get(props.sessionID) : undefined))
  const models = createMemo(() => data.location.model.list(session()?.location ?? location.ref))
  const modelSelection = createMemo(() => session()?.model ?? local.model.current())
  const activeModel = createMemo(() => {
    const selection = modelSelection()
    if (!selection) return undefined
    const modelID = "id" in selection ? selection.id : selection.modelID
    return models()?.find((item) => item.providerID === selection.providerID && item.id === modelID)
  })

  const hardLimit = createMemo(() => activeModel()?.limit.input || activeModel()?.limit.context || 0)
  const modelKey = createMemo(() => {
    const model = activeModel()
    if (model) return `${model.providerID}/${model.id}`
    const selection = modelSelection()
    if (!selection) return undefined
    const modelID = "id" in selection ? selection.id : selection.modelID
    return `${selection.providerID}/${modelID}`
  })

  const currentSoftLimit = createMemo(() => {
    const settings = compactionSettings(data.location.config.list(session()?.location ?? location.ref), modelKey())
    return resolveSoftLimit(session()?.metadata?.softLimit, settings.modelLimit, settings.defaultLimit)
  })

  const presets = createMemo(() => {
    const hard = hardLimit()
    if (hard <= 0) return []
    return CANDIDATE_PRESETS.filter((p) => p < hard && (hard >= 1_000_000 ? p >= 128_000 : p >= 40_000))
  })

  function apply(tokens: number | undefined, save: boolean, clamped?: boolean) {
    const metadata = { ...(session()?.metadata ?? {}) }
    if (tokens === undefined) {
      delete metadata.softLimit
    } else {
      metadata.softLimit = tokens
    }
    const key = modelKey()
    const persistConfig = save || !props.sessionID

    void (async () => {
      try {
        if (props.sessionID) {
          await client.api.session.update({ sessionID: props.sessionID, metadata })
        }
        if (persistConfig && key) {
          await client.api.config.update({ softLimit: { modelKey: key, limit: tokens ?? null } })
        }
        dialog.clear()
        if (tokens === undefined) {
          toast.show({
            message: persistConfig ? "Reset context limit and saved to config" : "Reset context limit to default",
            variant: "info",
          })
          return
        }
        if (clamped) {
          toast.show({
            message: `Context limit clamped to model capacity (${formatTokenLimit(tokens)})${persistConfig ? " and saved to config" : ""}`,
            variant: "warning",
          })
          return
        }
        toast.show({
          message: `Context limit set to ${formatTokenLimit(tokens)}${persistConfig ? " and saved to config" : ""}`,
          variant: "info",
        })
      } catch (error) {
        toast.show({ message: errorMessage(error), variant: "error" })
      }
    })()
  }

  function openCustomPrompt(save: boolean) {
    dialog.replace(() => (
      <DialogPrompt
        title={save ? "Set and save context soft limit" : "Set context soft limit"}
        placeholder="e.g. 372k, 500k, max, reset"
        value={currentSoftLimit() ? formatTokenLimit(currentSoftLimit()!) : ""}
        onConfirm={(input) => {
          const parsed = parseTokenLimit(input, hardLimit() || undefined)
          if (parsed.error) {
            toast.show({ message: parsed.error, variant: "error", duration: 5000 })
            return
          }
          if (parsed.clear) {
            apply(undefined, save)
            return
          }
          apply(parsed.tokens, save, parsed.clamped)
        }}
        onCancel={() => dialog.clear()}
      />
    ))
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const hard = hardLimit()
    return [
      {
        title: "Default",
        value: "default",
        description: "Inherit configuration",
        onSelect: () => apply(undefined, false),
      },
      ...(hard > 0
        ? [
            {
              title: `Max (${formatTokenLimit(hard)})`,
              value: "max",
              description: "Physical model limit",
              onSelect: () => apply(hard, false),
            },
          ]
        : []),
      ...presets().map((tokens) => ({
        title: formatTokenLimit(tokens),
        value: String(tokens),
        description: `${tokens.toLocaleString()} tokens`,
        onSelect: () => apply(tokens, false),
      })),
      {
        title: "Custom...",
        value: "custom",
        description: "Enter a token limit",
        onSelect: () => openCustomPrompt(false),
      },
    ]
  })

  const actions: DialogSelectAction<string>[] = [
    {
      command: "context_limit.save",
      title: "Save as default",
      bind: "ctrl+s",
      selection: "required",
      onTrigger: (option: DialogSelectOption<string>) => {
        if (option.value === "custom") {
          openCustomPrompt(true)
          return
        }
        if (option.value === "default") {
          apply(undefined, true)
          return
        }
        if (option.value === "max") {
          apply(hardLimit(), true)
          return
        }
        apply(Number(option.value), true)
      },
    },
  ]

  const currentValue = createMemo(() => {
    const current = currentSoftLimit()
    if (current === undefined || resolveSoftLimit(session()?.metadata?.softLimit) === undefined) return "default"
    if (current === hardLimit()) return "max"
    if (presets().includes(current)) return String(current)
    return "custom"
  })

  return (
    <DialogSelect<string>
      options={options()}
      title="Context soft limit"
      renderFilter={false}
      current={currentValue()}
      flat={true}
      actions={actions}
      onCancel={() => dialog.clear()}
    />
  )
}

DialogContextLimit.show = (dialog: DialogContext, sessionID?: string) =>
  dialog.replace(() => <DialogContextLimit sessionID={sessionID} />)
