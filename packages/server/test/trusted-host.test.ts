import { describe, expect, test } from "bun:test"
import { hostPolicy, runtimeMcpHostPolicy } from "../src/trusted-host"

const trusted = { trustedHost: true, permissionNamespace: "t3-code", codemode: false }
const runtimeTrusted = { ...trusted, preserveServerPermission: true }

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

describe("runtimeMcpHostPolicy", () => {
  test("grants zero-config host policy for loopback T3 Code HTTP servers", () => {
    for (const url of [
      "http://127.0.0.1:3773/mcp",
      "http://localhost:3773/mcp",
      "http://[::1]:3773/mcp",
      "https://127.0.0.2:8443/mcp",
    ]) {
      expect(
        runtimeMcpHostPolicy({ name: "t3-code-abc123", config: { type: "remote", url } }, undefined),
      ).toEqual(runtimeTrusted)
    }
    expect(
      runtimeMcpHostPolicy(
        { name: "t3-code", config: { type: "remote", url: "http://127.0.0.1:3773/mcp" } },
        { trustedHost: { executionTimeoutMs: 5_000 } },
      ),
    ).toEqual({ ...runtimeTrusted, executionTimeoutMs: 5_000 })
  })

  test("rejects non-loopback, non-http, stdio, or non-host runtime registrations", () => {
    expect(
      runtimeMcpHostPolicy({ name: "t3-code-abc", config: { type: "remote", url: "https://evil.example/mcp" } }, undefined),
    ).toBeUndefined()
    expect(
      runtimeMcpHostPolicy({ name: "t3-code-abc", config: { type: "remote", url: "http://192.168.1.5:3773/mcp" } }, undefined),
    ).toBeUndefined()
    expect(
      runtimeMcpHostPolicy({ name: "t3-code-abc", config: { type: "remote", url: "ws://127.0.0.1:3773/mcp" } }, undefined),
    ).toBeUndefined()
    expect(
      runtimeMcpHostPolicy({ name: "t3-code-abc", config: { type: "local", command: ["echo"] } }, undefined),
    ).toBeUndefined()
    expect(
      runtimeMcpHostPolicy({ name: "t3-codex", config: { type: "remote", url: "http://127.0.0.1:3773/mcp" } }, undefined),
    ).toBeUndefined()
    expect(
      runtimeMcpHostPolicy({ name: "other", config: { type: "remote", url: "http://127.0.0.1:3773/mcp" } }, undefined),
    ).toBeUndefined()
  })
})
