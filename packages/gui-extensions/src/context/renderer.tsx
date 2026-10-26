import { lazy, onCleanup, Show, Suspense } from "solid-js"
import { useTheme } from "@opencode/ui/theme/context"
import { onIdle, Panel, Slot, usePanel, type PanelTab, type Setup } from "../sdk"
import type definition from "./index"
import { SessionContextUsage } from "./indicator"

function HeaderContextUsage(props: { session: Parameters<typeof SessionContextUsage>[0]["session"]; placement: "bottom" }) {
  const theme = useTheme()

  return (
    <Show when={theme.themeId() !== "norse"}>
      <SessionContextUsage session={props.session} placement={props.placement} />
    </Show>
  )
}

const setup: Setup<typeof definition> = (ctx) => {
  const SessionContextTab = lazy(() => import("./tab"))
  // Compile the tab while the app idles, so the first open renders at once.
  onCleanup(onIdle(() => void SessionContextTab.preload()))

  // One tab object for every session, so neither strip updates nor a session switch remount its trigger; the label
  // reads the routed session from its state.
  const tab: PanelTab = {
    id: "main",
    get title() {
      return ctx.t("tab.title")
    },
    draggable: false,
    closable: "compact",
    first: true,
    fallback: true,
    label: (state) => (
      <div class="flex items-center gap-2">
        <SessionContextUsage session={state.session} variant="indicator" />
        <div>{ctx.t("tab.title")}</div>
      </div>
    ),
  }

  ctx.add(Slot, {
    at: "session.header",
    order: 10,
    render: (input) => <HeaderContextUsage session={input.session} placement="bottom" />,
  })

  ctx.add(Slot, {
    at: "session.composer",
    order: 10,
    render: (input) => <SessionContextUsage session={input.session} variant="composer" placement="top" />,
  })

  ctx.add(
    Panel,
    (): Panel => ({
      id: "main",
      region: "side",
      // Stored before extensions as "context", then under the extension's earlier id `usage`.
      legacy: { context: "main", "usage:context": "main" },
      mobile: { title: ctx.t("mobile.title"), order: 40, kind: "menu", icon: "status" },
      list: (input) => (input.open.includes("main") ? [tab] : []),
      render: (props) => {
        const panel = usePanel()

        return (
          <Show
            when={panel.placement() !== "mobile"}
            fallback={
              <Suspense>
                <SessionContextTab session={props.session} />
              </Suspense>
            }
          >
            <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
              <Suspense>
                <SessionContextTab session={props.session} />
              </Suspense>
            </div>
          </Show>
        )
      },
    }),
  )
}

export default setup
