import { Icon } from "@opencode/ui/icon"
import { useTheme } from "@opencode/ui/theme/context"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useLayout } from "@/shell/state/layout"
import { useNavigate } from "@solidjs/router"
import { addProjects } from "@/home/projects/add"
import { homeProjectDirectories } from "@/shell/layout/helpers"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import { tabKey, useTabs } from "@/shell/tabs/tabs"
import { isNorseTheme } from "@/theme/norse"

function basename(directory: string | undefined) {
  if (!directory) return
  return directory.split(/[\\/]/).filter(Boolean).at(-1)
}

export function NorseRail(props: {
  hidden: boolean
  pinned: boolean
  onTogglePin: () => void
  onTabsMount: (element: HTMLElement | undefined) => void
}) {
  const theme = useTheme()
  const language = useLanguage()
  const tabs = useTabs()
  const layout = useLayout()
  const global = useGlobal()
  const servers = useServers()
  const navigate = useNavigate()
  const pickDirectory = useDirectoryPicker()

  const [state, setState] = createStore({ projectMenu: false })
  const [rail, setRail] = createStore<{ element: HTMLElement | undefined }>({ element: undefined })
  let projectTrigger: HTMLButtonElement | undefined
  let projectMenu: HTMLDivElement | undefined

  const activeTab = createMemo(() => {
    const route = layout.route()

    if (route.type === "session") {
      return tabs.store.find(
        (tab) =>
          tab.type === "session" &&
          tab.server === route.server &&
          (tab.sessionId === route.sessionId || tab.routeSessionId === route.sessionId),
      )
    }

    if (route.type === "draft") return tabs.store.find((tab) => tab.type === "draft" && tab.draftID === route.draftID)
  })

  const activeDirectory = createMemo(() => {
    const tab = activeTab()

    if (tab?.type === "draft") return tab.directory
    if (tab) return tabs.info[tabKey(tab)]?.directory
    return layout.home.selection().directory
  })

  const projects = createMemo(() =>
    servers.visible.flatMap((connection) =>
      global
        .ensureServerCtx(connection)
        .projects.list()
        .map((project) => ({ connection, project })),
    ),
  )

  const projectDirectory = createMemo(() => activeDirectory() ?? projects()[0]?.project.worktree)

  const projectName = createMemo(() => basename(projectDirectory()) ?? "Memyr")

  // The rail replaces the home project picker on desktop, so its add action must open the same directory picker.
  const addProject = () => {
    const connection =
      servers.visible.find((conn) => ServerConnection.key(conn) === layout.home.selection().server) ??
      servers.visible[0]

    if (!connection) return
    setState("projectMenu", false)
    pickDirectory({
      server: connection,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: (result) => {
        const directory = addProjects(global.ensureServerCtx(connection), homeProjectDirectories(result))

        if (directory) layout.home.setSelection({ server: ServerConnection.key(connection), directory })
      },
    })
  }

  const projectItems = () => Array.from(projectMenu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])

  const onProjectMenuKeyDown = (event: KeyboardEvent) => {
    const items = projectItems()

    if (!items.length) return
    const index = items.indexOf(document.activeElement as HTMLElement)

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      items[(index + step + items.length) % items.length]?.focus()

      return
    }

    if (event.key === "Home" || event.key === "End") {
      event.preventDefault()
      items[event.key === "Home" ? 0 : items.length - 1]?.focus()

      return
    }

    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    setState("projectMenu", false)
    projectTrigger?.focus()
  }

  const selectProject = (connection: (typeof servers.visible)[number], project: { worktree: string }) => {
    layout.home.setSelection({ server: ServerConnection.key(connection), directory: project.worktree })
    setState("projectMenu", false)
    navigate("/")
  }

  onMount(() => {
    makeEventListener(document, "pointerdown", (event) => {
      if (!state.projectMenu) return
      if (!(event.target instanceof Node)) return
      if (rail.element?.contains(event.target)) return
      setState("projectMenu", false)
    })
  })

  onCleanup(() => props.onTabsMount(undefined))

  return (
    <Show when={isNorseTheme(theme.themeId())}>
      <aside
        ref={(element) => setRail("element", element)}
        data-component="norse-rail"
        hidden={props.hidden}
        style={{ display: props.hidden ? "none" : undefined }}
        data-pinned={props.pinned ? "true" : undefined}
        data-project-menu={state.projectMenu ? "true" : undefined}
        aria-label={language.t("norse.rail.label")}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !state.projectMenu) return
          event.stopPropagation()
          setState("projectMenu", false)
        }}
      >
        <div data-slot="norse-rail-head">
          <button
            type="button"
            data-slot="norse-rail-brand"
            aria-label={language.t("home.title")}
            title={language.t("home.title")}
            onClick={() => navigate("/")}
          >
            <span aria-hidden="true">ᛗ</span>
          </button>
          <button
            ref={(element) => (projectTrigger = element)}
            type="button"
            data-slot="norse-rail-project"
            class="norse-rail-reveal"
            aria-label={language.t("norse.rail.project")}
            title={language.t("norse.rail.project")}
            aria-haspopup="menu"
            aria-expanded={state.projectMenu}
            onClick={() => setState("projectMenu", !state.projectMenu)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
              event.preventDefault()
              setState("projectMenu", true)
            }}
          >
            <span data-slot="norse-rail-project-name">{projectName()}</span>
            <Icon name="chevron-down" size="small" />
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

        <Show when={state.projectMenu}>
          <div
            ref={(element) => {
              projectMenu = element
              queueMicrotask(() => projectItems()[0]?.focus())
            }}
            data-slot="norse-rail-project-menu"
            role="menu"
            aria-label={language.t("home.projects")}
            onKeyDown={onProjectMenuKeyDown}
          >
            <div data-slot="norse-rail-project-current">
              <strong>{projectName()}</strong>
              <span>{projectDirectory() ?? ""}</span>
            </div>
            <For each={projects()}>
              {({ connection, project }) => (
                <button
                  type="button"
                  role="menuitem"
                  data-slot="norse-rail-project-item"
                  data-active={
                    project.worktree === activeDirectory() &&
                    ServerConnection.key(connection) === layout.home.selection().server
                      ? "true"
                      : undefined
                  }
                  onClick={() => selectProject(connection, project)}
                >
                  <Icon name="folder" size="small" />
                  <span>
                    <strong>{project.name ?? basename(project.worktree) ?? project.worktree}</strong>
                    <small>{project.worktree}</small>
                  </span>
                </button>
              )}
            </For>
            <div data-slot="norse-rail-project-rule" />
            <button
              type="button"
              role="menuitem"
              data-slot="norse-rail-project-item"
              onClick={addProject}
            >
              <Icon name="folder-add-left" size="small" />
              <span>
                <strong>{language.t("home.project.add")}</strong>
              </span>
            </button>
          </div>
        </Show>

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
