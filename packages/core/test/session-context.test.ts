import { expect, test } from "bun:test"
import { Permission } from "@opencode/core/permission"
import { grantsBrowser } from "@opencode/core/session/context"

test("only a blanket browser allow is an explicit session opt-in", () => {
  expect(grantsBrowser([{ action: "browser", resource: "*", effect: "allow" }])).toBe(true)
  // A narrower resource rule cannot widen discovery, which evaluates the wildcard resource.
  expect(grantsBrowser([{ action: "browser", resource: "https://example.com", effect: "allow" }])).toBe(false)
  expect(grantsBrowser([{ action: "browser", resource: "*", effect: "deny" }])).toBe(false)
  // A wildcard full-access rule is not a browser grant either.
  expect(grantsBrowser([{ action: "*", resource: "*", effect: "allow" }])).toBe(false)
})

test("withHostCeiling derives host-only ceiling only when an agent restricts t3-code actions", () => {
  const existingAuthority: Permission.Ruleset[] = [[{ action: "edit", resource: "*", effect: "deny" }]]
  expect(Permission.withHostCeiling([{ action: "question", resource: "*", effect: "allow" }], existingAuthority)).toEqual(
    existingAuthority,
  )

  const planRules: Permission.Ruleset = [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "t3-code_pull_request_read", resource: "*", effect: "allow" },
    { action: "t3-code-*_pull_request_read", resource: "*", effect: "allow" },
  ]
  const derived = Permission.withHostCeiling(planRules, existingAuthority)
  expect(derived).toHaveLength(2)
  const ceiling = derived[1]
  expect(Permission.evaluate("edit", "/plan.md", ceiling).effect).toBe("allow")
  expect(Permission.evaluate("t3-code-threadA_pull_request_read", "*", ceiling).effect).toBe("allow")
  expect(Permission.evaluate("t3-code-threadA_pull_request_merge", "*", ceiling).effect).toBe("deny")
})
