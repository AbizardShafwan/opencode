import { Dialog } from "@kobalte/core/dialog"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { useI18n, type UiI18n } from "@opencode/ui/context/i18n"
import { createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { renderMermaidSvg } from "./markdown-mermaid"
import "./markdown-mermaid-viewer.css"

type Input = { source: string; complete: boolean }

/** Own the Solid roots mounted into Markdown's otherwise imperative code-block DOM. */
export function createMarkdownMermaid() {
  const i18n = useI18n()
  const dialog = useDialog()
  const viewers = new Map<HTMLElement, { update: (input: Input) => void; dispose: () => void }>()

  const clear = (wrapper: HTMLElement) => {
    viewers.get(wrapper)?.dispose()
    viewers.delete(wrapper)
    delete wrapper.dataset.mermaidView
    delete wrapper.dataset.mermaidReady
  }

  onCleanup(() => viewers.forEach((_, wrapper) => clear(wrapper)))

  return (root: HTMLElement) => {
    viewers.forEach((_, wrapper) => {
      if (!root.contains(wrapper) || !wrapper.querySelector(":scope > pre > code.language-mermaid")) clear(wrapper)
    })
    root.querySelectorAll<HTMLElement>('[data-component="markdown-code"]').forEach((wrapper) => {
      const code = wrapper.querySelector(":scope > pre > code.language-mermaid")

      if (!code) return

      const input = {
        source: code.textContent ?? "",
        complete: wrapper.closest<HTMLElement>("[data-markdown-complete]")?.dataset.markdownComplete !== "false",
      }

      const existing = viewers.get(wrapper)

      if (existing) return existing.update(input)
      const host = document.createElement("div")
      host.dataset.slot = "mermaid-viewer-host"
      wrapper.appendChild(host)

      const [value, setValue] = createSignal(input, {
        equals: (a, b) => a.source === b.source && a.complete === b.complete,
      })

      const lifetime = new AbortController()
      const id = `mermaid-preview-${createUniqueId()}`

      const dispose = render(
        () => (
          <MermaidViewer
            input={value()}
            i18n={i18n}
            onView={(code, ready) => {
              wrapper.dataset.mermaidView = code ? "code" : "diagram"
              wrapper.dataset.mermaidReady = String(ready)
            }}
            onExpand={() => {
              void dialog.show(
                () => (
                  <Dialog.Content data-component="mermaid-dialog">
                    <header>
                      <Dialog.Title>{i18n.t("ui.mermaid.title")}</Dialog.Title>
                      <Dialog.CloseButton as={Button} variant="ghost">
                        {i18n.t("ui.common.close")}
                      </Dialog.CloseButton>
                    </header>
                    <MermaidViewer input={value()} i18n={i18n} expanded />
                  </Dialog.Content>
                ),
                undefined,
                id,
                lifetime.signal,
              )
            }}
          />
        ),
        host,
      )

      viewers.set(wrapper, {
        update: setValue,
        dispose: () => {
          lifetime.abort()
          dialog.close(id)
          dispose()
          host.remove()
        },
      })
    })
  }
}

function MermaidViewer(props: {
  input: Input
  i18n: UiI18n
  expanded?: boolean
  onView?: (code: boolean, ready: boolean) => void
  onExpand?: () => void
}) {
  const [state, setState] = createStore({
    code: false,
    svg: "",
    loading: true,
    error: false,
    copied: false,
    copyError: false,
  })

  const [theme, setTheme] = createSignal(document.documentElement.dataset.colorScheme)
  const complete = createMemo(() => props.input.complete)

  const renderSource = createMemo(() => {
    const input = props.input

    return input.complete ? input.source : input.source.slice(0, input.source.lastIndexOf("\n") + 1)
  })

  const sourceView = () => state.code || (!state.svg && !state.loading)
  let disposed = false

  onMount(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.colorScheme))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-scheme"] })
    onCleanup(() => observer.disconnect())
  })
  onCleanup(() => {
    disposed = true
  })

  createEffect(() => {
    const finished = complete()
    const color = theme() === "light" ? "default" : "dark"
    const source = renderSource()
    const lifetime = new AbortController()
    onCleanup(() => lifetime.abort())
    setState({ loading: true, error: false })

    const failed = () => {
      if (lifetime.signal.aborted) return
      setState({ loading: false, error: finished })

      if (finished) setState("svg", "")
    }

    if (!source) {
      failed()

      return
    }

    void renderMermaidSvg(source, color, lifetime.signal).then((svg) => {
      if (lifetime.signal.aborted) return

      if (!svg) return failed()
      setState({ svg, loading: false })
    }, failed)
  })

  createEffect(() => props.onView?.(sourceView(), !!state.svg))
  createEffect(
    on(
      () => props.input.source,
      () => setState({ copied: false, copyError: false }),
    ),
  )

  const copy = async () => {
    const source = props.input.source

    const copied = await Promise.resolve()
      .then(() => navigator.clipboard.writeText(source))
      .then(
        () => true,
        () => false,
      )

    if (disposed || props.input.source !== source) return
    setState({ copied, copyError: !copied })
  }

  return (
    <section data-component="markdown-mermaid" data-expanded={props.expanded || undefined}>
      <div data-slot="mermaid-toolbar" role="group" aria-label={props.i18n.t("ui.mermaid.title")}>
        <Button variant="ghost" aria-pressed={!sourceView()} onClick={() => setState("code", false)}>
          {props.i18n.t("ui.mermaid.diagram")}
        </Button>
        <Button variant="ghost" aria-pressed={sourceView()} onClick={() => setState("code", true)}>
          {props.i18n.t("ui.mermaid.code")}
        </Button>
        <div data-slot="mermaid-toolbar-spacer" />
        <Button variant="ghost" onClick={() => void copy()}>
          {props.i18n.t(state.copied ? "ui.message.copied" : "ui.message.copy")}
        </Button>
        <Show when={props.onExpand}>
          <Button variant="ghost" onClick={() => props.onExpand?.()}>
            {props.i18n.t("ui.mermaid.expand")}
          </Button>
        </Show>
      </div>
      <Show when={state.copyError}>
        <p role="alert">{props.i18n.t("ui.mermaid.copyError")}</p>
      </Show>
      <Show when={state.error}>
        <p role="status">{props.i18n.t("ui.mermaid.error")}</p>
      </Show>
      <Show when={state.loading && !state.svg && !sourceView()}>
        <p role="status">{props.i18n.t("ui.mermaid.loading")}</p>
      </Show>
      <div data-slot="mermaid-diagram" hidden={sourceView() || !state.svg}>
        <MermaidViewport svg={state.svg} i18n={props.i18n} expanded={props.expanded} />
      </div>
      <Show when={props.expanded && (sourceView() || !state.svg)}>
        <pre data-slot="mermaid-source">
          <code>{props.input.source}</code>
        </pre>
      </Show>
    </section>
  )
}

function MermaidViewport(props: { svg: string; i18n: UiI18n; expanded?: boolean }) {
  let viewport!: HTMLDivElement
  let canvas!: HTMLDivElement
  const hint = createUniqueId()
  const [state, setState] = createStore({ zoom: 1, x: 0, y: 0, width: 0, height: 0, diagramWidth: 1, diagramHeight: 1 })
  const pointers = new Map<number, { x: number; y: number }>()

  const size = createMemo(() => {
    const scale = Math.min(
      Math.max(1, state.width - 32) / state.diagramWidth,
      Math.max(1, state.height - 32) / state.diagramHeight,
    )

    return { width: state.diagramWidth * scale, height: state.diagramHeight * scale }
  })

  const fit = () => setState({ zoom: 1, x: 0, y: 0 })

  const zoom = (factor: number, x = 0, y = 0) => {
    const next = Math.min(8, Math.max(0.25, state.zoom * factor))
    const ratio = next / state.zoom
    setState({ zoom: next, x: x - (x - state.x) * ratio, y: y - (y - state.y) * ratio })
  }

  createEffect(() => {
    canvas.innerHTML = props.svg
    const svg = canvas.querySelector("svg")

    if (!svg) return
    const box = svg.viewBox.baseVal
    setState({
      diagramWidth: box.width || svg.width.baseVal.value || 1,
      diagramHeight: box.height || svg.height.baseVal.value || 1,
    })
    svg.style.width = "100%"
    svg.style.height = "100%"
    svg.style.maxWidth = "none"
  })

  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setState({ width: entry.contentRect.width, height: entry.contentRect.height })
    })

    observer.observe(viewport)

    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const box = viewport.getBoundingClientRect()
      const delta = event.deltaY * ([1, 16, box.height][event.deltaMode] ?? 1)
      zoom(Math.exp(-delta * 0.01), event.clientX - box.left - box.width / 2, event.clientY - box.top - box.height / 2)
    }

    viewport.addEventListener("wheel", wheel, { passive: false })
    onCleanup(() => {
      observer.disconnect()
      viewport.removeEventListener("wheel", wheel)
      pointers.forEach((_, id) => {
        if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id)
      })
      pointers.clear()
    })
  })

  const move = (event: PointerEvent) => {
    const previous = pointers.get(event.pointerId)

    if (!previous) return
    const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)?.[1]
    const next = { x: event.clientX, y: event.clientY }
    pointers.set(event.pointerId, next)

    if (!other) {
      setState({ x: state.x + next.x - previous.x, y: state.y + next.y - previous.y })

      return
    }

    const distance = Math.hypot(previous.x - other.x, previous.y - other.y)

    if (!distance) return
    const box = viewport.getBoundingClientRect()
    zoom(
      Math.hypot(next.x - other.x, next.y - other.y) / distance,
      (previous.x + other.x) / 2 - box.left - box.width / 2,
      (previous.y + other.y) / 2 - box.top - box.height / 2,
    )
    setState({ x: state.x + (next.x - previous.x) / 2, y: state.y + (next.y - previous.y) / 2 })
  }

  return (
    <>
      <div data-slot="mermaid-navigation" role="group" aria-label={props.i18n.t("ui.mermaid.navigation")}>
        <Button
          variant="ghost"
          aria-label={props.i18n.t("ui.mermaid.zoomOut")}
          disabled={state.zoom <= 0.25}
          onClick={() => zoom(1 / 1.25)}
        >
          −
        </Button>
        <output aria-label={props.i18n.t("ui.mermaid.zoom")}>{Math.round(state.zoom * 100)}%</output>
        <Button
          variant="ghost"
          aria-label={props.i18n.t("ui.mermaid.zoomIn")}
          disabled={state.zoom >= 8}
          onClick={() => zoom(1.25)}
        >
          +
        </Button>
        <Button variant="ghost" onClick={fit}>
          {props.i18n.t("ui.mermaid.fit")}
        </Button>
      </div>
      <div
        ref={viewport}
        data-slot="mermaid-viewport"
        style={{
          height: props.expanded
            ? undefined
            : `${Math.min(420, Math.max(160, ((state.width - 32) * state.diagramHeight) / state.diagramWidth + 32))}px`,
        }}
        tabIndex={0}
        role="region"
        aria-label={props.i18n.t("ui.mermaid.diagram")}
        aria-describedby={hint}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          viewport.focus({ preventScroll: true })
          viewport.setPointerCapture(event.pointerId)
          pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

          if (event.pointerType === "mouse") event.preventDefault()
        }}
        onPointerMove={move}
        onPointerUp={(event) => {
          pointers.delete(event.pointerId)

          if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={(event) => pointers.delete(event.pointerId)}
        onLostPointerCapture={(event) => pointers.delete(event.pointerId)}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return

          switch (event.key) {
            case "+":
            case "=":
              zoom(1.25)
              break
            case "-":
              zoom(1 / 1.25)
              break
            case "0":
              fit()
              break
            case "ArrowLeft":
              setState("x", (x) => x + 32)
              break
            case "ArrowRight":
              setState("x", (x) => x - 32)
              break
            case "ArrowUp":
              setState("y", (y) => y + 32)
              break
            case "ArrowDown":
              setState("y", (y) => y - 32)
              break
            default:
              return
          }

          event.preventDefault()
          event.stopPropagation()
        }}
      >
        <div
          ref={canvas}
          data-slot="mermaid-canvas"
          style={{
            width: `${size().width}px`,
            height: `${size().height}px`,
            transform: `translate(-50%, -50%) translate(${state.x}px, ${state.y}px) scale(${state.zoom})`,
          }}
        />
      </div>
      <p id={hint} data-slot="mermaid-hint">
        {props.i18n.t("ui.mermaid.hint")}
      </p>
    </>
  )
}
