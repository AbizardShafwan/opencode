import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { AnthropicPlugin, authorizationCode } from "@opencode/core/plugin/provider/anthropic"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const integrationID = Integration.ID.make("anthropic")
const methodID = Integration.MethodID.make("claude-code")
const tokenURL = "https://platform.claude.com/v1/oauth/token"

type Call = { method: string; url: string; headers: Headers; body: string }

const tokens = {
  access_token: "sk-ant-oat-access",
  refresh_token: "sk-ant-oat-refresh",
  expires_in: 3600,
  account: { email_address: "claude@example.com", has_claude_pro: true },
  organization: { name: "claude@example.com's Organization" },
}

const mock = (responses: ReadonlyArray<unknown> = [tokens]) => {
  const calls: Call[] = []
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
      calls.push({
        method: web.method,
        url: web.url,
        headers: web.headers,
        body: yield* Effect.promise(() => web.text()),
      })
      const body = responses[Math.min(calls.length - 1, responses.length - 1)]
      return HttpClientResponse.fromWeb(request, Response.json(body))
    }),
  )
  return { http, calls }
}

const addPlugin = (http: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    const host = yield* PluginHost.make(plugin, AnthropicPlugin.id)
    yield* AnthropicPlugin.effect(host).pipe(Effect.provideService(HttpClient.HttpClient, http))
  })

function until<A, E>(
  effect: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  deadline = Date.now() + 5_000,
): Effect.Effect<A, E | Error> {
  return Effect.gen(function* () {
    while (true) {
      const value = yield* effect
      if (predicate(value)) return value
      if (Date.now() > deadline) return yield* Effect.fail(new Error("Timed out waiting for OAuth completion"))
      yield* Effect.promise(() => Bun.sleep(1))
    }
  })
}

describe("Anthropic subscription authentication", () => {
  it.effect("registers a Claude Code OAuth method with both completion modes", () =>
    Effect.gen(function* () {
      const { http } = mock()
      yield* addPlugin(http)
      const integrations = yield* Integration.Service
      const method = required(yield* integrations.get(integrationID)).methods.find(
        (value) => value.type === "oauth" && value.id === methodID,
      )

      expect(method).toMatchObject({
        id: methodID,
        type: "oauth",
        label: "Claude Code subscription (Pro/Max)",
      })
      expect(method?.type === "oauth" ? method.form : undefined).toMatchObject([
        {
          key: "mode",
          default: "browser",
          options: [{ value: "browser" }, { value: "code" }],
        },
      ])
    }),
  )

  it.effect("completes a pasted redirect and stores the subscription credential", () =>
    Effect.gen(function* () {
      const { http, calls } = mock()
      yield* addPlugin(http)
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const attempt = yield* integrations.oauth.connect({
        integrationID,
        methodID,
        answer: { mode: "code" },
      })

      expect(attempt.mode).toBe("code")
      const authorization = new URL(attempt.url)
      expect(authorization.origin).toBe("https://claude.ai")
      expect(authorization.pathname).toBe("/oauth/authorize")
      expect(authorization.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e")
      expect(authorization.searchParams.get("redirect_uri")).toBe("http://localhost:53692/callback")
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256")
      expect(authorization.searchParams.get("scope")).toContain("user:inference")

      const state = required(authorization.searchParams.get("state"))
      yield* integrations.oauth.complete({
        integrationID,
        attemptID: attempt.attemptID,
        code: `http://localhost:53692/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      })

      const stored = required((yield* credentials.list(integrationID)).find((entry) => entry.value.type === "oauth"))
      expect(stored.value).toMatchObject({
        type: "oauth",
        methodID,
        access: "sk-ant-oat-access",
        refresh: "sk-ant-oat-refresh",
        metadata: {
          account_email: "claude@example.com",
          account_detail: "Claude Pro",
        },
      })

      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toBe(tokenURL)
      expect(calls[0]!.headers.get("content-type")).toContain("application/json")
      expect(calls[0]!.headers.get("user-agent")).toBe("claude-cli/2.1.75")
      const body = JSON.parse(calls[0]!.body)
      expect(body).toMatchObject({
        grant_type: "authorization_code",
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        code: "auth-code",
        redirect_uri: "http://localhost:53692/callback",
        state,
      })
      expect(body.code_verifier).toBeString()
    }),
  )

  it.effect("surfaces a rejected authorization code", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "invalid_grant", error_description: "authorization code expired" }, { status: 400 }),
          ),
        ),
      )
      yield* addPlugin(http)
      const integrations = yield* Integration.Service
      const attempt = yield* integrations.oauth.connect({
        integrationID,
        methodID,
        answer: { mode: "code" },
      })
      const state = required(new URL(attempt.url).searchParams.get("state"))
      const error = yield* integrations.oauth
        .complete({
          integrationID,
          attemptID: attempt.attemptID,
          code: `http://localhost:53692/callback?code=expired&state=${encodeURIComponent(state)}`,
        })
        .pipe(Effect.flip)

      expect(error.message).toContain("authorization code expired")
    }),
  )

  it.effect("captures the browser callback on the registered loopback port", () =>
    Effect.gen(function* () {
      const { http } = mock()
      yield* addPlugin(http)
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const attempt = yield* integrations.oauth.connect({ integrationID, methodID, answer: { mode: "browser" } })

      expect(attempt.mode).toBe("auto")
      const state = required(new URL(attempt.url).searchParams.get("state"))
      const response = yield* Effect.promise(() =>
        fetch(`http://localhost:53692/callback?code=browser-code&state=${encodeURIComponent(state)}`),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toContain("Authorization successful")

      const status = yield* until(
        integrations.oauth.status({ integrationID, attemptID: attempt.attemptID }),
        (value) => value.status !== "pending",
      )
      expect(status.status).toBe("complete")
      expect(
        (yield* credentials.list(integrationID)).some(
          (entry) => entry.value.type === "oauth" && entry.value.access === "sk-ant-oat-access",
        ),
      ).toBe(true)
    }),
  )

  it.effect("refreshes once for concurrent callers and preserves account metadata", () =>
    Effect.gen(function* () {
      const refreshToken = `sk-ant-oat-refresh-${crypto.randomUUID()}`
      const refreshed = { ...tokens, access_token: "sk-ant-oat-rotated", refresh_token: "sk-ant-oat-next" }
      const { http, calls } = mock([refreshed])
      yield* addPlugin(http)
      const credentials = yield* Credential.Service
      const integrations = yield* Integration.Service
      yield* credentials.create({
        integrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "sk-ant-oat-expired",
          refresh: refreshToken,
          expires: 1,
          metadata: { account_email: "claude@example.com", account_detail: "Claude Pro" },
        }),
      })

      const connection = required(yield* integrations.connection.active(integrationID))
      const [first, second] = yield* Effect.all(
        [integrations.connection.resolve(connection), integrations.connection.resolve(connection)],
        { concurrency: "unbounded" },
      )

      expect(first).toMatchObject({ access: "sk-ant-oat-rotated", refresh: "sk-ant-oat-next" })
      expect(second).toMatchObject({ access: "sk-ant-oat-rotated", refresh: "sk-ant-oat-next" })
      expect(first?.type === "oauth" ? first.metadata : undefined).toMatchObject({
        account_email: "claude@example.com",
        account_detail: "Claude Pro",
      })
      expect(calls).toHaveLength(1)
      expect(JSON.parse(calls[0]!.body)).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      })
    }),
  )

  test("requires the complete redirect URL and matching state for pasted authorization", () => {
    expect(() => authorizationCode("bare-code", "state")).toThrow(/full redirect URL/)
    expect(() => authorizationCode("http://localhost:53692/callback?code=auth-code&state=other", "state")).toThrow(
      /state mismatch/,
    )
    expect(() => authorizationCode("http://localhost:53692/callback?code=auth-code", "state")).toThrow(/no state/)
    expect(authorizationCode("http://localhost:53692/callback?code=auth-code&state=state", "state")).toBe("auth-code")
    expect(authorizationCode("code=auth-code&state=state", "state")).toBe("auth-code")
    expect(authorizationCode("?code=auth-code&state=state", "state")).toBe("auth-code")
    expect(authorizationCode("auth-code#state", "state")).toBe("auth-code")
    expect(() => authorizationCode("code=auth-code&state=state&error=access_denied", "state")).toThrow(/access_denied/)
  })
})

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Expected value")
  return value
}
