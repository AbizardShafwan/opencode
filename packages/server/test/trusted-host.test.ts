import { describe, expect, test } from "bun:test"
import { hostPolicy } from "../src/trusted-host"

const trusted = { trustedHost: true, permissionNamespace: "t3-code", codemode: false }

describe("hostPolicy", () => {
  test("trusts only a matching bootstrap token", () => {
    const options = { trustedHost: { token: "host-secret" } }
    expect(hostPolicy({ token: "host-secret", name: "anything" }, options)).toEqual(trusted)
    expect(hostPolicy({ token: "host-secre", name: "t3-code" }, options)).toBeUndefined()
    expect(hostPolicy({ token: undefined, name: "t3-code" }, options)).toBeUndefined()
  })

  test("never trusts host names without the legacy opt-in", () => {
    expect(hostPolicy({ token: undefined, name: "t3-code" }, undefined)).toBeUndefined()
    expect(hostPolicy({ token: "x", name: "t3-code-1234" }, { trustedHost: {} })).toBeUndefined()
    expect(hostPolicy({ token: undefined, name: "t3-code" }, { trustedHost: { mcpPrefixes: ["other"] } })).toBeUndefined()
  })

  test("trusts host names when the legacy prefix is opted in", () => {
    const options = { trustedHost: { mcpPrefixes: ["t3-code"], executionTimeoutMs: 5_000 } }
    expect(hostPolicy({ token: undefined, name: "t3-code" }, options)).toEqual({ ...trusted, executionTimeoutMs: 5_000 })
    expect(hostPolicy({ token: undefined, name: "t3-code-1234" }, options)).toBeDefined()
    expect(hostPolicy({ token: undefined, name: "t3-codex" }, options)).toBeUndefined()
    expect(hostPolicy({ token: undefined, name: "t3-code_x" }, options)).toBeUndefined()
  })
})
