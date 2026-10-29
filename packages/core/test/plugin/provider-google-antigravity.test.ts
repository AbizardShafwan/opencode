import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
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
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  METHOD_ID,
  callbackCode,
  clientID,
  clientSecret,
  projectIdFromPayload,
  runtimeModel,
  thinkingFor,
  unwrapResponse,
  unwrapSseLine,
  wrapRequest,
} from "@opencode/core/google-antigravity/client"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"
import { GoogleAntigravityModels } from "@opencode/core/google-antigravity/models"

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
      const body = responses[Math.min(calls.length - 1, responses.length - 1)] ?? { models: {} }
      return HttpClientResponse.fromWeb(
        request,
        body instanceof Response ? new Response(null, { status: body.status }) : Response.json(body),
      )
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
  test("derives only advertised text models, including unfamiliar model families", () => {
    const available = Schema.decodeUnknownSync(GoogleAntigravityModels.AvailableModels)({
      models: {
        argon: { displayName: "Argon", supportsImages: false, supportsThinking: false },
        "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", supportsImages: true, supportsThinking: true },
        "gemini-4-argon-medium": {
          displayName: "Gemini 4 Argon (Medium)",
          supportsImages: true,
          supportsThinking: true,
        },
        "gemini-4-argon-low": { displayName: "Gemini 4 Argon (Low)", supportsImages: true, supportsThinking: true },
        "claude-opus-5-5-low": { displayName: "Claude Opus 5.5 (Low)", supportsImages: true, supportsThinking: true },
        "claude-opus-5-5-high": { displayName: "Claude Opus 5.5 (High)", supportsImages: true, supportsThinking: true },
        "claude-opus-5-5-medium": {
          displayName: "Claude Opus 5.5 (Medium)",
          supportsImages: true,
          supportsThinking: true,
        },
        "claude-sonnet-5-5-medium": {
          displayName: "Claude Sonnet 5.5 (Medium)",
          supportsImages: true,
          supportsThinking: true,
        },
        "claude-sonnet-5-5-low": {
          displayName: "Claude Sonnet 5.5 (Low)",
          supportsImages: true,
          supportsThinking: true,
        },
        "claude-sonnet-5-5-high": {
          displayName: "Claude Sonnet 5.5 (High)",
          supportsImages: true,
          supportsThinking: true,
        },
        "gemini-3.8-flash-tiered": { supportsImages: true, supportsThinking: true },
        "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)", supportsImages: true, supportsThinking: true },
        "gemini-3.8-flash-medium": {
          displayName: "Gemini 3.8 Flash (Medium)",
          supportsImages: true,
          supportsThinking: true,
        },
        "gemini-3.8-flash-high": {
          displayName: "Gemini 3.8 Flash (High)",
          supportsImages: true,
          supportsThinking: true,
        },
        "gemini-3.6-flash-low": { supportsThinking: true },
        "claude-opus-4-6": { supportsThinking: false },
        "future-model-high": { displayName: "Future Model (High)", supportsThinking: true },
        "future-model-low": { displayName: "Future Model (Low)", supportsThinking: true },
        tab_hidden: {},
        chat_hidden: {},
        internal: { isInternal: true },
        "gemini-3-pro-image": {},
        "invalid/id": {},
      },
    })
    const result = GoogleAntigravityModels.models(new Map(), GoogleAntigravityModels.supportedInventory(available))
    expect(result.map((model) => String(model.id))).toEqual([
      "argon",
      "gemini-4-argon",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "gemini-3.8-flash",
      "gemini-3.6-flash",
      "claude-opus-4-6",
      "future-model",
    ])
    expect(result[0]).toMatchObject({
      id: "argon",
      modelID: "argon",
      name: "Argon",
      package: "@opencode/ai/providers/google",
      capabilities: { input: ["text"] },
      variants: [],
    })
    expect(result[1]).toMatchObject({
      id: "gemini-4-argon",
      modelID: "gemini-4-argon",
      name: "Gemini 4 Argon",
      capabilities: { input: ["text", "image"] },
    })
    expect(result[1]?.variants.map((variant) => String(variant.id))).toEqual(["low", "medium", "high"])
    expect(result[2]).toMatchObject({
      id: "claude-opus-5-5",
      modelID: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      limit: { context: 250_000, output: 64_000 },
    })
    expect(result[2]?.variants.map((variant) => String(variant.id))).toEqual(["low", "medium", "high"])
    expect(result[3]).toMatchObject({
      id: "claude-sonnet-5-5",
      modelID: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      limit: { context: 200_000, output: 64_000 },
    })
    expect(result[3]?.variants.map((variant) => String(variant.id))).toEqual(["low", "medium", "high"])
    expect(result[4]).toMatchObject({
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
    })
    expect(result[4]?.variants.map((variant) => String(variant.id))).toEqual(["low", "medium", "high"])
    expect(result[5]?.variants.map((variant) => String(variant.id))).toEqual(["low"])
    expect(result[6]?.variants).toEqual([])
    expect(result[7]).toMatchObject({
      id: "future-model",
      name: "Future Model",
    })
    expect(result[7]?.variants.map((variant) => String(variant.id))).toEqual(["low", "high"])
    expect(GoogleAntigravityModels.models(new Map(), { models: {} })).toEqual([])
  })

  test("uses an advertised runtime and enum instead of static routing", () => {
    expect(
      wrapRequest(
        { contents: [] },
        {
          project: "p1",
          modelID: "claude-opus-4-6",
          sessionID: "ses_1",
          availableModels: { "claude-opus-4-6": { model: "MODEL_FROM_ACCOUNT" } },
        },
      ),
    ).toMatchObject({
      model: "claude-opus-4-6",
      request: { labels: { model_enum: "MODEL_FROM_ACCOUNT" } },
    })
  })

  test("routes only to available effort variants and rejects unavailable models", () => {
    const available = GoogleAntigravityModels.supportedInventory({
      models: {
        "gemini-3.6-flash-low": {},
        "gemini-3.6-flash-high": { isInternal: true },
        "gemini-4-argon-low": { model: "MODEL_ARGON_LOW" },
        "gemini-4-argon-medium": { model: "MODEL_ARGON_MEDIUM" },
        "gemini-4-argon-high": { model: "MODEL_ARGON_HIGH" },
        "claude-opus-5-5-low": { model: "MODEL_OPUS_LOW" },
        "claude-opus-5-5-high": { model: "MODEL_OPUS_HIGH" },
      },
    })
    expect(
      wrapRequest(
        { contents: [] },
        {
          project: "p1",
          modelID: "gemini-3.6-flash",
          sessionID: "ses_1",
          availableModels: available.models,
        },
      ),
    ).toMatchObject({ model: "gemini-3.6-flash-low" })
    expect(
      wrapRequest(
        { contents: [] },
        {
          project: "p1",
          modelID: "gemini-4-argon",
          sessionID: "ses_1",
          availableModels: available.models,
        },
      ),
    ).toMatchObject({
      model: "gemini-4-argon-high",
      request: { labels: { model_enum: "MODEL_ARGON_HIGH" } },
    })
    expect(
      wrapRequest(
        { contents: [], generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } } },
        {
          project: "p1",
          modelID: "gemini-4-argon",
          sessionID: "ses_1",
          availableModels: available.models,
        },
      ),
    ).toMatchObject({
      model: "gemini-4-argon-low",
      request: {
        generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 1000 } },
        labels: { model_enum: "MODEL_ARGON_LOW" },
      },
    })
    expect(
      wrapRequest(
        { contents: [], generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" } } },
        {
          project: "p1",
          modelID: "gemini-4-argon",
          sessionID: "ses_1",
          availableModels: available.models,
        },
      ),
    ).toMatchObject({
      model: "gemini-4-argon-medium",
      request: {
        generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 4000 } },
        labels: { model_enum: "MODEL_ARGON_MEDIUM" },
      },
    })
    expect(
      wrapRequest(
        { contents: [], generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } } },
        {
          project: "p1",
          modelID: "claude-opus-5-5",
          sessionID: "ses_1",
          availableModels: available.models,
        },
      ),
    ).toMatchObject({
      model: "claude-opus-5-5-low",
      request: {
        generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 } },
        labels: { model_enum: "MODEL_OPUS_LOW", used_claude: "true" },
      },
    })
    expect(() =>
      wrapRequest(
        { contents: [] },
        {
          project: "p1",
          modelID: "argon",
          sessionID: "ses_1",
          availableModels: {},
        },
      ),
    ).toThrow("not available for this account")
  })

  test("selects the runtime model for each thinking effort", () => {
    expect(runtimeModel("gemini-4-argon", { thinkingLevel: "low" })).toBe("gemini-4-argon-low")
    expect(runtimeModel("gemini-4-argon", { thinkingLevel: "medium" })).toBe("gemini-4-argon-medium")
    expect(runtimeModel("gemini-4-argon", { thinkingLevel: "high" })).toBe("gemini-4-argon-high")
    expect(runtimeModel("claude-opus-5-5", { thinkingLevel: "low" })).toBe("claude-opus-5-5-low")
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
    expect(thinkingFor("gemini-4-argon-low", { thinkingLevel: "low" })).toEqual({
      includeThoughts: true,
      thinkingBudget: 1000,
    })
    expect(thinkingFor("gemini-4-argon-medium", { thinkingLevel: "medium" })).toEqual({
      includeThoughts: true,
      thinkingBudget: 4000,
    })
    expect(thinkingFor("gemini-4-argon-high", { thinkingLevel: "high" })).toEqual({
      includeThoughts: true,
      thinkingBudget: -1,
    })
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
  test("resolves the shared desktop OAuth client defaults and honors non-blank environment overrides", () => {
    expect(DEFAULT_CLIENT_ID).toBe("1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com")
    expect(DEFAULT_CLIENT_SECRET).toBe("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")
    expect(clientID({})).toBe(DEFAULT_CLIENT_ID)
    expect(clientSecret({})).toBe(DEFAULT_CLIENT_SECRET)
    expect(clientID({ ANTIGRAVITY_CLIENT_ID: "" })).toBe(DEFAULT_CLIENT_ID)
    expect(clientID({ ANTIGRAVITY_CLIENT_ID: "   " })).toBe(DEFAULT_CLIENT_ID)
    expect(clientSecret({ ANTIGRAVITY_CLIENT_SECRET: "" })).toBe(DEFAULT_CLIENT_SECRET)
    expect(clientSecret({ ANTIGRAVITY_CLIENT_SECRET: " \t\n " })).toBe(DEFAULT_CLIENT_SECRET)
    expect(clientID({ ANTIGRAVITY_CLIENT_ID: "  custom-client-id  " })).toBe("custom-client-id")
    expect(clientSecret({ ANTIGRAVITY_CLIENT_SECRET: "  custom-client-secret  " })).toBe("custom-client-secret")
  })

  test("accepts the loopback callback and rejects a mismatched state", () => {
    expect(callbackCode("http://localhost:51121/oauth-callback?code=abc&state=s1", "s1")).toBe("abc")
    expect(() => callbackCode("http://localhost:51121/oauth-callback?code=abc&state=s2", "s1")).toThrow(
      "OAuth state mismatch",
    )
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
        { models: {} },
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
      expect(authorization.searchParams.get("client_id")).toBe(DEFAULT_CLIENT_ID)
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

      yield* until(
        Effect.sync(() => calls.length),
        (length) => length >= 4,
      )
      expect(calls.map((call) => call.url)).toEqual([
        "https://oauth2.googleapis.com/token",
        "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
        "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
        "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      ])
      expect(calls[0]?.headers.get("content-type")).toContain("application/x-www-form-urlencoded")
      const tokenForm = new URLSearchParams(calls[0]?.body ?? "")
      expect(tokenForm.get("code")).toBe("auth-code")
      expect(tokenForm.get("client_id")).toBe(DEFAULT_CLIENT_ID)
      expect(tokenForm.get("client_secret")).toBe(DEFAULT_CLIENT_SECRET)
      expect(calls[2]?.headers.get("authorization")).toBe(`Bearer ${tokens.access_token}`)
    }),
  )

  it.effect("honors ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET overrides and treats blank overrides as unset", () =>
    Effect.gen(function* () {
      const previousID = process.env.ANTIGRAVITY_CLIENT_ID
      const previousSecret = process.env.ANTIGRAVITY_CLIENT_SECRET
      const restore = Effect.sync(() => {
        if (previousID === undefined) delete process.env.ANTIGRAVITY_CLIENT_ID
        else process.env.ANTIGRAVITY_CLIENT_ID = previousID
        if (previousSecret === undefined) delete process.env.ANTIGRAVITY_CLIENT_SECRET
        else process.env.ANTIGRAVITY_CLIENT_SECRET = previousSecret
      })
      return yield* Effect.gen(function* () {
        const { http, calls } = mock([
          tokens,
          { email: "antigravity@example.com" },
          { cloudaicompanionProject: "project-123" },
          { models: {} },
        ])
        yield* addPlugin(http)
        const integrations = yield* Integration.Service

        process.env.ANTIGRAVITY_CLIENT_ID = "   "
        process.env.ANTIGRAVITY_CLIENT_SECRET = ""
        const blankAttempt = yield* integrations.oauth.connect({
          integrationID,
          methodID,
          answer: { mode: "code" },
        })
        expect(new URL(blankAttempt.url).searchParams.get("client_id")).toBe(DEFAULT_CLIENT_ID)

        process.env.ANTIGRAVITY_CLIENT_ID = " custom-client.apps.googleusercontent.com "
        process.env.ANTIGRAVITY_CLIENT_SECRET = " custom-secret "
        const customAttempt = yield* integrations.oauth.connect({
          integrationID,
          methodID,
          answer: { mode: "code" },
        })
        const authorization = new URL(customAttempt.url)
        expect(authorization.searchParams.get("client_id")).toBe("custom-client.apps.googleusercontent.com")
        const state = required(authorization.searchParams.get("state"))
        yield* integrations.oauth.complete({
          integrationID,
          attemptID: customAttempt.attemptID,
          code: `http://localhost:51121/oauth-callback?code=override-code&state=${encodeURIComponent(state)}`,
        })

        const tokenForm = new URLSearchParams(calls[0]?.body ?? "")
        expect(tokenForm.get("client_id")).toBe("custom-client.apps.googleusercontent.com")
        expect(tokenForm.get("client_secret")).toBe("custom-secret")
      }).pipe(Effect.ensuring(restore))
    }),
  )

  it.effect("captures the browser callback on the loopback port", () =>
    Effect.gen(function* () {
      const { http, calls } = mock([
        tokens,
        { email: "antigravity@example.com" },
        { cloudaicompanionProject: "project-123" },
        { models: {} },
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

  it.effect("discovers the active account's models and replaces them on account switches", () =>
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
      const { http, calls } = mock([
        { models: { "gemini-3.8-flash-tiered": {}, argon: { displayName: "Argon" }, "claude-sonnet-4-6": {} } },
        { models: [] },
        { models: { "second-account-model": { displayName: "Second account model" } } },
        new Response("unavailable", { status: 503 }),
      ])
      yield* addPlugin(http)

      const ids = (yield* models.all())
        .filter((model) => model.providerID === Provider.ID.google)
        .map((model) => String(model.id))
      expect(ids).toEqual(["gemini-3.8-flash", "argon", "claude-sonnet-4-6"])
      expect(yield* models.get(Provider.ID.google, ModelSchema.ID.make("claude-sonnet-4-6"))).toMatchObject({
        providerID: Provider.ID.google,
        package: "@opencode/ai/providers/google",
        enabled: true,
      })
      expect(calls[0]?.url).toEndWith("/v1internal:fetchAvailableModels")
      expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${tokens.access_token}`)
      expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ project: "project-123" })

      yield* credentials.create({
        integrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "second-token",
          refresh: "second-refresh",
          expires: Date.now() + 3_600_000,
          metadata: { projectId: "second-project" },
        }),
      })
      yield* until(models.all(), (values) => values.some((model) => model.id === "second-account-model"))
      expect(
        (yield* models.all())
          .filter((model) => model.providerID === Provider.ID.google)
          .map((model) => String(model.id)),
      ).toEqual(["second-account-model"])
      expect(calls[1]?.headers.get("authorization")).toBe("Bearer second-token")
      expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ project: "second-project" })
      expect(calls[2]?.url).toBe("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels")
      expect(calls[2]?.headers.get("authorization")).toBe("Bearer second-token")

      // A failed discovery for a different account must not reuse the previous account's inventory.
      yield* credentials.create({
        integrationID,
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "third-token",
          refresh: "third-refresh",
          expires: Date.now() + 3_600_000,
          metadata: { projectId: "third-project" },
        }),
      })
      yield* until(
        Effect.sync(() => calls.length),
        (length) => length >= 5,
      )
      yield* until(models.all(), (values) => !values.some((model) => model.providerID === Provider.ID.google))
      expect(calls.slice(3).map((call) => call.url)).toEqual([
        "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
        "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      ])

      yield* credentials.create({ integrationID, value: Credential.Key.make({ type: "key", key: "api-key" }) })
      yield* until(models.all(), (values) => values.some((model) => model.id === "gemini-3.8-flash"))
      expect(
        (yield* models.all())
          .filter((model) => model.providerID === Provider.ID.google)
          .map((model) => String(model.id)),
      ).toEqual(["gemini-3.8-flash"])
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
      const { http, calls } = mock([])
      yield* addPlugin(http)

      expect(
        (yield* models.all()).filter((model) => model.providerID === Provider.ID.google).map((model) => model.id),
      ).toEqual([ModelSchema.ID.make("gemini-3.8-flash")])
      expect(calls).toEqual([])
    }),
  )

  it.effect("cancels a timed-out discovery before trying the fallback endpoint", () =>
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
      const started = yield* Deferred.make<void>()
      const calls: string[] = []
      let cancelled = false
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          calls.push(request.url)
          if (request.url.startsWith("https://daily-cloudcode-pa.googleapis.com")) {
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  cancelled = true
                }),
              ),
            )
          }
          return HttpClientResponse.fromWeb(request, Response.json({ models: {} }))
        }),
      )
      const loading = yield* addPlugin(http).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(started)
      yield* Effect.yieldNow
      yield* TestClock.adjust("5 seconds")
      yield* Fiber.join(loading)
      expect(cancelled).toBe(true)
      expect(calls).toEqual([
        "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
        "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
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
      const { http } = mock([{ models: { argon: { displayName: "Argon", model: "MODEL_ARGON" } } }])
      yield* addPlugin(http)

      const session = Session.Info.make({
        id: Session.ID.make("ses_antigravity_hook"),
        projectID: Project.ID.global,
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
      })
      const model = SessionRunnerModel.resolved(Gemini.route.model({ id: "argon", provider: "google" }), {
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
          "https://generativelanguage.googleapis.com/v1beta/models/argon:streamGenerateContent?alt=sse",
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
        model: "argon",
        requestType: "agent",
        userAgent: "antigravity",
        request: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          labels: { model_enum: "MODEL_ARGON" },
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
