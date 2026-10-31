import { Icon } from "@opencode/ui/icon"
import { useTheme } from "@opencode/ui/theme/context"
import { onCleanup, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useLayout } from "@/shell/state/layout"
import { useNavigate } from "@solidjs/router"
import { useTabs } from "@/shell/tabs/tabs"
import { isNorseTheme } from "@/theme/norse"

export function NorseRail(props: {
  hidden: boolean
  pinned: boolean
  onTogglePin: () => void
  onTabsMount: (element: HTMLElement | undefined) => void
  onToggleHome: () => void
}) {
  const theme = useTheme()
  const language = useLanguage()
  const tabs = useTabs()
  const layout = useLayout()
  const navigate = useNavigate()

  onCleanup(() => props.onTabsMount(undefined))

  const isHome = () => layout.route().type === "home"

  return (
    <Show when={isNorseTheme(theme.themeId())}>
      <aside
        data-component="norse-rail"
        hidden={props.hidden}
        style={{ display: props.hidden ? "none" : undefined }}
        data-pinned={props.pinned ? "true" : undefined}
        aria-label={language.t("norse.rail.label")}
      >
        <div data-slot="norse-rail-head">
          <button
            type="button"
            data-slot="norse-rail-brand"
            data-active={isHome() ? "true" : undefined}
            data-state={isHome() ? "pressed" : undefined}
            aria-pressed={isHome()}
            aria-label={language.t("norse.rail.home")}
            title={language.t("norse.rail.home")}
            onClick={props.onToggleHome}
          >
            <span data-slot="norse-rail-brand-rune" aria-hidden="true">
              <span>ᛗ</span>
            </span>
            <span data-slot="norse-rail-brand-text" class="norse-rail-reveal">
              {language.t("norse.brand")}
            </span>
          </button>
          <button
            type="button"
            data-slot="norse-rail-pin"
            class="norse-rail-reveal"
            aria-label={language.t(props.pinned ? "norse.rail.unpin" : "norse.rail.pin")}
            title={language.t(props.pinned ? "norse.rail.unpin" : "norse.rail.pin")}
            aria-pressed={props.pinned}
            onClick={props.onTogglePin}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 4h6l-1 7 4 3v2H6v-2l4-3z" />
              <path d="M12 16v4" />
            </svg>
          </button>
        </div>

        <div data-slot="norse-rail-sessions" class="norse-rail-reveal">
          <div data-slot="norse-rail-sessions-head">
            <span>{language.t("norse.rail.sessions")}</span>
            <span>{tabs.store.length}</span>
          </div>
          {/* Titlebar owns the strip and its commands; the rail only supplies its portal destination. */}
          <div
            ref={props.onTabsMount}
            data-slot="vertical-tabs-sidebar"
            class="flex min-h-0 min-w-0 flex-1 flex-col"
          />
        </div>

        <button
          type="button"
          data-slot="norse-rail-settings"
          data-active={layout.route().type === "settings" ? "true" : undefined}
          aria-label={language.t("sidebar.settings")}
          title={language.t("sidebar.settings")}
          onClick={() => navigate("/settings")}
        >
          <span aria-hidden="true">
            <Icon name="settings-gear" />
          </span>
          <span class="norse-rail-reveal">{language.t("sidebar.settings")}</span>
        </button>
      </aside>
    </Show>
  )
}
