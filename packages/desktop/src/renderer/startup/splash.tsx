import { Wordmark } from "@opencode/ui/wordmark"
import type { Platform } from "@opencode/app/desktop"
import { createUniqueId, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import "./splash.css"

const markPath = "M0 0H20L60 50L100 0H120V110H100V46L60 92L20 46V110H0Z"

function BifrostConstellation() {
  const uid = createUniqueId()
  const bifrostGrad = `${uid}-bifrost`
  const emblemFill = `${uid}-emblem-fill`
  const goldTrail = `${uid}-gold-trail`
  const royalTrail = `${uid}-royal-trail`
  const coreGlow = `${uid}-core-glow`

  return (
    <div data-slot="splash-constellation" class="relative flex items-center justify-center select-none">
      <div data-slot="splash-aurora" class="pointer-events-none absolute inset-0" />
      <svg
        data-slot="splash-constellation-svg"
        viewBox="-120 -120 240 240"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        class="relative block size-48 overflow-visible"
      >
        <defs>
          <linearGradient id={bifrostGrad} x1="-72" y1="-72" x2="72" y2="72" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#f3c978" />
            <stop offset="48%" stop-color="#cf9f52" />
            <stop offset="100%" stop-color="#6183ff" />
          </linearGradient>
          <linearGradient id={emblemFill} x1="0" y1="0" x2="120" y2="110" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#f5cf82" />
            <stop offset="52%" stop-color="#cf9f52" />
            <stop offset="100%" stop-color="#7c9aff" />
          </linearGradient>
          <linearGradient id={goldTrail} x1="-59" y1="-34" x2="0" y2="-68" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#cf9f52" stop-opacity="0" />
            <stop offset="65%" stop-color="#e5b968" stop-opacity="0.65" />
            <stop offset="100%" stop-color="#fff3d1" stop-opacity="1" />
          </linearGradient>
          <linearGradient id={royalTrail} x1="59" y1="34" x2="0" y2="68" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#6183ff" stop-opacity="0" />
            <stop offset="65%" stop-color="#89a4ff" stop-opacity="0.65" />
            <stop offset="100%" stop-color="#e3ecff" stop-opacity="1" />
          </linearGradient>
          <radialGradient id={coreGlow} cx="0" cy="0" r="68" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="#cf9f52" stop-opacity="0.34" />
            <stop offset="55%" stop-color="#6183ff" stop-opacity="0.16" />
            <stop offset="100%" stop-color="#6183ff" stop-opacity="0" />
          </radialGradient>
        </defs>

        <circle data-slot="splash-core-halo" cx="0" cy="0" r="66" fill={`url(#${coreGlow})`} />

        <g data-slot="splash-orbit-guide">
          <circle
            cx="0"
            cy="0"
            r="76"
            stroke={`url(#${bifrostGrad})`}
            stroke-opacity="0.22"
            stroke-width="1"
            stroke-dasharray="3 6"
          />
          <path d="M0 -82L2 -76L0 -70L-2 -76Z" fill="#f3c978" fill-opacity="0.7" />
          <path d="M82 0L76 2L70 0L76 -2Z" fill="#89a4ff" fill-opacity="0.7" />
          <path d="M0 82L2 76L0 70L-2 76Z" fill="#f3c978" fill-opacity="0.7" />
          <path d="M-82 0L-76 2L-70 0L-76 -2Z" fill="#89a4ff" fill-opacity="0.7" />
        </g>

        <g data-slot="splash-shockwave">
          <circle
            data-slot="splash-shockwave-primary"
            cx="0"
            cy="0"
            r="56"
            stroke={`url(#${bifrostGrad})`}
            stroke-width="2.5"
          />
          <circle
            data-slot="splash-shockwave-secondary"
            cx="0"
            cy="0"
            r="44"
            stroke="#9db2ff"
            stroke-opacity="0.65"
            stroke-width="1.25"
          />
          <g data-slot="splash-starburst" stroke={`url(#${bifrostGrad})`} stroke-linecap="round" stroke-width="1.75">
            <line x1="0" y1="-62" x2="0" y2="-76" />
            <line x1="44" y1="-44" x2="54" y2="-54" />
            <line x1="62" y1="0" x2="76" y2="0" />
            <line x1="44" y1="44" x2="54" y2="54" />
            <line x1="0" y1="62" x2="0" y2="76" />
            <line x1="-44" y1="44" x2="-54" y2="54" />
            <line x1="-62" y1="0" x2="-76" y2="0" />
            <line x1="-44" y1="-44" x2="-54" y2="-54" />
          </g>
        </g>

        <g data-slot="splash-spark-gold">
          <path
            d="M -64 -20 A 67 67 0 0 1 0 -67"
            stroke={`url(#${goldTrail})`}
            stroke-width="4.5"
            stroke-linecap="round"
          />
          <circle cx="0" cy="-67" r="13" fill="#cf9f52" fill-opacity="0.34" />
          <path
            d="M 0 -81 L 3.4 -70.4 L 14 -67 L 3.4 -63.6 L 0 -53 L -3.4 -63.6 L -14 -67 L -3.4 -70.4 Z"
            fill="#f7d794"
          />
          <circle cx="0" cy="-67" r="3.6" fill="#ffffff" />
        </g>

        <g data-slot="splash-spark-royal">
          <path
            d="M 64 20 A 67 67 0 0 1 0 67"
            stroke={`url(#${royalTrail})`}
            stroke-width="4.5"
            stroke-linecap="round"
          />
          <circle cx="0" cy="67" r="13" fill="#6183ff" fill-opacity="0.36" />
          <path d="M 0 81 L 3.4 70.4 L 14 67 L 3.4 63.6 L 0 53 L -3.4 63.6 L -14 67 L -3.4 70.4 Z" fill="#b4c6ff" />
          <circle cx="0" cy="67" r="3.6" fill="#ffffff" />
        </g>

        <g data-slot="splash-emblem">
          <circle
            cx="0"
            cy="0"
            r="56"
            fill="rgba(24, 26, 36, 0.76)"
            stroke={`url(#${bifrostGrad})`}
            stroke-opacity="0.52"
            stroke-width="1.35"
          />
          <g transform="translate(-33.6, -30.8) scale(0.56)">
            <path data-slot="splash-emblem-fill" d={markPath} fill={`url(#${emblemFill})`} />
            <path
              data-slot="splash-emblem-stroke"
              d={markPath}
              pathLength={1}
              stroke="#fff4d6"
              stroke-opacity="0.88"
              stroke-width="2.5"
              stroke-linejoin="round"
            />
          </g>
        </g>
      </svg>
    </div>
  )
}

export function LoadingSplash(props: {
  deep: boolean
  firstLaunch: boolean
  platform: Platform
  preview: boolean
  onDrawEnd: () => void
}) {
  const [drawing, setDrawing] = createStore({ started: false, finished: false })

  const complete = () => {
    if (drawing.finished) return
    setDrawing("finished", true)
    props.onDrawEnd()
  }

  onMount(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)")

    if (!props.preview) {
      if (motion.matches || document.visibilityState !== "visible") {
        complete()

        return
      }

      const check = () => {
        if (motion.matches || document.visibilityState !== "visible") complete()
      }

      document.addEventListener("visibilitychange", check)
      motion.addEventListener("change", check)
      onCleanup(() => {
        document.removeEventListener("visibilitychange", check)
        motion.removeEventListener("change", check)
      })

      return
    }

    const start = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return
      setDrawing("started", true)

      if (motion.matches) complete()
    }

    window.addEventListener("focus", start)
    document.addEventListener("visibilitychange", start)
    motion.addEventListener("change", start)
    start()
    onCleanup(() => {
      window.removeEventListener("focus", start)
      document.removeEventListener("visibilitychange", start)
      motion.removeEventListener("change", start)
    })
  })

  const titlebarHeight = () => {
    const zoom = props.platform.webviewZoom?.() ?? 1

    if (props.platform.os === "macos") return `max(36px, ${36 / zoom}px)`

    if (props.platform.os === "windows")
      return `max(36px, env(titlebar-area-height, ${44 / Math.min(Math.max(zoom, 0.25), 1)}px))`

    return "36px"
  }

  const drawingState = () => (props.preview && !drawing.started ? "pending" : "running")

  return (
    <Show
      when={props.firstLaunch}
      fallback={
        <div
          data-component="startup-splash"
          data-drawing={drawingState()}
          aria-hidden="true"
          class="h-dvh w-screen flex flex-col items-center justify-center gap-3 overflow-hidden"
          classList={{
            "bg-v2-background-bg-deep": props.deep,
            "bg-v2-background-bg-base": !props.deep,
          }}
          onAnimationEnd={(event) => {
            if (event.animationName === "splash-constellation-complete") complete()
          }}
        >
          <BifrostConstellation />
          <div data-slot="splash-wordmark" class="w-40">
            <Wordmark fade={false} muted={false} class="mx-auto block h-auto w-full text-[#cf9f52]" />
          </div>
        </div>
      }
    >
      <div
        data-component="first-launch-splash"
        data-drawing={drawingState()}
        aria-hidden="true"
        class="h-dvh w-screen bg-v2-background-bg-base overflow-hidden"
        style={{
          // Match the default session's titlebar, panel insets, and wordmark position.
          "padding-block-start": `calc(${titlebarHeight()} + ${props.platform.os === "windows" ? 1 : 8}px)`,
          "padding-block-end": "8px",
          "padding-inline": "32px",
        }}
        onAnimationEnd={(event) => {
          if (
            event.animationName === "first-launch-wordmark-draw" ||
            event.animationName === "splash-constellation-complete"
          )
            complete()
        }}
      >
        <div class="relative size-full flex flex-col items-center justify-center gap-4">
          <BifrostConstellation />
          <div class="w-full max-w-[540px]">
            <Wordmark outline fade={false} muted={false} class="mx-auto block h-auto w-4/5 text-[#cf9f52] opacity-80" />
          </div>
        </div>
      </div>
    </Show>
  )
}
