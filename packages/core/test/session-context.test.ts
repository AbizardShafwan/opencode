import { expect, test } from "bun:test"
import { grantsBrowser } from "@opencode/core/session/context"

test("only a blanket browser allow is an explicit session opt-in", () => {
  expect(grantsBrowser([{ action: "browser", resource: "*", effect: "allow" }])).toBe(true)
  // A narrower resource rule cannot widen discovery, which evaluates the wildcard resource.
  expect(grantsBrowser([{ action: "browser", resource: "https://example.com", effect: "allow" }])).toBe(false)
  expect(grantsBrowser([{ action: "browser", resource: "*", effect: "deny" }])).toBe(false)
  // A wildcard full-access rule is not a browser grant either.
  expect(grantsBrowser([{ action: "*", resource: "*", effect: "allow" }])).toBe(false)
})
