import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { Clock, Deferred, Effect, Exit, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { Server, ServerResponse } from "node:http"
import { Credential } from "../../credential.js"
import { Form } from "../../form.js"
import { Integration } from "../../integration.js"
import { OauthCallbackPage } from "../../oauth/page.js"

const integrationID = Integration.ID.make("anthropic")
const methodID = Integration.MethodID.make("claude-code")

const clientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const authorizeURL = "https://claude.ai/oauth/authorize"
const tokenURL = "https://platform.claude.com/v1/oauth/token"
const callbackHost = "localhost"
const callbackPort = 53692
const redirectURI = `http://${callbackHost}:${callbackPort}/callback`
const scopes = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
].join(" ")
const claudeCodeVersion = "2.1.75"

const Account = Schema.Struct({
  uuid: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  email_address: Schema.optional(Schema.String),
  has_claude_max: Schema.optional(Schema.Boolean),
  has_claude_pro: Schema.optional(Schema.Boolean),
})

const Organization = Schema.Struct({
  uuid: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
})

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  account: Schema.optional(Account),
  organization: Schema.optional(Organization),
})

const TokenRequest = Schema.Struct({
  grant_type: Schema.String,
  client_id: Schema.String,
  code: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  redirect_uri: Schema.optional(Schema.String),
  code_verifier: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
})

const TokenError = Schema.Struct({
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
})

const refreshRetention = 30_000
const refreshing = new Map<string, { attempt: Deferred.Deferred<Credential.OAuth, Error>; until: number }>()

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

function profileMetadata(tokens: typeof TokenResponse.Type) {
  const email = tokens.account?.email ?? tokens.account?.email_address
  const plan = tokens.account?.has_claude_max ? "Claude Max" : tokens.account?.has_claude_pro ? "Claude Pro" : undefined
  const organization = tokens.organization?.name
  // Personal accounts get an auto-generated organization name that only repeats the email.
  const detail = plan ?? (organization && (!email || !organization.startsWith(email)) ? organization : undefined)
  return Object.fromEntries(
    [
      ["account_email", email?.trim()],
      ["account_detail", detail?.trim()],
    ].filter((entry): entry is [string, string] => Boolean(entry[1])),
  )
}

function credential(tokens: typeof TokenResponse.Type): Credential.OAuth {
  const metadata = profileMetadata(tokens)
  return Credential.OAuth.make({
    type: "oauth",
    methodID,
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? "",
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  })
}

// Joins refreshes of the same refresh token onto one exchange. Successes are retained so callers
// still holding the rotated token reuse the result; failures are dropped so the next caller retries.
function singleFlight(key: string, effect: Effect.Effect<Credential.OAuth, Error>) {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    refreshing.forEach((entry, entryKey) => {
      if (entry.until < now) refreshing.delete(entryKey)
    })
    const existing = refreshing.get(key)
    if (existing) return yield* Deferred.await(existing.attempt)
    const attempt = Deferred.makeUnsafe<Credential.OAuth, Error>()
    refreshing.set(key, { attempt, until: Number.POSITIVE_INFINITY })
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Effect.map(Clock.currentTimeMillis, (settledAt) => {
          if (Exit.isSuccess(exit)) refreshing.set(key, { attempt, until: settledAt + refreshRetention })
          if (Exit.isFailure(exit)) refreshing.delete(key)
          Deferred.doneUnsafe(attempt, exit)
        }),
      ),
    )
  })
}

const token = Effect.fn("AnthropicPlugin.token")(function* (
  client: HttpClient.HttpClient,
  body: typeof TokenRequest.Type,
) {
  const request = yield* HttpClientRequest.post(tokenURL).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.setHeader("user-agent", `claude-cli/${claudeCodeVersion}`),
    HttpClientRequest.schemaBodyJson(TokenRequest)(body),
  )
  const response = yield* client
    .execute(request)
    .pipe(Effect.mapError(() => new Error("Anthropic token request failed. Check your connection and try again.")))
  if (response.status < 200 || response.status >= 300) {
    const failure = yield* HttpClientResponse.schemaBodyJson(TokenError)(response).pipe(
      Effect.orElseSucceed((): typeof TokenError.Type => ({})),
    )
    const detail = failure.error_description ?? failure.error ?? `HTTP ${response.status}`
    return yield* Effect.fail(new Error(`Anthropic rejected the token request: ${detail}`))
  }
  const tokens = yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response).pipe(
    Effect.mapError(() => new Error("Anthropic returned an invalid token response. Sign in again.")),
  )
  if (!tokens.access_token.trim())
    return yield* Effect.fail(new Error("Anthropic returned an empty access token. Sign in again."))
  return tokens
})

const exchange = Effect.fn("AnthropicPlugin.exchange")(function* (
  client: HttpClient.HttpClient,
  code: string,
  verifier: string,
  state: string,
) {
  const tokens = yield* token(client, {
    grant_type: "authorization_code",
    client_id: clientID,
    code,
    state,
    redirect_uri: redirectURI,
    code_verifier: verifier,
  })
  if (!tokens.refresh_token?.trim())
    return yield* Effect.fail(new Error("Anthropic did not return a refresh token. Sign in again."))
  return tokens
})

const refresh = (client: HttpClient.HttpClient, value: Credential.OAuth) => {
  if (!value.refresh.trim())
    return Effect.fail(new Error("This Anthropic subscription has no refresh token. Sign in again."))
  return singleFlight(
    value.refresh,
    token(client, {
      grant_type: "refresh_token",
      client_id: clientID,
      refresh_token: value.refresh,
    }).pipe(
      Effect.map((tokens) => {
        const next = credential(tokens)
        return Credential.OAuth.make({
          ...next,
          refresh: next.refresh || value.refresh,
          // A refresh response may omit identity fields; keep what the login recorded.
          metadata: { ...value.metadata, ...next.metadata },
        })
      }),
      Effect.mapError(
        (cause) =>
          new Error(`Anthropic subscription refresh failed: ${cause.message} If the problem continues, sign in again.`),
      ),
    ),
  )
}

function authorizationURL(challenge: string, state: string) {
  return `${authorizeURL}?${new URLSearchParams({
    code: "true",
    client_id: clientID,
    response_type: "code",
    redirect_uri: redirectURI,
    scope: scopes,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })}`
}

/**
 * Accept the full redirect URL the browser landed on. Requiring its state keeps
 * a pasted code bound to the attempt that started this sign-in.
 */
export function authorizationCode(input: string, expectedState: string) {
  const value = input.trim()
  if (!value) throw new Error("Paste the full redirect URL from your browser.")
  const accept = (code: string | null | undefined, state: string | null | undefined, error?: string | null) => {
    if (error) throw new Error(error)
    if (!code?.trim()) throw new Error("The redirect URL has no authorization code.")
    if (!state?.trim()) throw new Error("The redirect URL has no state. Copy the complete address from the browser.")
    if (state.trim() !== expectedState) throw new Error("OAuth state mismatch. Start the sign-in again.")
    return code.trim()
  }

  if (URL.canParse(value)) {
    const url = new URL(value)
    if (url.origin !== `http://${callbackHost}:${callbackPort}` || url.pathname !== "/callback") {
      throw new Error("Paste the redirect URL Memyr opened, including its code and state.")
    }
    const params = url.searchParams
    return accept(params.get("code"), params.get("state"), params.get("error_description") ?? params.get("error"))
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2)
    return accept(code, state)
  }

  const query = value.startsWith("?") ? value.slice(1) : value
  if (!query.includes("code="))
    throw new Error("Paste the full redirect URL from your browser, including its code and state.")
  const params = new URLSearchParams(query)
  return accept(params.get("code"), params.get("state"), params.get("error_description") ?? params.get("error"))
}

function listen(server: Server) {
  return Effect.callback<void, Error>((resume) => {
    const onError = (error: Error) => resume(Effect.fail(error))
    server.once("error", onError)
    server.listen(callbackPort, callbackHost, () => {
      server.off("error", onError)
      resume(Effect.void)
    })
  }).pipe(
    Effect.mapError((cause) =>
      "code" in cause && cause.code === "EADDRINUSE"
        ? new Error(
            `Anthropic browser login needs local port ${callbackPort}, but it is already in use. ` +
              "Choose “Paste redirect URL” instead, or stop the process using that port.",
          )
        : cause,
    ),
  )
}

const oauth = (client: HttpClient.HttpClient) =>
  ({
    integrationID,
    method: {
      id: methodID,
      type: "oauth",
      label: "Claude Code subscription (Pro/Max)",
      form: Form.Fields.make([
        {
          type: "string",
          key: "mode",
          title: "How should authorization finish?",
          required: true,
          default: "browser",
          options: [
            {
              value: "browser",
              label: "Open browser (this machine)",
              description: "Memyr captures the localhost redirect automatically.",
            },
            {
              value: "code",
              label: "Paste redirect URL (remote)",
              description: "Use this when the browser runs on another machine.",
            },
          ],
        },
      ]),
    },
    label: (value) => {
      const email = text(value.metadata?.account_email)
      const detail = text(value.metadata?.account_detail)
      if (detail && email) return `${detail} · ${email}`
      return email ?? detail ?? "Claude subscription"
    },
    refresh: (value) => refresh(client, value),
    authorize: (answer) =>
      Effect.gen(function* () {
        const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
        const challenge = Buffer.from(
          yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
        ).toString("base64url")
        const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
        const url = authorizationURL(challenge, state)

        if (answer.mode !== "code") {
          const received = yield* Deferred.make<{ code: string; response: ServerResponse }, Error>()
          const { createServer } = yield* Effect.promise(() => import("node:http"))
          const server = createServer((request, response) => {
            const incoming = new URL(request.url ?? "/", `http://${callbackHost}`)
            if (request.method !== "GET" || incoming.pathname !== "/callback") {
              response.writeHead(404).end()
              return
            }
            const params = incoming.searchParams
            const error = params.get("error_description") ?? params.get("error")
            if (error) {
              Effect.runSync(Deferred.fail(received, new Error(error)))
              response
                .writeHead(400, { "Content-Type": "text/html" })
                .end(OauthCallbackPage.error(error, { provider: "Anthropic" }))
              return
            }
            if (params.get("state") !== state) {
              const message = "Invalid OAuth state"
              Effect.runSync(Deferred.fail(received, new Error(message)))
              response
                .writeHead(400, { "Content-Type": "text/html" })
                .end(OauthCallbackPage.error(message, { provider: "Anthropic" }))
              return
            }
            const code = params.get("code")?.trim()
            if (!code) {
              const message = "Missing authorization code"
              Effect.runSync(Deferred.fail(received, new Error(message)))
              response
                .writeHead(400, { "Content-Type": "text/html" })
                .end(OauthCallbackPage.error(message, { provider: "Anthropic" }))
              return
            }
            if (!Effect.runSync(Deferred.succeed(received, { code, response })))
              response.writeHead(409).end("OAuth callback already received")
          })
          yield* listen(server)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              server.close()
              server.closeAllConnections()
            }),
          )
          return {
            mode: "auto" as const,
            url,
            instructions: "Complete authorization in your browser. This window will finish automatically.",
            callback: Effect.gen(function* () {
              const request = yield* Deferred.await(received)
              const respond = (error?: string) =>
                Effect.sync(() =>
                  request.response
                    .writeHead(error ? 400 : 200, { "Content-Type": "text/html" })
                    .end(
                      error
                        ? OauthCallbackPage.error(error, { provider: "Anthropic" })
                        : OauthCallbackPage.success({ provider: "Anthropic" }),
                    ),
                )
              return yield* exchange(client, request.code, verifier, state).pipe(
                Effect.map(credential),
                Effect.tap(() => respond()),
                Effect.tapError((cause) => respond(cause.message)),
                // Bun's closeAllConnections leaves an unanswered callback response pending.
                Effect.onInterrupt(() => Effect.sync(() => request.response.destroy())),
              )
            }),
          }
        }

        return {
          mode: "code" as const,
          url,
          instructions:
            "Open the URL and approve access. Then paste the full address the browser was redirected to; " +
            "it contains the authorization code and state.",
          callback: (input: string) =>
            Effect.gen(function* () {
              const code = yield* Effect.try({
                try: () => authorizationCode(input, state),
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              })
              return yield* exchange(client, code, verifier, state).pipe(Effect.map(credential))
            }),
        }
      }),
  }) satisfies IntegrationOAuthMethodRegistration

export const AnthropicPlugin = define({
  id: "opencode.provider.anthropic",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    yield* ctx.integration.transform((editor) => {
      editor.update(integrationID, (integration) => {
        integration.name = "Anthropic"
      })
      editor.method.update(oauth(http))
    })
  }),
})
