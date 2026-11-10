import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import {
  OpenCode,
  type ConfigEntry,
  type ModelInfo,
  type SessionInfo,
  type SessionMessageInfo,
} from "@opencode/client/promise"
import { createData } from "@opencode/client/solid"
import { ExtensionContext, useExtension, type Context, type MountedSession, type ServerRef } from "../sdk"
import SessionContextTab from "./tab"

function LimitFixture() {
  const base = useExtension()

  const [state, setState] = createStore<{ selected: number; hold: boolean; writes: string[]; mounted: boolean }>({
    selected: 0,
    hold: false,
    writes: [],
    mounted: true,
  })

  const [ready, setReady] = createSignal(false)
  const pending: (() => void)[] = []
  const location = { directory: "/context-fixture" }

  const models: ModelInfo[] = ["Alpha", "Beta"].map((name) => ({
    id: name,
    modelID: name,
    name,
    providerID: "fixture",
    status: "active",
    enabled: true,
    limit: { context: name === "Alpha" ? 1_000_000 : 128_000, output: 32_000 },
    cost: [],
    variants: [],
    capabilities: { input: ["text"], output: ["text"], tools: true },
    time: { released: 0 },
  }))

  const sessions: SessionInfo[] = models.map((model) => ({
    id: `ses_${model.id}`,
    title: model.name,
    model: { providerID: model.providerID, id: model.id },
    projectID: "fixture",
    location,
    cost: 0,
    tokens: { input: 300_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }))

  const configs: ConfigEntry[] = [
    {
      type: "document",
      info: { compaction: { default_soft_limit: 250_000, soft_limits: { "fixture/Alpha": 372_000 }, buffer: 8_000 } },
    },
  ]

  const client = OpenCode.make({
    baseUrl: "http://context-fixture.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)

      if (request.method === "PATCH") {
        const body = await request.text()
        setState("writes", (writes) => [...writes, `${url.pathname} ${body}`])

        if (state.hold && url.pathname.startsWith("/api/session/")) {
          await new Promise<void>((resolve) => pending.push(resolve))
        }

        return new Response(null, { status: 204 })
      }

      if (url.pathname === "/api/config") return Response.json(configs)

      if (url.pathname === "/api/provider")
        return Response.json({ location, data: [{ id: "fixture", name: "Fixture" }] })

      if (url.pathname === "/api/model") return Response.json({ location, data: models })

      if (url.pathname === "/api/usage") return Response.json({ data: null })
      const session = sessions.find((item) => url.pathname.startsWith(`/api/session/${item.id}`))

      if (session && url.pathname.endsWith("/message")) {
        const message: SessionMessageInfo = {
          id: `msg_${session.id}`,
          type: "assistant",
          agent: "build",
          model: session.model!,
          content: [],
          tokens: session.tokens,
          time: { created: 0 },
        }

        return Response.json({ data: [message], cursor: {} })
      }

      if (session) return Response.json({ data: session })
      throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`)
    },
  })

  const data = createData({
    api: () => client,
    directory: location.directory,
    event: { on: () => () => {}, listen: () => () => {} },
  })

  const server: ServerRef = {
    id: "fixture",
    name: "Fixture",
    url: "http://context-fixture.local",
    client,
    data,
    local: true,
    builtin: false,
    compatible: true,
    connected: true,
  }

  const mounted: MountedSession[] = sessions.map((session) => ({
    key: `${server.id}\n${session.id}`,
    id: session.id,
    tab: session.id,
    server,
    location,
    pending: false,
    visit: {},
    project: undefined,
    listedProject: undefined,
    directory: location.directory,
    local: true,
    background: [],
  }))

  const ctx: Context = Object.create(base, {
    layout: { value: { scroll: { get: () => undefined, set: () => {} }, state: () => "visible", toggle: () => {} } },
    system: { value: { save: async () => true } },
  })

  onMount(async () => {
    await Promise.all([
      data.location.provider.sync(location),
      data.location.model.sync(location),
      data.location.config.sync(location),
      ...sessions.flatMap((session) => [data.session.sync(session.id), data.session.message.sync(session.id)]),
    ])

    if (!base.signal.aborted) setReady(true)
  })
  onCleanup(() => pending.splice(0).forEach((release) => release()))

  return (
    <ExtensionContext.Provider value={ctx}>
      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap gap-3">
          <button onClick={() => setState("selected", (value) => 1 - value)}>Switch session</button>
          <button onClick={() => setState("hold", true)}>Hold updates</button>
          <button onClick={() => pending.splice(0).forEach((release) => release())}>Release updates</button>
          <button onClick={() => setState("mounted", false)}>Unmount panel</button>
        </div>
        <pre aria-label="Writes">{state.writes.join("\n")}</pre>
        <Show when={ready() && state.mounted}>
          <div class="h-[900px] max-w-2xl">
            <SessionContextTab session={mounted[state.selected]!} />
          </div>
        </Show>
      </div>
    </ExtensionContext.Provider>
  )
}

export default { title: "Extensions/Context/Limits", id: "extensions-context-limits" }

export const Inherited = { render: () => <LimitFixture /> }
