import { expect, test } from "bun:test"
import { DialogContextLimit } from "../../src/component/dialog-context-limit"
import { model, renderLocal, session } from "../fixture/local"
import { json } from "../fixture/tui-client"

test.each([false, true])("context limit dialog opens without an override (session: %s)", async (inSession) => {
  const selected = { providerID: "provider", id: "first" }
  const current = session("ses_limit", selected)
  const saved = Promise.withResolvers<unknown>()
  await using setup = await renderLocal({
    models: [{ ...model("first"), limit: { context: 1_000_000, output: 32_000 } }],
    sessions: [current],
    width: 100,
    height: 30,
    fetch: async (url, request) => {
      if (url.pathname === "/api/config" && request.method === "GET")
        return json([{ type: "document", info: { compaction: { default_soft_limit: 250_000 } } }])
      if (request.method === "PATCH") {
        saved.resolve(await request.json())
        return new Response(null, { status: 204 })
      }
    },
  })
  if (inSession) await setup.data.session.sync(current.id)
  DialogContextLimit.show(setup.dialog, inSession ? current.id : undefined)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Context soft limit")
  expect(setup.captureCharFrame()).toContain("Max (1M)")
  setup.mockInput.pressKey("home")
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  expect(await saved.promise).toEqual(
    inSession
      ? { metadata: { softLimit: 1_000_000 } }
      : { softLimit: { modelKey: "provider/first", limit: 1_000_000 } },
  )
})
