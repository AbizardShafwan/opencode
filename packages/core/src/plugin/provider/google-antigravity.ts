import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { createHash, randomBytes } from "node:crypto"
import type { Server, ServerResponse } from "node:http"
import { Clock, Deferred, Effect, Option, Schema, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { isRecord } from "@opencode/ai/utils/record"
import { Bus } from "../../bus.js"
import { Credential } from "../../credential.js"
import { Form } from "../../form.js"
import { Integration } from "../../integration.js"
import { IntegrationConnection } from "../../integration/connection.js"
import { OauthCallbackPage } from "../../oauth/page.js"
import { Provider } from "../../provider.js"
import {
  AUTH_URL,
  CALLBACK_PATH,
  CALLBACK_PORT,
  ENDPOINT,
  METHOD_ID,
  REDIRECT_URI,
  SCOPES,
  TOKEN_URL,
  USER_AGENT,
  USERINFO_URL,
  callbackCode,
  clientID,
  clientSecret,
  isAntigravityRequest,
  projectIdFromPayload,
  stableId,
  unwrapResponse,
  wrapRequest,
} from "../../google-antigravity/client.js"
import { AvailableModels, models, supportedInventory } from "../../google-antigravity/models.js"

const integrationID = Integration.ID.make("google")
const methodID = Integration.MethodID.make(METHOD_ID)
const callbackHost = "127.0.0.1"

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
})

const TokenError = Schema.Struct({
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
})

const UserInfo = Schema.Struct({
  email: Schema.optional(Schema.String),
})

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

function profileMetadata(projectId: string | undefined, email: string | undefined) {
  return Object.fromEntries(
    [
      ["projectId", projectId],
      ["email", email],
    ].filter((entry): entry is [string, string] => Boolean(entry[1])),
  )
}

const token = Effect.fn("GoogleAntigravityPlugin.token")(function* (
  client: HttpClient.HttpClient,
  form: Record<string, string>,
) {
  const request = HttpClientRequest.post(TOKEN_URL).pipe(
    HttpClientRequest.setHeader("content-type", "application/x-www-form-urlencoded"),
    HttpClientRequest.bodyUrlParams({ ...form, client_id: clientID(), client_secret: clientSecret() }),
  )
  const response = yield* client
    .execute(request)
    .pipe(Effect.mapError(() => new Error("Google token request failed. Check your connection and try again.")))
  if (response.status < 200 || response.status >= 300) {
    const failure = yield* HttpClientResponse.schemaBodyJson(TokenError)(response).pipe(
      Effect.orElseSucceed((): typeof TokenError.Type => ({})),
    )
    const detail = failure.error_description ?? failure.error ?? `HTTP ${response.status}`
    return yield* Effect.fail(new Error(`Google rejected the token request: ${detail}`))
  }
  const tokens = yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response).pipe(
    Effect.mapError(() => new Error("Google returned an invalid token response. Sign in again.")),
  )
  if (!tokens.access_token.trim())
    return yield* Effect.fail(new Error("Google returned an empty access token. Sign in again."))
  return tokens
})

const email = Effect.fn("GoogleAntigravityPlugin.email")(function* (
  client: HttpClient.HttpClient,
  access: string,
) {
  const response = yield* client
    .execute(
      HttpClientRequest.get(USERINFO_URL).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${access}`),
        HttpClientRequest.acceptJson,
      ),
    )
    .pipe(Effect.orElseSucceed(() => undefined))
  if (!response || response.status < 200 || response.status >= 300) return undefined
  const info = yield* HttpClientResponse.schemaBodyJson(UserInfo)(response).pipe(
    Effect.orElseSucceed((): typeof UserInfo.Type => ({})),
  )
  return text(info.email)
})

const project = Effect.fn("GoogleAntigravityPlugin.project")(function* (
  client: HttpClient.HttpClient,
  access: string,
) {
  const response = yield* client
    .execute(
      HttpClientRequest.post(`${ENDPOINT}/v1internal:loadCodeAssist`).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${access}`),
        HttpClientRequest.setHeader("content-type", "application/json"),
        HttpClientRequest.bodyJsonUnsafe({ metadata: { ideType: "ANTIGRAVITY" } }),
      ),
    )
    .pipe(Effect.orElseSucceed(() => undefined))
  if (!response || response.status < 200 || response.status >= 300) return undefined
  const body = yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(response).pipe(
    Effect.orElseSucceed(() => undefined),
  )
  return projectIdFromPayload(body)
})

const exchange = Effect.fn("GoogleAntigravityPlugin.exchange")(function* (
  client: HttpClient.HttpClient,
  code: string,
  verifier: string,
) {
  const tokens = yield* token(client, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  })
  if (!tokens.refresh_token?.trim())
    return yield* Effect.fail(new Error("Google did not return a refresh token. Sign in again and allow offline access."))

  const account = yield* email(client, tokens.access_token)
  const discovered = yield* project(client, tokens.access_token)
  return Credential.OAuth.make({
    type: "oauth",
    methodID,
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: (yield* Clock.currentTimeMillis) + (tokens.expires_in ?? 3600) * 1000,
    metadata: profileMetadata(discovered ?? stableId(account ?? "antigravity-default", "project"), account),
  })
})

function authorizeURL(challenge: string, state: string) {
  return `${AUTH_URL}?${new URLSearchParams({
    client_id: clientID(),
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  })}`
}

function listen(server: Server) {
  return Effect.callback<void, Error>((resume) => {
    const onError = (cause: Error) => resume(Effect.fail(cause))
    server.once("error", onError)
    server.listen(CALLBACK_PORT, callbackHost, () => {
      server.off("error", onError)
      resume(Effect.void)
    })
  }).pipe(
    Effect.mapError((cause) =>
      "code" in cause && cause.code === "EADDRINUSE"
        ? new Error(
            `Google Antigravity browser login needs local port ${CALLBACK_PORT}, but it is already in use. ` +
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
      label: "Antigravity subscription (Google sign-in)",
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
    label: (value) => text(value.metadata?.email) ?? "Google Antigravity",
    refresh: (value) =>
      token(client, {
        grant_type: "refresh_token",
        refresh_token: value.refresh,
      }).pipe(
        Effect.map((tokens) =>
          Credential.OAuth.make({
            ...value,
            access: tokens.access_token,
            refresh: tokens.refresh_token ?? value.refresh,
            expires:
              Date.now() +
              (tokens.expires_in ?? 3600) * 1000,
          }),
        ),
        Effect.mapError(
          (cause) =>
            new Error(
              `Google Antigravity refresh failed: ${cause.message} If the problem continues, sign in again.`,
            ),
        ),
      ),
    authorize: (answer) =>
      Effect.gen(function* () {
        const verifier = randomBytes(32).toString("base64url")
        const challenge = createHash("sha256").update(verifier).digest("base64url")
        const state = randomBytes(32).toString("base64url")
        const url = authorizeURL(challenge, state)

        if (answer.mode !== "browser")
          return {
            mode: "code" as const,
            url,
            instructions:
              "Open the URL and approve access. Then paste the full address the browser was redirected to; " +
              "it contains the authorization code and state.",
            callback: (input: string) =>
              Effect.gen(function* () {
                const code = yield* Effect.try({
                  try: () => callbackCode(input, state),
                  catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
                })
                return yield* exchange(client, code, verifier)
              }),
          }

        const received = yield* Deferred.make<{ code: string; response: ServerResponse }, Error>()
        const { createServer } = yield* Effect.promise(() => import("node:http"))
        const server = createServer((request, response) => {
          const incoming = new URL(request.url ?? "/", `http://${callbackHost}:${CALLBACK_PORT}`)
          if (request.method !== "GET" || incoming.pathname !== CALLBACK_PATH) {
            response.writeHead(404).end()
            return
          }
          const params = incoming.searchParams
          const error = params.get("error_description") ?? params.get("error")
          if (error) {
            Effect.runSync(Deferred.fail(received, new Error(error)))
            response
              .writeHead(400, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.error(error, { provider: "Google Antigravity" }))
            return
          }
          if (params.get("state") !== state) {
            const message = "Invalid OAuth state"
            Effect.runSync(Deferred.fail(received, new Error(message)))
            response
              .writeHead(400, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.error(message, { provider: "Google Antigravity" }))
            return
          }
          const code = params.get("code")?.trim()
          if (!code) {
            const message = "Missing authorization code"
            Effect.runSync(Deferred.fail(received, new Error(message)))
            response
              .writeHead(400, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.error(message, { provider: "Google Antigravity" }))
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
          instructions: "Complete Google sign-in in your browser. This window will finish automatically.",
          callback: Effect.gen(function* () {
            const request = yield* Deferred.await(received)
            const respond = (error?: string) =>
              Effect.sync(() =>
                request.response
                  .writeHead(error ? 400 : 200, { "Content-Type": "text/html" })
                  .end(
                    error
                      ? OauthCallbackPage.error(error, { provider: "Google Antigravity" })
                      : OauthCallbackPage.success({ provider: "Google Antigravity" }),
                  ),
              )
            return yield* exchange(client, request.code, verifier).pipe(
              Effect.tap(() => respond()),
              Effect.tapError((cause) => respond(cause.message)),
              Effect.onInterrupt(() => Effect.sync(() => request.response.destroy())),
            )
          }),
        }
      }),
  }) satisfies IntegrationOAuthMethodRegistration

/**
 * When the active Google connection is an Antigravity account, the provider's
 * catalog becomes the Antigravity model set and requests are rewritten to
 * Cloud Code Assist. A normal Google API-key connection is left untouched.
 */
export const GoogleAntigravityPlugin = define({
  id: "opencode.provider.google.antigravity",
  effect: Effect.fn(function* (ctx) {
    const client = yield* HttpClient.HttpClient
    const bus = yield* Bus.Service
    const loading = Semaphore.makeUnsafe(1)
    const loaded: {
      active: boolean
      projectId?: string
      models?: typeof AvailableModels.Type
      connection?: Effect.Success<ReturnType<typeof ctx.integration.connection.active>>
    } = {
      active: false,
    }

    const load = Effect.fn("GoogleAntigravityPlugin.load")(function* () {
      const connection = yield* ctx.integration.connection.active(integrationID)
      const credential = connection
        ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
        : undefined
      if (credential?.type !== "oauth" || credential.methodID !== methodID) {
        loaded.active = false
        loaded.projectId = undefined
        loaded.models = undefined
        loaded.connection = undefined
        return
      }
      const projectId = text(credential.metadata?.projectId)
      const remote = yield* Effect.gen(function* () {
        for (const endpoint of [ENDPOINT, "https://cloudcode-pa.googleapis.com"]) {
          const result = yield* client
            .execute(
              HttpClientRequest.post(`${endpoint}/v1internal:fetchAvailableModels`).pipe(
                HttpClientRequest.setHeader("authorization", `Bearer ${credential.access}`),
                HttpClientRequest.setHeader("user-agent", USER_AGENT),
                HttpClientRequest.bodyJsonUnsafe(projectId ? { project: projectId } : {}),
              ),
            )
            .pipe(
              Effect.flatMap((response) =>
                response.status >= 200 && response.status < 300
                  ? HttpClientResponse.schemaBodyJson(AvailableModels)(response)
                  : Stream.runDrain(response.stream).pipe(
                      Effect.andThen(Effect.fail(new Error(`Model discovery returned HTTP ${response.status}`))),
                    ),
              ),
              Effect.timeout("5 seconds"),
              Effect.orElseSucceed(() => undefined),
            )
          if (result) return supportedInventory(result)
        }
        return undefined
      })
      if (
        IntegrationConnection.key(connection) !==
        IntegrationConnection.key(yield* ctx.integration.connection.active(integrationID))
      )
        return
      const sameAccount = IntegrationConnection.key(connection) === IntegrationConnection.key(loaded.connection)
      loaded.active = true
      loaded.projectId = projectId
      loaded.models = remote ?? (sameAccount ? loaded.models : undefined)
      loaded.connection = connection
      if (!remote) yield* Effect.logWarning("Failed to discover Google Antigravity models for the active account")
    })

    yield* ctx.integration.transform((editor) => {
      editor.method.update(oauth(client))
    })
    yield* ctx.provider.transform((evt) => {
      if (!loaded.active) return
      const provider = evt.get(Provider.ID.google)
      if (!provider) return
      evt.add({
        info: provider.provider,
        models: loaded.models ? models(provider.models, loaded.models) : [],
        sourceConnection: loaded.connection,
      })
    })
    yield* ctx.session.hook(
      "http.request",
      (evt) =>
        Effect.gen(function* () {
          if (!loaded.active || evt.model.providerID !== Provider.ID.google) return
          const token = evt.request.headers.get("x-goog-api-key")
          if (!token) return
          const project = loaded.projectId
          if (!project)
            return yield* Effect.die(
              new Error("The Google Antigravity project is missing. Sign in again to reconnect the account."),
            )
          const body = yield* Effect.tryPromise(() => evt.request.clone().text()).pipe(Effect.orDie)
          const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(body)
          if (Option.isNone(decoded) || !isRecord(decoded.value))
            return yield* Effect.die(new Error("Google provider sent an invalid request body"))
          const request = decoded.value
          const headers = new Headers(evt.request.headers)
          headers.delete("x-goog-api-key")
          headers.delete("content-length")
          headers.set("authorization", `Bearer ${token}`)
          headers.set("content-type", "application/json")
          headers.set("accept", "text/event-stream")
          headers.set("user-agent", USER_AGENT)
          evt.request = new Request(`${ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
            method: evt.request.method,
            headers,
            body: JSON.stringify(
              wrapRequest(request, {
                project,
                modelID: evt.model.id,
                sessionID: evt.sessionID,
                availableModels: loaded.models?.models,
              }),
            ),
            signal: evt.request.signal,
          })
        }).pipe(Effect.orDie),
      { providerID: Provider.ID.google },
    )
    yield* ctx.session.hook(
      "http.response",
      (evt) =>
        Effect.sync(() => {
          if (!isAntigravityRequest(evt.request.url)) return
          evt.response = unwrapResponse(evt.response)
        }),
      { providerID: Provider.ID.google },
    )

    const refresh = () => loading.withPermit(load().pipe(Effect.andThen(ctx.provider.reload())))
    yield* bus.subscribe(Credential.Event.Switched).pipe(
      Stream.filter((event) => event.data.integrationID === integrationID),
      Stream.runForEach(refresh),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* refresh()
  }),
})
