import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Provider } from "../src/provider.js"
import { Usage } from "../src/usage.js"

test("a snapshot encodes only the fields its source owns", () => {
  expect(
    Schema.encodeSync(Usage.Info)({
      providerID: Provider.ID.make("openai"),
      source: "codex-rate-limit",
      fetchedAt: 1_700_000_000_000,
      windows: [{ id: "5h", label: "5h", remainingPercent: 88 }],
    }),
  ).toEqual({
    providerID: "openai",
    source: "codex-rate-limit",
    fetchedAt: 1_700_000_000_000,
    windows: [{ id: "5h", label: "5h", remainingPercent: 88 }],
  })
})

test("a window percentage stays within the share it describes", () => {
  const decode = Schema.decodeUnknownSync(Usage.Window)

  expect(decode({ id: "weekly", label: "weekly", remainingPercent: 0 })).toEqual({
    id: "weekly",
    label: "weekly",
    remainingPercent: 0,
  })
  expect(() => decode({ id: "weekly", label: "weekly", remainingPercent: 100.5 })).toThrow()
})

test("a read result may carry nothing for a provider without usage", () => {
  expect(Schema.decodeUnknownSync(Usage.Result)(undefined)).toBeUndefined()
})
