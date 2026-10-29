import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Model } from "@opencode/core/model"
import { Model as ModelSchema } from "@opencode/schema/model"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { GoogleAntigravityPlugin } from "@opencode/core/plugin/provider/google-antigravity"
import { Gemini } from "@opencode/ai/protocols"
import { Session } from "@opencode/schema/session"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { DateTime } from "effect"
import {
  METHOD_ID,
  callbackCode,
  projectIdFromPayload,
  runtimeModel,
  thinkingFor,
  unwrapResponse,
  unwrapSseLine,
  wrapRequest,
} from "@opencode/core/google-antigravity/client"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const integrationID = Integration.ID.make("google")
const methodID = Integration.MethodID.make(METHOD_ID)

type Call = { method: string; url: string; headers: Headers; body: string }

const tokens = {
  access_token: "ya29.antigravity-access",
  refresh_token: "1//antigravity-refresh",
  expires_in: 3600,
}

const mock = (responses: ReadonlyArray<unknown>) => {
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
    const host = yield* PluginHost.make(plugin, GoogleAntigravityPlugin.id)
    yield* GoogleAntigravityPlugin.effect(host).pipe(Effect.provideService(HttpClient.HttpClient, http))
  })

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Expected value")
  return value
}

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

describe("Antigravity model routing", () => {
  test("selects the runtime model for each thinking effort", () => {
    expect(runtimeModel("gemini-3.8-flash", { thinkingLevel: "high" })).toBe("gemini-3.8-flash-tiered")
    expect(runtimeModel("gemini-3.7-flash", undefined)).toBe("gemini-3.7-flash-tiered")
    expect(runtimeModel("gemini-3.6-flash", { thinkingLevel: "low" })).toBe("gemini-3.6-flash-low")
    expect(runtimeModel("gemini-3.6-flash", { thinkingLevel: "medium" })).toBe("gemini-3.6-flash-medium")
    expect(runtimeModel("gemini-3.6-flash", { thinkingLevel: "high" })).toBe("gemini-3.6-flash-high")
    expect(runtimeModel("gemini-3.5-flash", { thinkingBudget: 1000 })).toBe("gemini-3.5-flash-extra-low")
    expect(runtimeModel("gemini-3.5-flash", { thinkingLevel: "medium" })).toBe("gemini-3.5-flash-low")
    expect(runtimeModel("gemini-3.5-flash", { thinkingLevel: "high" })).toBe("gemini-3-flash-agent")
    expect(runtimeModel("gemini-3.1-pro", { thinkingLevel: "high" })).toBe("gemini-pro-agent")
    expect(runtimeModel("gemini-3.1-pro", { thinkingLevel: "low" })).toBe("gemini-3.1-pro-low")
    expect(runtimeModel("claude-opus-4-6", undefined)).toBe("claude-opus-4-6-thinking")
    expect(runtimeModel("gpt-oss-120b", undefined)).toBe("gpt-oss-120b-medium")
  })

  test("translates thinking levels into Antigravity budgets", () => {
    expect(thinkingFor("gemini-3.6-flash-low", { thinkingLevel: "low" })).toEqual({
      includeThoughts: true,
      thinkingBudget: 1000,
    })
    expect(thinkingFor("gemini-3.6-flash-medium", { thinkingLevel: "medium" })).toEqual({
      includeThoughts: true,
      thinkingBudget: 4000,
    })
    expect(thinkingFor("gemini-3.6-flash-high", { thinkingLevel: "high" })).toEqual({
      includeThoughts: true,
      thinkingBudget: -1,
    })
    expect(thinkingFor("gemini-3.5-flash-extra-low", { thinkingLevel: "low" })).toEqual({
      includeThoughts: true,
      thinkingBudget: 1000,
    })
    expect(thinkingFor("gemini-pro-agent", { thinkingLevel: "high" })).toEqual({
      includeThoughts: true,
      thinkingBudget: 10001,
    })
    expect(thinkingFor("claude-sonnet-4-6", { thinkingLevel: "high" })).toEqual({
      includeThoughts: true,
      thinkingBudget: 1024,
    })
    expect(thinkingFor("gpt-oss-120b-medium", { thinkingLevel: "medium" })).toEqual({
      includeThoughts: true,
      thinkingBudget: 8192,
    })
    expect(thinkingFor("gemini-3.8-flash-tiered", { includeThoughts: false })).toEqual({
      includeThoughts: false,
      thinkingBudget: 0,
    })
    expect(thinkingFor("gemini-3.8-flash-tiered", undefined)).toEqual({
      includeThoughts: true,
      thinkingBudget: -1,
    })
  })

  test("wraps a Gemini request in the Cloud Code Assist envelope", () => {
    const body = {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      systemInstruction: { parts: [{ text: "system" }] },
      generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" } },
      tools: [
        {
          functionDeclarations: [
            {
              name: "read",
              description: "Read a file",
              parametersJsonSchema: {
                type: "object",
                properties: { path: { type: "string", format: "path" } },
                required: ["path"],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
    }

    const request = wrapRequest(body, { project: "project-1", modelID: "claude-sonnet-4-6", sessionID: "ses_1" })
    expect(request.project).toBe("project-1")
    expect(request.model).toBe("claude-sonnet-4-6")
    expect(request.requestType).toBe("agent")
    expect(request.userAgent).toBe("antigravity")
    expect(request.requestId).toStartWith("agent/")

    const inner = required(request.request as Record<string, unknown>)
    expect(inner.systemInstruction).toMatchObject({ role: "user", parts: [{ text: "system" }] })
    expect(inner.generationConfig).toMatchObject({ thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 } })
    expect(inner.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      },
    ])
  })

  test("keeps JSON Schema for Gemini models", () => {
    const request = wrapRequest(
      {
        contents: [],
        tools: [{ functionDeclarations: [{ name: "read", parametersJsonSchema: { type: "object" } }] }],
      },
      { project: "project-1", modelID: "gemini-3.8-flash", sessionID: "ses_1" },
    )
    expect(request.model).toBe("gemini-3.8-flash-tiered")
    expect(request.request).toMatchObject({
      tools: [{ functionDeclarations: [{ name: "read", parametersJsonSchema: { type: "object" } }] }],
    })
  })
})

describe("Cloud Code Assist stream decoding", () => {
  test("unwraps response envelopes and leaves other frames alone", () => {
    expect(unwrapSseLine('data: {"response":{"candidates":[]}}')).toBe('data: {"candidates":[]}')
    expect(unwrapSseLine('data: {"candidates":[]}')).toBe('data: {"candidates":[]}')
    expect(unwrapSseLine("data: [DONE]")).toBe("data: [DONE]")
    expect(unwrapSseLine(": keepalive")).toBe(": keepalive")
  })

  test("unwraps a streaming response without buffering it whole", async () => {
    const encoder = new TextEncoder()
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"response":{"candidates":[],"usageMetadata":{}}}\n\n'))
        controller.enqueue(encoder.encode('data: {"candidates":[{"finishReason":"STOP"}]}\n\n'))
        controller.close()
      },
    })
    const response = unwrapResponse(new Response(source, { headers: { "content-type": "text/event-stream" } }))
    expect(await response.text()).toBe(
      'data: {"candidates":[],"usageMetadata":{}}\n\ndata: {"candidates":[{"finishReason":"STOP"}]}\n\n',
    )
  })
})

describe("Antigravity OAuth", () => {
  test("accepts the loopback callback and rejects a mismatched state", () => {
    expect(callbackCode("http://localhost:51121/oauth-callback?code=abc&state=s1", "s1")).toBe("abc")
    expect(() =>
      callbackCode("http://localhost:51121/oauth-callback?code=abc&state=s2", "s1"),
    ).toThrow("OAuth state mismatch")
  })

  test("finds the project in each documented response shape", () => {
    expect(projectIdFromPayload({ cloudaicompanionProject: "p1" })).toBe("p1")
    expect(projectIdFromPayload({ cloudaicompanionProject: { id: "p2" } })).toBe("p2")
    expect(projectIdFromPayload({ projectId: "p3" })).toBe("p3")
    expect(projectIdFromPayload({})).toBeUndefined()
  })

  it.effect("adds a subscription login method to the Google integration", () =>
    Effect.gen(function* () {
      const { http } = mock([])
      yield* addPlugin(http)
      const integrations = yield* Integration.Service
      const google = required(yield* integrations.get(integrationID))
      expect(google.methods).toContainEqual({
        id: methodID,
        type: "oauth",
        label: "Antigravity subscription (Google sign-in)",
        form: expect.any(Array),
      })
      expect(google.name).toBe("google")
    }),
  )

  it.effect("exchanges a pasted redirect and stores the project and email", () =>
    Effect.gen(function* () {
      const { http, calls } = mock([
        tokens,
        { email: "antigravity@example.com" },
        { cloudaicompanionProject: "project-123" },
      ])
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
      expect(authorization.origin).toBe("https://accounts.google.com")
      expect(authorization.pathname).toBe("/o/oauth2/v2/auth")
      expect(authorization.searchParams.get("redirect_uri")).toBe("http://localhost:51121/oauth-callback")
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256")
      expect(authorization.searchParams.get("access_type")).toBe("offline")
      expect(authorization.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/aicode")

      const state = required(authorization.searchParams.get("state"))
      yield* integrations.oauth.complete({
        integrationID,
        attemptID: attempt.attemptID,
        code: `http://localhost:51121/oauth-callback?code=auth-code&state=${encodeURIComponent(state)}`,
      })

      const stored = required((yield* credentials.list(integrationID)).find((entry) => entry.value.type === "oauth"))
      expect(stored.value).toMatchObject({
        type: "oauth",
        methodID,
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        metadata: { projectId: "project-123", email: "antigravity@example.com" },
      })
      expect((yield* integrations.get(integrationID))?.connections).toHaveLength(1)

      expect(calls.map((call) => call.url)).toEqual([
        "https://oauth2.googleapis.com/token",
        "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
        "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      ])
      expect(calls[0]?.headers.get("content-type")).toContain("application/x-www-form-urlencoded")
      expect(new URLSearchParams(calls[0]?.body ?? "").get("code")).toBe("auth-code")
      expect(calls[2]?.headers.get("authorization")).toBe(`Bearer ${tokens.access_token}`)
    }),
  )

  it.effect("captures the browser callback on the loopback port", () =>
    Effect.gen(function* () {
      const { http, calls } = mock([
        tokens,
        { email: "antigravity@example.com" },
        { cloudaicompanionProject: "project-123" },
      ])
      yield* addPlugin(http)
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const attempt = yield* integrations.oauth.connect({
        integrationID,
        methodID,
        answer: { mode: "browser" },
      })

      expect(attempt.mode).toBe("auto")
      const state = required(new URL(attempt.url).searchParams.get("state"))
      const response = yield* Effect.promise(() =>
        fetch(`http://localhost:51121/oauth-callback?code=browser-code&state=${encodeURIComponent(state)}`),
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
          (entry) => entry.value.type === "oauth" && entry.value.access === tokens.access_token,
        ),
      ).toBe(true)
      expect(new URLSearchParams(calls[0]?.body ?? "").get("code")).toBe("browser-code")
    }),
  )

  it.effect("switches the Google catalog to the Antigravity models while the account is active", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      const credentials = yield* Credential.Service
      const models = yield* Model.Service
      yield* providers.transform((editor) => {
        editor.add({
          info: {
            id: Provider.ID.google,
            integrationID: integrationID,
            name: "Google",
            activation: "auto",
            package: "@opencode/ai/providers/google",
          },
          models: [
            {
              ...ModelSchema.Info.default(Provider.ID.google, ModelSchema.ID.make("gemini-3.8-flash")),
              package: "@opencode/ai/providers/google",
            },
          ],
        })
      })
      yield* credentials.create({
        integrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: tokens.access_token,
          refresh: tokens.refresh_token,
          expires: Date.now() + 3_600_000,
          metadata: { projectId: "project-123" },
        }),
      })
      const { http } = mock([])
      yield* addPlugin(http)

      const ids = (yield* models.all())
        .filter((model) => model.providerID === Provider.ID.google)
        .map((model) => String(model.id))
      expect(ids).toEqual([
        "gemini-3.8-flash",
        "gemini-3.7-flash",
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.1-pro",
        "claude-sonnet-4-6",
        "claude-opus-4-6",
        "gpt-oss-120b",
      ])
      expect(yield* models.get(Provider.ID.google, ModelSchema.ID.make("claude-sonnet-4-6"))).toMatchObject({
        providerID: Provider.ID.google,
        package: "@opencode/ai/providers/google",
        enabled: true,
      })
    }),
  )

  it.effect("leaves the Google catalog untouched for an API-key connection", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      const credentials = yield* Credential.Service
      const models = yield* Model.Service
      yield* providers.transform((editor) => {
        editor.add({
          info: {
            id: Provider.ID.google,
            integrationID: integrationID,
            name: "Google",
            activation: "auto",
            package: "@opencode/ai/providers/google",
          },
          models: [
            {
              ...ModelSchema.Info.default(Provider.ID.google, ModelSchema.ID.make("gemini-3.8-flash")),
              package: "@opencode/ai/providers/google",
            },
          ],
        })
      })
      yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "google-api-key" }),
      })
      const { http } = mock([])
      yield* addPlugin(http)

      expect((yield* models.all()).filter((model) => model.providerID === Provider.ID.google).map((model) => model.id)).toEqual([
        ModelSchema.ID.make("gemini-3.8-flash"),
      ])
    }),
  )

  it.effect("rewrites the Google transport request and unwraps the Antigravity stream", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      yield* credentials.create({
        integrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: tokens.access_token,
          refresh: tokens.refresh_token,
          expires: Date.now() + 3_600_000,
          metadata: { projectId: "project-123" },
        }),
      })
      const { http } = mock([])
      yield* addPlugin(http)

      const session = Session.Info.make({
        id: Session.ID.make("ses_antigravity_hook"),
        projectID: Project.ID.global,
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
      })
      const model = SessionRunnerModel.resolved(Gemini.route.model({ id: "gemini-3.8-flash", provider: "google" }), {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost: [],
        limit: { context: 1_048_576, output: 65_536 },
      })
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const prepared = yield* requests.primary({
        session,
        agent: Agent.ID.make("build"),
        model,
        system: [],
        messages: [],
      })
      const middleware = prepared.options.http
      if (!middleware) throw new Error("Expected HTTP middleware")

      let captured: { url: string; headers: Headers; body: string } | undefined
      const result = yield* middleware(
        HttpClientRequest.post(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
        ).pipe(
          HttpClientRequest.setHeader("x-goog-api-key", tokens.access_token),
          HttpClientRequest.setHeader("content-type", "application/json"),
          HttpClientRequest.bodyJsonUnsafe({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
        ),
        (request) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
            captured = {
              url: web.url,
              headers: web.headers,
              body: yield* Effect.promise(() => web.text()),
            }
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n',
                { status: 200, headers: { "content-type": "text/event-stream" } },
              ),
            )
          }),
      )

      expect(captured?.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse")
      expect(captured?.headers.get("authorization")).toBe(`Bearer ${tokens.access_token}`)
      expect(captured?.headers.get("x-goog-api-key")).toBeNull()
      expect(JSON.parse(captured?.body ?? "{}")).toMatchObject({
        project: "project-123",
        model: "gemini-3.8-flash-tiered",
        requestType: "agent",
        userAgent: "antigravity",
        request: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } },
        },
      })
      expect(yield* result.text).toContain('"candidates"')
    }).pipe(
      Effect.provideService(
        SessionModelTransport.Service,
        SessionModelTransport.Service.of({
          bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
          close: () => Effect.void,
          closeAll: Effect.void,
        }),
      ),
    ),
  )
})
