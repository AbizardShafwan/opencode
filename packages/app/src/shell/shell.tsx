import { Show, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { useTheme } from "@opencode/ui/theme/context"
import { Titlebar } from "@/shell/titlebar/titlebar"
import { NorseRail } from "@/shell/norse-rail"
import { usePlatform } from "@/runtime/platform/platform"
import { ToastRegion } from "@/shell/notifications/toast"
import { UploadToastHost } from "@/composer/attachments/uploads"
import { TitlebarRightProvider } from "@/shell/titlebar/right-slot"
import { useSettingsSurface } from "@/settings/surface"
import { useSettings } from "@/settings/model"
import { ExtensionServerCover } from "@/runtime/extension/server-shell"
import { ExtensionSlot } from "@/runtime/extension/render"
import { NorseBackdrop } from "@/theme/norse-backdrop"
import { isNorseTheme } from "@/theme/norse"

const NORSE_RAIL_PINNED_KEY = "opencode-norse-rail-pinned"

function readRailPinned() {
  if (typeof localStorage !== "object") return false

  try {
    return localStorage.getItem(NORSE_RAIL_PINNED_KEY) === "true"
  } catch {
    return false
  }
}

function writeRailPinned(pinned: boolean) {
  if (typeof localStorage !== "object") return

  try {
    localStorage.setItem(NORSE_RAIL_PINNED_KEY, String(pinned))
  } catch {}
}

export default function Layout(props: ParentProps) {
  const platform = usePlatform()
  const settings = useSettingsSurface()
  const preferences = useSettings()
  const theme = useTheme()
  const mobile = createMediaQuery("(max-width: 767px)")

  const [state, setState] = createStore<{
    tabsWidth: number
    tabsMount: HTMLElement | undefined
    railTabsMount: HTMLElement | undefined
  }>({
    tabsWidth: 260,
    tabsMount: undefined,
    railTabsMount: undefined,
  })
  const [rail, setRail] = createStore({ pinned: readRailPinned() })

  const norse = () => isNorseTheme(theme.themeId())
  const showRail = () => norse() && !mobile() && !settings.active()
  const toggleRailPin = () => {
    const pinned = !rail.pinned
    setRail("pinned", pinned)
    writeRailPinned(pinned)
  }

  const verticalTabs = () => !mobile() && (norse() || preferences.appearance.tabLayout() === "vertical")
  const bottomTitlebar = () => mobile() && preferences.general.mobileTitlebarPosition() === "bottom"

  return (
    <TitlebarRightProvider>
      <div
        data-component="app-shell"
        class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
        style={{
          // Mobile panels only need clearance for their outer border.
          "--shell-inline-inset": norse() ? "0px" : mobile() ? "1px" : "8px",
          // A bottom mobile titlebar leaves main's top edge to the safe area. Native Windows chrome supplies the gap;
          // retain outer-outline clearance.
          "--shell-top-inset": norse()
            ? "0px"
            : bottomTitlebar()
              ? "0px"
              : platform.platform === "desktop" && platform.os === "windows"
                ? "1px"
                : "8px",
          "--shell-bottom-inset": norse()
            ? "0px"
            : bottomTitlebar()
              ? "8px"
              : "max(0px, calc(8px - var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))))",
        }}
      >
        <NorseBackdrop />
        <Titlebar verticalTabs={verticalTabs() ? { mount: norse() ? state.railTabsMount : state.tabsMount } : undefined} />
        <div
          data-slot="shell-content"
          class="relative flex flex-1 min-h-0 min-w-0 flex-row"
          style={{
            "padding-left": showRail() ? `${rail.pinned ? 296 : 64}px` : undefined,
          }}
        >
          <Show when={norse() && !mobile()}>
            <NorseRail
              hidden={settings.active()}
              pinned={rail.pinned}
              onTogglePin={toggleRailPin}
              onTabsMount={(element) => setState("railTabsMount", element)}
            />
          </Show>
          <Show when={verticalTabs() && !norse()}>
            <aside
              ref={(element) => setState("tabsMount", element)}
              data-slot="vertical-tabs-sidebar"
              class="relative flex h-full min-h-0 shrink-0 flex-col bg-v2-background-bg-deep pe-0.5 ps-2.5 pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]"
              style={{
                width: `${state.tabsWidth}px`,
                "padding-bottom": "max(10px, var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
              }}
            >
              <ResizeHandle
                class="-end-2"
                direction="horizontal"
                size={state.tabsWidth}
                min={140}
                max={520}
                onResize={(width) => setState("tabsWidth", width)}
              />
            </aside>
          </Show>
          {/* Size containment collapses percentage-height descendants in WebKit. */}
          <main
            class="relative flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-content"
            style={{
              "padding-top": bottomTitlebar() ? "env(safe-area-inset-top, 0px)" : "0px",
              "padding-bottom":
                bottomTitlebar() || settings.active()
                  ? "0px"
                  : "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
              "--settings-bottom-inset": bottomTitlebar()
                ? "40px"
                : "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
            }}
          >
            <ExtensionServerCover>
              <Suspense>{props.children}</Suspense>
            </ExtensionServerCover>
          </main>
        </div>
        <ExtensionSlot at="window.bottom" input={{}} />
        <ToastRegion />
        <UploadToastHost />
      </div>
    </TitlebarRightProvider>
  )
}
