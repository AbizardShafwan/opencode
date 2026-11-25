import { Global } from "@opencode/util/global"
import { Config } from "effect"

// Every environment variable the CLI reads, in one place. Consumers yield
// these instead of touching process.env so the full surface stays visible,
// typed, and redacted where secret.

// The opencode server password: sent by clients connecting to an explicit
// --server, and adopted by a manually run or standalone server. The legacy
// name is still honored.
export const password = Config.Redacted(`${Global.envPrefix}_PASSWORD`).pipe(
  Config.orElse(() => Config.Redacted(`${Global.envPrefix}_SERVER_PASSWORD`)),
  Config.orElse(() => Config.Redacted("OPENCODE_PASSWORD")),
  Config.orElse(() => Config.Redacted("OPENCODE_SERVER_PASSWORD")),
  Config.withDefault(undefined),
)

// Bootstrap secret the trusted host (T3 Code) presents on client MCP connections. Only the server
// reads it; it is stripped from the environment that sessions and tools inherit.
export const trustedHostToken = Config.Redacted(`${Global.envPrefix}_TRUSTED_HOST_TOKEN`).pipe(
  Config.orElse(() => Config.Redacted("OPENCODE_TRUSTED_HOST_TOKEN")),
  Config.withDefault(undefined),
)

// Legacy opt-in for host builds that predate the bootstrap token: comma-separated client MCP name
// prefixes (only "t3-code" is recognized) trusted as the host. Off unless set at server bootstrap.
export const trustMcpPrefix = Config.String(`${Global.envPrefix}_TRUST_MCP_PREFIX`).pipe(
  Config.orElse(() => Config.String("OPENCODE_TRUST_MCP_PREFIX")),
  Config.map((value) =>
    value
      .split(",")
      .map((prefix) => prefix.trim())
      .filter((prefix) => prefix !== ""),
  ),
  Config.withDefault(undefined),
)

const SERVER_ONLY = new Set([
  "OPENCODE_PASSWORD",
  "OPENCODE_SERVER_PASSWORD",
  "MEMYR_PASSWORD",
  "MEMYR_SERVER_PASSWORD",
  "OPENCODE_TRUSTED_HOST_TOKEN",
  "MEMYR_TRUSTED_HOST_TOKEN",
  "OPENCODE_TRUST_MCP_PREFIX",
  "MEMYR_TRUST_MCP_PREFIX",
])

function isServerOnly(name: string, platform: NodeJS.Platform) {
  return SERVER_ONLY.has(platform === "win32" ? name.toUpperCase() : name)
}

export function session(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !isServerOnly(entry[0], platform),
    ),
  )
}

export * as Env from "./env"
