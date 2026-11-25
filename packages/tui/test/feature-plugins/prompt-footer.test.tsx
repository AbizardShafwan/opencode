/** @jsxImportSource @opentui/solid */
import { expect, setSystemTime, test } from "bun:test"
import { RGBA, TextRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { PromptFooter } from "../../src/feature-plugins/prompt/footer"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("prompt footer separates simultaneous subagent, shell, and usage status", async () => {
  const color = RGBA.fromInts(200, 200, 200)
  const subdued = RGBA.fromInts(100, 100, 100)
  const dispatched: string[] = []
  const context = {
    location: { directory: "/workspace" },
    theme: {
      text: {
        base: color,
        muted: subdued,
      },
    },
    keymap: {
      shortcuts: (id: string) =>
        id === "session.child.first" ? ["ctrl+j"] : id === "command.palette.show" ? ["ctrl+p"] : [],
      dispatch: (id: string) => dispatched.push(id),
    },
    client: {
      rpc: () => ({ get: () => Promise.resolve(null), events: { on: () => () => {} } }),
      job: { list: () => Promise.resolve({ location: { directory: "/workspace" }, data: { data: [] } }) },
    },
    data: {
      on: () => () => {},
      session: {
        family: () => ["session", "child"],
        status: (id: string) => (id === "child" ? "running" : "idle"),
        get: () => ({ id: "session", location: { directory: "/workspace" } }),
        cost: () => 1,
        message: { list: () => [] },
      },
      shell: {
        list: () => [{ metadata: { sessionID: "session" } }],
      },
      location: {
        config: { list: () => [] },
        model: { list: () => [] },
      },
    },
  } as unknown as Context
  const app = await testRender(
    () => <PromptFooter context={context} sessionID="session" mode="normal" showDetails={true} />,
    {
      width: 80,
      height: 2,
    },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("ctrl+j 1 subagent · 1 shell · $1.00")
    expect(app.captureCharFrame()).toContain("ctrl+p commands")

    await app.mockMouse.moveTo(2, 0)
    const live = app.renderer.root.getChildren()[0]?.getChildren()[0]?.getChildren()[0]
    expect(live).toBeInstanceOf(TextRenderable)
    expect((live as TextRenderable).fg.toInts()).toEqual(color.toInts())

    await app.mockMouse.click(2, 0)
    expect(dispatched).toEqual(["session.child.first"])
  } finally {
    app.renderer.destroy()
  }
})

test("prompt footer can hide details", async () => {
  const color = RGBA.fromInts(200, 200, 200)
  const context = {
    location: { directory: "/workspace" },
    theme: {
      text: {
        base: color,
        muted: color,
      },
    },
    keymap: {
      shortcuts: (id: string) => {
        if (id === "command.palette.show") return ["ctrl+p"]
        if (id === "agent.cycle") return ["shift+tab"]
        return []
      },
    },
    client: {
      rpc: () => ({ get: () => Promise.resolve(null), events: { on: () => () => {} } }),
      job: { list: () => Promise.resolve({ location: { directory: "/workspace" }, data: { data: [] } }) },
    },
    data: {
      on: () => () => {},
      session: {
        family: () => ["session"],
        status: () => "running",
        get: () => ({ id: "session", location: { directory: "/workspace" } }),
        cost: () => 1,
        message: {
          list: () => [
            {
              id: "message",
              type: "assistant",
              model: { providerID: "provider", id: "model" },
              tokens: { input: 1_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          ],
        },
      },
      shell: { list: () => [] },
      location: {
        config: { list: () => [] },
        model: { list: () => [{ providerID: "provider", id: "model", limit: { context: 10_000 } }] },
      },
    },
  } as unknown as Context
  const [showDetails, setShowDetails] = createSignal(true)
  const [sessionID, setSessionID] = createSignal<string | undefined>("session")
  const app = await testRender(
    () => (
      <box width="100%" flexDirection="row" justifyContent="space-between" gap={2}>
        <PromptFooter context={context} sessionID={sessionID()} mode="normal" showDetails={showDetails()} />
      </box>
    ),
    {
      width: 80,
      height: 1,
    },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("1.0K (10%) · $1.00")
    expect(app.captureCharFrame()).toContain("ctrl+p commands")

    setShowDetails(false)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("1.0K (10%)")
    expect(frame).not.toContain("$1.00")
    expect(frame).not.toContain("ctrl+p commands")

    setSessionID(undefined)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("shift+tab agents")
  } finally {
    app.renderer.destroy()
  }
})

test("prompt footer shows the session's goal without its objective and opens it on click", async () => {
  const muted = RGBA.fromInts(100, 100, 100)
  const warning = RGBA.fromInts(200, 200, 0)
  const goal = {
    id: "goal",
    objective: "Make the test suite pass",
    status: "active",
    rounds: 3,
    maxRounds: 50,
    boot: "boot",
    updatedAt: 0,
  }
  const fetched = Promise.resolve(goal)
  const changed: ((event: { data: { sessionID: string; goal: unknown } }) => void)[] = []
  const dialogs: unknown[] = []
  const context = {
    location: { directory: "/workspace" },
    theme: {
      text: {
        base: RGBA.fromInts(200, 200, 200),
        muted,
        feedback: { warning: { base: warning }, success: { base: muted } },
      },
    },
    keymap: { shortcuts: () => [] },
    ui: { dialog: { show: (render: unknown) => dialogs.push(render) }, toast: { show: () => {} } },
    client: {
      rpc: () => ({
        get: () => fetched,
        events: { on: (_name: string, handler: (typeof changed)[number]) => (changed.push(handler), () => {}) },
      }),
      job: { list: () => Promise.resolve({ location: { directory: "/workspace" }, data: { data: [] } }) },
    },
    data: {
      on: () => () => {},
      session: {
        family: () => ["session"],
        status: () => "idle",
        get: () => ({ id: "session", location: { directory: "/workspace" } }),
        cost: () => 0,
        message: { list: () => [] },
      },
      shell: { list: () => [] },
      location: { config: { list: () => [] }, model: { list: () => [] } },
    },
  } as unknown as Context
  const app = await testRender(
    () => <PromptFooter context={context} sessionID="session" mode="normal" showDetails={true} />,
    { width: 80, height: 2 },
  )

  try {
    // The footer fetches the goal from the goal plugin's RPC.
    await fetched
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("◎ goal")
    // The objective and any round count live in the dialog, not the footer.
    expect(frame).not.toContain("Make the test suite pass")
    expect(frame).not.toMatch(/\d+\/\d+/)
    expect(findText(app.renderer.root, "◎ goal")?.fg.toInts()).toEqual(muted.toInts())

    await app.mockMouse.click(2, 0)
    expect(dialogs).toHaveLength(1)
    await app.mockMouse.moveTo(70, 1)

    // Then it follows the plugin's changes for this Session only.
    const change = (sessionID: string, next: unknown) =>
      changed.forEach((handler) => handler({ data: { sessionID, goal: next } }))
    change("session", { ...goal, status: "paused", reason: "Stopped by the user" })
    change("other", null)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("◎ goal paused")
    expect(findText(app.renderer.root, "◎ goal paused")?.fg.toInts()).toEqual(warning.toInts())

    change("session", null)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("goal")
  } finally {
    app.renderer.destroy()
  }
})

test.each([100, 44])("prompt footer shows external wait badge beside goal status and opens detail dialog at width %s", async (width) => {
  setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
  await using temporary = await tmpdir()
  const base = RGBA.fromInts(220, 220, 220)
  const muted = RGBA.fromInts(120, 120, 120)
  const warning = RGBA.fromInts(220, 180, 0)
  const fetchedGoal = Promise.resolve({
    id: "goal",
    objective: "Finish release",
    status: "active",
    rounds: 1,
    maxRounds: 10,
    boot: "boot",
    updatedAt: 0,
  })
  const fetchedWaits = Promise.resolve({
    location: { directory: "/workspace" },
    data: {
      data: [
        {
          kind: "external",
          id: "job-1",
          sessionID: "session",
          status: "running",
          time: { started: 1 },
          waitID: "wait-1",
          source: "github.pr_watch",
          server: "github",
          description: "Waiting for CI checks on PR #42",
          expiresAt: Date.now() + 45_000,
        },
        {
          kind: "external",
          id: "job-2",
          sessionID: "session",
          status: "running",
          time: { started: 2 },
          waitID: "wait-2",
          source: "cron.wait",
          server: "scheduler",
          description: "Waiting for nightly batch",
          expiresAt: Date.now() - 1_000,
        },
        {
          kind: "external",
          id: "job-3",
          sessionID: "session",
          status: "completed",
          time: { started: 3, completed: 4 },
          waitID: "wait-3",
          source: "github.pr_watch",
          server: "github",
          description: "Completed wait",
          expiresAt: Date.now() + 60_000,
        },
      ],
    },
  })

  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <ToastProvider>
                <DialogProvider>
                  {(() => {
                    const dialog = useDialog()
                    const context = {
                      location: { directory: "/workspace" },
                      theme: {
                        text: {
                          base,
                          muted,
                          feedback: { warning },
                        },
                      },
                      keymap: { shortcuts: () => [] },
                      ui: { dialog: { show: (render: () => unknown) => dialog.replace(render as never) }, toast: { show: () => {} } },
                      client: {
                        rpc: () => ({ get: () => fetchedGoal, events: { on: () => () => {} } }),
                        job: { list: () => fetchedWaits },
                      },
                      data: {
                        on: () => () => {},
                        session: {
                          family: () => ["session"],
                          status: () => "idle",
                          get: () => ({ id: "session", location: { directory: "/workspace" } }),
                          cost: () => 0,
                          message: { list: () => [] },
                        },
                        shell: { list: () => [] },
                        location: { config: { list: () => [] }, model: { list: () => [] } },
                      },
                    } as unknown as Context
                    return <PromptFooter context={context} sessionID="session" mode="normal" showDetails={true} />
                  })()}
                </DialogProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 24, kittyKeyboard: true },
  )

  try {
    await Promise.all([fetchedGoal, fetchedWaits])
    await app.renderOnce()

    const footerFrame = app.captureCharFrame()
    expect(footerFrame).toContain("◎ goal")
    expect(footerFrame).toContain("◷ 2 waits")
    expect(footerFrame).not.toContain("Waiting for CI checks")

    const badge = findText(app.renderer.root, "◷ 2 waits")
    expect(badge).toBeDefined()
    expect(badge?.fg.toInts()).toEqual(muted.toInts())

    await app.mockMouse.moveTo(badge!.x, badge!.y)
    await app.renderOnce()
    expect(findText(app.renderer.root, "◷ 2 waits")?.fg.toInts()).toEqual(base.toInts())

    await app.mockMouse.click(badge!.x, badge!.y)
    await app.renderOnce()

    const normalizedDialog = app.captureCharFrame().replace(/\s+/g, " ")
    expect(normalizedDialog).toContain("External waits")
    expect(normalizedDialog).toContain("Waiting for CI checks on PR #42")
    expect(normalizedDialog).toContain("github.pr_watch · github · expires in 45.0s")
    expect(normalizedDialog).toContain("Waiting for nightly batch")
    expect(normalizedDialog).toContain("cron.wait · scheduler · expired")
    expect(normalizedDialog).not.toContain("Completed wait")
  } finally {
    setSystemTime()
    app.renderer.destroy()
  }
})

test("prompt footer external waits react to events, reconnect, and ignore stale responses", async () => {
  const base = RGBA.fromInts(220, 220, 220)
  const muted = RGBA.fromInts(120, 120, 120)
  const [sessionID, setSessionID] = createSignal<string | undefined>("session-a")
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const emit = (name: string, data: unknown) =>
    listeners.get(name)?.forEach((handler) => handler({ type: name, data }))
  const pending: {
    sessionID: string
    directory?: string
    resolve: (items: unknown[]) => void
  }[] = []

  const waitItem = (id: string, targetSessionID: string, status = "running") => ({
    kind: "external",
    id,
    sessionID: targetSessionID,
    status,
    time: { started: 1 },
    waitID: `wait-${id}`,
    source: "github.pr_watch",
    server: "github",
    description: `Wait ${id}`,
    expiresAt: Date.now() + 60_000,
  })

  const context = {
    location: { directory: "/workspace" },
    theme: { text: { base, muted } },
    keymap: { shortcuts: () => [] },
    ui: { dialog: { show: () => {} }, toast: { show: () => {} } },
    client: {
      rpc: () => ({ get: () => Promise.resolve(null), events: { on: () => () => {} } }),
      job: {
        list: (input: { sessionID: string; location?: { directory: string } }) =>
          new Promise((resolve) => {
            pending.push({
              sessionID: input.sessionID,
              directory: input.location?.directory,
              resolve: (items) =>
                resolve({
                  location: { directory: input.location?.directory ?? "/workspace" },
                  data: { data: items },
                }),
            })
          }),
      },
    },
    data: {
      on: (name: string, handler: (event: unknown) => void) => {
        const set = listeners.get(name) ?? new Set()
        set.add(handler)
        listeners.set(name, set)
        return () => set.delete(handler)
      },
      session: {
        family: () => [sessionID() ?? ""],
        status: () => "idle",
        get: (id: string) => ({ id, location: { directory: id === "session-b" ? "/dir-b" : "/dir-a" } }),
        cost: () => 0,
        message: { list: () => [] },
      },
      shell: { list: () => [] },
      location: { config: { list: () => [] }, model: { list: () => [] } },
    },
  } as unknown as Context

  const app = await testRender(
    () => <PromptFooter context={context} sessionID={sessionID()} mode="normal" showDetails={true} />,
    { width: 80, height: 2 },
  )

  try {
    expect(pending).toHaveLength(1)
    expect(pending[0]?.directory).toBe("/dir-a")

    pending[0]?.resolve([waitItem("1", "session-a"), waitItem("done", "session-a", "completed")])
    await Promise.resolve()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("◷ 1 wait")

    // Events for unrelated sessions do not refetch.
    emit("session.external_wait.changed", { sessionID: "other" })
    expect(pending).toHaveLength(1)

    // MCP status transitions refresh active waits (hiding on detach and restoring on re-attach).
    emit("mcp.status.changed", { name: "github", status: { status: "disabled" } })
    expect(pending).toHaveLength(2)
    pending[1]?.resolve([])
    await Promise.resolve()
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("wait")

    emit("mcp.status.changed", { name: "github", status: { status: "connected" } })
    expect(pending).toHaveLength(3)
    pending[2]?.resolve([waitItem("2", "session-a")])
    await Promise.resolve()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("◷ 1 wait")

    // Reconnect and moved/delete events keep active waits accurate.
    emit("session.moved", { sessionID: "session-a", location: { directory: "/dir-moved" }, projectID: "proj" })
    expect(pending).toHaveLength(4)
    expect(pending[3]?.directory).toBe("/dir-moved")
    pending[3]?.resolve([waitItem("2", "session-a")])
    await Promise.resolve()

    emit("session.deleted", { sessionID: "session-a" })
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("wait")

    // Archive clears active waits immediately too.
    emit("server.connected", {})
    expect(pending).toHaveLength(5)
    pending[4]?.resolve([waitItem("3", "session-a"), waitItem("4", "session-a")])
    await Promise.resolve()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("◷ 2 waits")

    emit("session.archived", { sessionID: "session-a" })
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("wait")

    // Switching sessions discards an in-flight response for the previous session.
    emit("session.external_wait.changed", { sessionID: "session-a" })
    expect(pending).toHaveLength(6)
    setSessionID("session-b")
    await app.renderOnce()
    expect(pending).toHaveLength(7)
    expect(pending[6]?.directory).toBe("/dir-b")

    pending[6]?.resolve([waitItem("5", "session-b")])
    await Promise.resolve()
    pending[5]?.resolve([waitItem("stale-1", "session-a"), waitItem("stale-2", "session-a")])
    await Promise.resolve()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("◷ 1 wait")
  } finally {
    app.renderer.destroy()
  }

  expect([...listeners.values()].every((set) => set.size === 0)).toBeTrue()
})

function findText(node: Renderable, text: string): TextRenderable | undefined {
  if (node instanceof TextRenderable && node.plainText.includes(text)) return node
  return node
    .getChildren()
    .map((child) => findText(child, text))
    .find((found) => found !== undefined)
}
