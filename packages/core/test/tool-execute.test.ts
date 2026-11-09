import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CodeModeTool } from "@opencode/core/codemode/tool"
import { Permission } from "@opencode/core/permission"
import { Tool } from "@opencode/core/tool"
import { execute } from "@opencode/core/tool/runtime"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import type { Info } from "@opencode/schema/tool"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { it } from "./lib/effect"
import { permissionService } from "./lib/permission"

const context = {
  sessionID: Session.ID.make("ses_execute"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_execute"),
  id: Tool.CallID.make("call_execute"),
  progress: () => Effect.void,
}

const allowAll = permissionService({ assert: () => Effect.void })

const createCodeMode = (tools: ReadonlyMap<string, Info>, permission = allowAll) =>
  CodeModeTool.create({ tools }, (_, tool, input, context) => execute(tool, input, context), permission)

test("execute describes invariant Code Mode behavior", () => {
  expect(createCodeMode(new Map()).description).toBe(
    [
      "Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.",
      "`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable; all other external access goes through `tools`.",
      "Within `{ code }`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by the `search` function. Inside `{ code }`, ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.",
      'Call tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>["tool-name"](input)`.',
      "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.",
      "Await every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.allSettled`.",
    ].join("\n"),
  )
})

test("execute rejects filesystem fetches", async () => {
  const result = await Effect.runPromise(
    createCodeMode(new Map()).execute({ code: 'return await fetch("file:///blocked.txt")' }, context),
  )

  expect(result.output.error).toBe(true)
  expect(result.output.output).toContain("fetch cannot be used for filesystem access.")
})

describe("fetch permissions", () => {
  const hits: Array<string> = []
  const received: Array<{ method: string; body: string; headers: Record<string, string> }> = []
  let server: ReturnType<typeof Bun.serve>
  let other: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    const inspect = async (request: Request) => {
      received.push({
        method: request.method,
        body: await request.text(),
        headers: Object.fromEntries(request.headers),
      })
      return new Response("ok")
    }
    other = Bun.serve({ port: 0, fetch: inspect })
    server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url)
        hits.push(`${request.method} ${url.pathname}`)
        if (url.pathname === "/redirect") return Response.redirect(`${url.origin}/blocked`, 302)
        if (url.pathname === "/forward")
          return new Response(null, {
            status: Number(url.searchParams.get("status")),
            headers: { location: url.searchParams.get("target") ?? "/inspect" },
          })
        if (url.pathname === "/loop") return Response.redirect(`${url.origin}/loop`, 307)
        if (url.pathname === "/inspect") return inspect(request)
        return new Response("ok")
      },
    })
  })
  afterAll(() => Promise.all([server.stop(true), other.stop(true)]))

  test("fetch asks the webfetch permission for its URL as the execute call", async () => {
    hits.length = 0
    const asked: Array<Permission.AssertInput> = []
    const url = `${server.url.origin}/allowed`
    const result = await Effect.runPromise(
      createCodeMode(
        new Map(),
        permissionService({ assert: (input) => Effect.sync(() => void asked.push(input)) }),
      ).execute({ code: `return await (await fetch("${url}", { method: "POST" })).text()` }, context),
    )

    expect(result.output.output).toBe("ok")
    expect(hits).toEqual(["POST /allowed"])
    expect(asked).toEqual([
      {
        action: "webfetch",
        resources: [url],
        save: ["*"],
        metadata: { method: "POST", url },
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      },
    ])
  })

  test("a redirect to a URL denied for webfetch is never requested", async () => {
    hits.length = 0
    const denied = permissionService({
      assert: () => Effect.void,
      assertNotDenied: (input) =>
        Effect.fail(new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources })),
    })
    const result = await Effect.runPromise(
      createCodeMode(new Map(), denied).execute(
        { code: `try { await fetch("${server.url.origin}/redirect") } catch (e) { return e.message }` },
        context,
      ),
    )

    expect(result.output.output).toContain("Permission denied")
    expect(hits).toEqual(["GET /redirect"])
  })

  test("fetch matches rules without the fragment and rejects credentials in the URL", async () => {
    hits.length = 0
    const asked: Array<ReadonlyArray<string>> = []
    const result = await Effect.runPromise(
      createCodeMode(
        new Map(),
        permissionService({ assert: (input) => Effect.sync(() => void asked.push(input.resources)) }),
      ).execute(
        {
          code: `await fetch("${server.url.origin}/allowed#top"); try { await fetch("${server.url.protocol}//user@${server.url.host}/") } catch (e) { return e.message }`,
        },
        context,
      ),
    )

    expect(result.output.output).toBe("fetch cannot be used with credentials in the URL.")
    expect(asked).toEqual([[`${server.url.origin}/allowed`]])
    expect(hits).toEqual(["GET /allowed"])
  })

  test("fetch matches the initial URL's spelling rather than a canonicalized URL", async () => {
    const asked: Permission.AssertInput[] = []
    const url = `HTTP://${server.url.host}/allowed`
    const result = await Effect.runPromise(
      createCodeMode(
        new Map(),
        permissionService({ assert: (input) => Effect.sync(() => void asked.push(input)) }),
      ).execute({ code: `return (await fetch("${url}#top")).status` }, context),
    )

    expect(result.output.output).toBe("200")
    expect(asked.map((input) => input.resources)).toEqual([[url]])
  })

  test("a rejection with feedback reaches the program as the error message", async () => {
    hits.length = 0
    const url = `${server.url.origin}/corrected`
    const corrected = permissionService({
      assert: () => Effect.fail(new Permission.CorrectedError({ feedback: "use the docs site instead" })),
    })
    const result = await Effect.runPromise(
      createCodeMode(new Map(), corrected).execute(
        { code: `try { await fetch("${url}") } catch (e) { return e.message }` },
        context,
      ),
    )

    expect(result.output.output).toBe(`The user rejected fetching ${url}: use the docs site instead`)
    expect(hits).toEqual([])
  })

  test("a URL denied for webfetch is never requested and rejects like a failed fetch", async () => {
    hits.length = 0
    const url = `${server.url.origin}/denied`
    const denied = permissionService({
      assert: (input) =>
        Effect.fail(new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources })),
    })
    const result = await Effect.runPromise(
      createCodeMode(new Map(), denied).execute(
        { code: `const [denied] = await Promise.allSettled([fetch("${url}")]); return denied.status` },
        context,
      ),
    )

    expect(result.output.output).toBe("rejected")
    expect(hits).toEqual([])
  })

  test.each(
    [false, true].flatMap((crossOrigin) =>
      [
        { status: 301, method: "POST", next: "GET" },
        { status: 302, method: "POST", next: "GET" },
        { status: 303, method: "PUT", next: "GET" },
        { status: 303, method: "HEAD", next: "HEAD" },
        { status: 302, method: "PUT", next: "PUT" },
        { status: 307, method: "POST", next: "POST" },
        { status: 308, method: "PUT", next: "PUT" },
      ].map((scenario) => ({ ...scenario, crossOrigin })),
    ),
  )(
    "redirect $status $method, cross-origin=$crossOrigin, preserves HTTP and credential semantics",
    async (scenario) => {
      received.length = 0
      const checked: Permission.AssertInput[] = []
      const target = scenario.crossOrigin ? `${other.url.origin}/inspect` : "/inspect"
      const url = `${server.url.origin}/forward?status=${scenario.status}&target=${encodeURIComponent(target)}`
      const headers = {
        authorization: "Bearer test-only",
        cookie: "session=test-only",
        "proxy-authorization": "Basic test-only",
        "content-type": "text/plain",
        "x-request-id": "preserved",
      }
      const result = await Effect.runPromise(
        createCodeMode(
          new Map(),
          permissionService({
            assert: () => Effect.void,
            assertNotDenied: (input) => Effect.sync(() => void checked.push(input)),
          }),
        ).execute(
          {
            code: `return (await fetch(${JSON.stringify(url)}, ${JSON.stringify({
              method: scenario.method,
              headers,
              ...(scenario.method === "HEAD" ? {} : { body: "payload" }),
            })})).status`,
          },
          context,
        ),
      )

      expect(result.output.output).toBe("200")
      expect(received).toHaveLength(1)
      expect(received[0]?.method).toBe(scenario.next)
      expect(received[0]?.body).toBe(scenario.next === "GET" || scenario.next === "HEAD" ? "" : "payload")
      if (scenario.next === "GET") expect(received[0]?.headers["content-type"]).toBeUndefined()
      if (scenario.next !== "GET") expect(received[0]?.headers["content-type"]).toBe("text/plain")
      expect(received[0]?.headers["x-request-id"]).toBe("preserved")
      for (const name of ["authorization", "cookie", "proxy-authorization"] as const) {
        if (scenario.crossOrigin) expect(received[0]?.headers[name]).toBeUndefined()
        if (!scenario.crossOrigin) expect(received[0]?.headers[name]).toBe(headers[name])
      }
      expect(checked).toMatchObject([
        {
          action: "webfetch",
          resources: [new URL(target, server.url).href],
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.messageID, id: context.id },
        },
      ])
    },
  )

  test.each(["file:///blocked", "https://user@example.invalid/"])(
    "rejects unsafe redirect destination %s before permission checks or transport",
    async (target) => {
      hits.length = 0
      const checked: Permission.AssertInput[] = []
      const result = await Effect.runPromise(
        createCodeMode(
          new Map(),
          permissionService({
            assert: () => Effect.void,
            assertNotDenied: (input) => Effect.sync(() => void checked.push(input)),
          }),
        ).execute(
          {
            code: `return await fetch("${server.url.origin}/forward?status=302&target=${encodeURIComponent(target)}")`,
          },
          context,
        ),
      )

      expect(result.output.error).toBe(true)
      expect(result.output.output).toContain(
        target.startsWith("file:") ? "cannot follow a redirect to file:" : "cannot follow a redirect with credentials",
      )
      expect(checked).toEqual([])
      expect(hits).toHaveLength(1)
    },
  )

  test("bounds redirect loops", async () => {
    hits.length = 0
    const result = await Effect.runPromise(
      createCodeMode(
        new Map(),
        permissionService({ assert: () => Effect.void, assertNotDenied: () => Effect.void }),
      ).execute({ code: `return await fetch("${server.url.origin}/loop")` }, context),
    )

    expect(result.output.error).toBe(true)
    expect(result.output.output).toContain("Too many redirects (more than 20)")
    expect(hits).toHaveLength(21)
  })
})

it.effect("cached Code Mode runtimes keep permission authority and identity local to concurrent executions", () =>
  Effect.gen(function* () {
    const inventory = { tools: new Map<string, Info>() }
    const release = yield* Deferred.make<void>()
    const contexts = [
      context,
      {
        ...context,
        sessionID: Session.ID.make("ses_other"),
        agent: Agent.ID.make("other"),
        messageID: SessionMessage.ID.make("msg_other"),
        id: Tool.CallID.make("call_other"),
      },
    ]
    const executions = yield* Effect.forEach(contexts, (context) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const asked: Permission.AssertInput[] = []
        const tool = CodeModeTool.create(
          inventory,
          (_, tool, input, context) => execute(tool, input, context),
          permissionService({
            assert: (input) =>
              Effect.gen(function* () {
                asked.push(input)
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                return yield* new Permission.BlockedError({
                  rules: [],
                  permission: input.action,
                  resources: input.resources,
                })
              }),
          }),
        )
        return {
          context,
          entered,
          asked,
          execution: tool.execute({ code: 'return await fetch("https://example.invalid/blocked")' }, context),
        }
      }),
    )
    const fiber = yield* Effect.all(
      executions.map((item) => item.execution),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild)
    yield* Effect.all(executions.map((item) => Deferred.await(item.entered)))
    yield* Deferred.succeed(release, undefined)
    const results = yield* Fiber.join(fiber)

    expect(results.every((result) => result.output.error)).toBe(true)
    executions.forEach((item) =>
      expect(item.asked).toMatchObject([
        {
          sessionID: item.context.sessionID,
          agent: item.context.agent,
          source: { type: "tool", messageID: item.context.messageID, id: item.context.id },
        },
      ]),
    )
  }),
)

it.live("interrupting Code Mode fetch cancels an in-flight response body", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<void>()
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("waiting"))
                  Effect.runSync(Deferred.succeed(started, undefined))
                },
                cancel() {
                  Effect.runSync(Deferred.succeed(cancelled, undefined))
                },
              }),
            ),
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const fiber = yield* createCodeMode(new Map())
      .execute({ code: `return await (await fetch("${server.url.origin}/stream")).text()` }, context)
      .pipe(Effect.forkChild)
    yield* Deferred.await(started)
    expect(yield* Deferred.isDone(cancelled)).toBe(false)
    yield* Fiber.interrupt(fiber)
    yield* Deferred.await(cancelled).pipe(Effect.timeout("2 seconds"))
  }),
)

it.live("interrupting Code Mode fetch aborts a request waiting for response headers", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<void>()
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) => {
            request.signal.addEventListener("abort", () => Effect.runSync(Deferred.succeed(cancelled, undefined)), {
              once: true,
            })
            Effect.runSync(Deferred.succeed(started, undefined))
            return new Promise<Response>(() => {})
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const fiber = yield* createCodeMode(new Map())
      .execute({ code: `return await fetch("${server.url.origin}/waiting")` }, context)
      .pipe(Effect.forkChild)
    yield* Deferred.await(started)
    expect(yield* Deferred.isDone(cancelled)).toBe(false)
    yield* Fiber.interrupt(fiber)
    yield* Deferred.await(cancelled).pipe(Effect.timeout("2 seconds"))
  }),
)

test("canonical execution distinguishes declared, model-only, and raw schema outputs", async () => {
  const declared: Info = {
    name: "declared",
    description: "Declared",
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
    execute: ({ value }) => Effect.succeed({ output: { value } }),
  }
  const modelOnlyInput = Schema.Struct({})
  const modelOnly = {
    name: "model_only",
    description: "Model only",
    input: modelOnlyInput,
    execute: () => Effect.succeed({ content: "visible only", metadata: { kind: "model" } }),
  } satisfies Info<typeof modelOnlyInput, undefined>
  const raw: Info = {
    name: "raw",
    description: "Raw",
    input: {},
    output: {},
    execute: (input) => Effect.succeed({ output: input, content: "raw" }),
  }

  expect(await Effect.runPromise(execute(declared, { value: "encoded" }, context))).toEqual({
    output: { value: "encoded" },
    content: [{ type: "text", text: '{"value":"encoded"}' }],
  })
  expect(await Effect.runPromise(execute(modelOnly, {}, context))).toEqual({
    output: undefined,
    content: [{ type: "text", text: "visible only" }],
    metadata: { kind: "model" },
  })
  expect(await Effect.runPromise(execute(raw, { unchecked: true }, context))).toEqual({
    output: { unchecked: true },
    content: [{ type: "text", text: "raw" }],
  })
})

test("declared outputs cannot bypass validation and raw outputs stay JSON-compatible", async () => {
  const missing: Info = {
    name: "missing",
    description: "Missing output",
    input: Schema.Struct({}),
    output: Schema.String,
    execute: () => Effect.succeed({ content: "not an output" }),
  }
  const invalid: Info = {
    name: "invalid",
    description: "Invalid raw output",
    input: {},
    output: {},
    execute: () => Effect.succeed({ output: 1n, content: "not JSON" }),
  }

  expect((await Effect.runPromiseExit(execute(missing, {}, context))).toString()).toContain(
    "Tool did not return its declared output",
  )
  expect((await Effect.runPromiseExit(execute(invalid, {}, context))).toString()).toContain(
    "Tool returned a non-JSON value",
  )
})

test("foreign typed failures settle as Tool.Error at the untrusted boundary", async () => {
  class ForeignFailure extends Schema.TaggedError<ForeignFailure>()("Plugin.ForeignFailure", {
    message: Schema.String,
  }) {}
  const lying: Info = {
    name: "lying",
    description: "Fails with a non-Tool.Error typed failure",
    input: Schema.Struct({}),
    execute: () => new ForeignFailure({ message: "transport died" }) as never,
  }

  const error = await Effect.runPromise(execute(lying, {}, context).pipe(Effect.flip))
  expect(error).toBeInstanceOf(Tool.Error)
  expect(error.message).toBe("transport died")
})

test("execute supports callable namespace tools", async () => {
  const callable: Info = {
    name: "admin",
    description: "Administer Slack",
    input: Schema.Struct({}),
    output: Schema.String,
    options: { namespace: "slack" },
    execute: () => Effect.succeed({ output: "admin" }),
  }
  const child: Info = {
    name: "create",
    description: "Create a Slack resource",
    input: Schema.Struct({}),
    output: Schema.String,
    options: { namespace: "slack.admin" },
    execute: () => Effect.succeed({ output: "created" }),
  }
  const codeMode = createCodeMode(
    new Map([
      ["slack_admin", callable],
      ["slack_admin_create", child],
    ]),
  )
  const result = await Effect.runPromise(
    codeMode.execute({ code: "return [await tools.slack.admin({}), await tools.slack.admin.create({})]" }, context),
  )

  expect(result.metadata).toEqual({
    toolCalls: [
      { tool: "slack.admin", status: "completed" },
      { tool: "slack.admin.create", status: "completed" },
    ],
  })
  expect(result.content).toEqual([{ type: "text", text: '[\n  "admin",\n  "created"\n]' }])
})

test("executions share the prepared runtime of an inventory while keeping per-call state", async () => {
  let conversions = 0
  const echo: Info = {
    name: "echo",
    description: "Echo a value",
    input: {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => {
            conversions++
            return { type: "object", properties: { value: { type: "string" } }, required: ["value"] }
          },
          output: () => ({}),
        },
      },
    },
    execute: (input, context) => Effect.succeed({ content: `${context.id}:${(input as { value: string }).value}` }),
  }
  const inventory = { tools: new Map([["echo", echo]]) }
  const codeMode = CodeModeTool.create(inventory, (_, tool, input, context) => execute(tool, input, context), allowAll)
  const run = (id: string) => {
    const progress: Array<Tool.Metadata> = []
    return CodeModeTool.create(inventory, (_, tool, input, context) => execute(tool, input, context), allowAll)
      .execute(
        { code: `return await tools.echo({ value: "${id}" })` },
        { ...context, id: Tool.CallID.make(id), progress: (update) => Effect.sync(() => progress.push(update)) },
      )
      .pipe(Effect.map((result) => ({ output: result.output.output, progress })))
  }

  expect(CodeModeTool.catalog(inventory).tools).toHaveLength(1)
  const results = await Effect.runPromise(Effect.all([run("first"), run("second")], { concurrency: "unbounded" }))
  expect<unknown>(results).toEqual(
    ["first", "second"].map((id) => ({
      output: `${id}:${id}`,
      progress: [
        { toolCalls: [{ tool: "echo", status: "running", input: { value: id } }] },
        { toolCalls: [{ tool: "echo", status: "completed", input: { value: id } }] },
      ],
    })),
  )
  expect(
    (await Effect.runPromise(codeMode.execute({ code: 'return await tools.echo({ value: "x" })' }, context))).output
      .output,
  ).toBe("call_execute:x")
  expect(conversions).toBe(1)

  await Effect.runPromise(
    createCodeMode(new Map(inventory.tools)).execute({ code: 'return await tools.echo({ value: "next" })' }, context),
  )
  expect(conversions).toBe(2)
})
