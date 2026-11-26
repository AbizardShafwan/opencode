import type { Mcp } from "@opencode/core/mcp/index"
import { Context } from "effect"
import { createHash, timingSafeEqual } from "node:crypto"

export type TrustedHostOptions = {
  readonly trustedHost?: {
    /** Bootstrap secret the host presents to prove its identity; never derived from client input. */
    readonly token?: string
    /** Legacy opt-in: client MCP names trusted by prefix for host builds that predate the token. */
    readonly mcpPrefixes?: ReadonlyArray<string>
    readonly executionTimeoutMs?: number
  }
}

export const TrustedHostConfig = Context.Reference<TrustedHostOptions | undefined>("@opencode/ServerTrustedHostConfig", {
  defaultValue: () => undefined,
})

const HOST_NAMESPACE = "t3-code"

/** The host policy a client MCP attachment receives, or undefined when its host identity is not proven. */
export function hostPolicy(
  input: { readonly token: string | undefined; readonly name: string },
  options: TrustedHostOptions | undefined,
): Mcp.HostPolicy | undefined {
  const config = options?.trustedHost
  if (!config) return undefined
  if (!verified(input.token, config.token) && !legacyPrefix(input.name, config.mcpPrefixes)) return undefined
  return {
    trustedHost: true,
    permissionNamespace: HOST_NAMESPACE,
    codemode: false,
    ...(config.executionTimeoutMs === undefined ? {} : { executionTimeoutMs: config.executionTimeoutMs }),
  }
}

/**
 * Host policy for runtime `mcp.add` registrations targeting a local loopback T3 Code MCP server.
 * Preserves `t3-code-<threadHash>_<tool>` permission names so T3 Code's per-thread deny/allow rules match,
 * while never trusting repo/user config files or non-loopback endpoints.
 */
export function runtimeMcpHostPolicy(
  input: { readonly name: string; readonly config: Parameters<Mcp.Interface["add"]>[1] },
  options: TrustedHostOptions | undefined,
): Mcp.HostPolicy | undefined {
  if (!isHostName(input.name)) return undefined
  if (input.config.type !== "remote" || !isLoopbackUrl(input.config.url)) return undefined
  const executionTimeoutMs = options?.trustedHost?.executionTimeoutMs
  return {
    trustedHost: true,
    permissionNamespace: HOST_NAMESPACE,
    preserveServerPermission: true,
    codemode: false,
    ...(executionTimeoutMs === undefined ? {} : { executionTimeoutMs }),
  }
}

// Digests have equal length, so the comparison stays constant-time regardless of the presented length.
function verified(presented: string | undefined, expected: string | undefined) {
  if (!presented || !expected) return false
  return timingSafeEqual(digest(presented), digest(expected))
}

function digest(value: string) {
  return createHash("sha256").update(value).digest()
}

function legacyPrefix(name: string, prefixes: ReadonlyArray<string> | undefined) {
  if (!prefixes?.includes(HOST_NAMESPACE)) return false
  return isHostName(name)
}

function isHostName(name: string) {
  return name === HOST_NAMESPACE || name.startsWith(`${HOST_NAMESPACE}-`)
}

function isLoopbackUrl(raw: string) {
  if (!URL.canParse(raw)) return false
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  const host = url.hostname.toLowerCase()
  return host === "localhost" || host === "[::1]" || /^127(\.\d+){3}$/.test(host)
}
