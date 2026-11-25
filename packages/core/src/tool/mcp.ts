export * as McpTool from "./mcp.js"

import { ToolFailure } from "@opencode/ai"
import { McpEvent } from "@opencode/schema/mcp-event"
import { MAX_DIRECT_TOOL_NAME_LENGTH, PROVIDER_SAFE_TOOL_NAME } from "@opencode/schema/tool"
import { createHash } from "node:crypto"
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  type JsonSchema,
  Layer,
  Option,
  PubSub,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { extension } from "mime-types"
import path from "path"
import { isRecord } from "@opencode/ai/utils/record"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Location } from "../location.js"

import { Mcp } from "../mcp/index.js"
import { Mime } from "../mime.js"
import { Permission } from "../permission.js"
import { SecretFile } from "../secret-file.js"
import { SessionExternalWait } from "../session/external-wait.js"
import { SessionStore } from "../session/store.js"
import { Tool } from "../tool.js"
import { ToolOutput } from "../tool-output.js"
import { stringify } from "../tool/runtime.js"
import { ReadToolFileSystem } from "./read-filesystem.js"
import { SensitiveInput } from "./sensitive-input.js"

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

// The trusted host's reserved permission namespace. Grants such as `t3-code_*` must only ever match
// tools of an attachment the server verified as the host, never a server that merely uses the name.
const HOST_NAMESPACE = "t3-code"
// `m_` + 16 hex digest + `_`.
const ALIAS_PREFIX_LENGTH = 19
const ALIAS_TOOL_SLICE = MAX_DIRECT_TOOL_NAME_LENGTH - ALIAS_PREFIX_LENGTH - 9

const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

/**
 * Registry namespace and permission action names for MCP tools.
 */
export const namespace = (server: string) => sanitize(server)
export const name = (server: string, tool: string) => `${namespace(server)}_${sanitize(tool)}`

/**
 * The name a direct (non Code Mode) MCP tool is advertised under. Provider-safe names are kept as is;
 * longer or non-letter-initial names get a deterministic alias, stable across resumes, per server and tool.
 */
export const directName = (server: string, tool: string) => {
  const base = name(server, tool)
  if (PROVIDER_SAFE_TOOL_NAME.test(base)) return base
  const prefix = `m_${digest(server).slice(0, 16)}_`
  const safe = sanitize(tool)
  if (prefix.length + safe.length <= MAX_DIRECT_TOOL_NAME_LENGTH) return `${prefix}${safe}`
  return `${prefix}${safe.slice(0, ALIAS_TOOL_SLICE)}_${digest(tool).slice(0, 8)}`
}

type PolicyTool = Pick<Mcp.Tool, "server" | "name" | "trustedHost" | "permissionNamespace">

/**
 * The permission action guarding an MCP tool, used for both catalog visibility and the call-time check.
 * Untrusted servers whose names claim the host namespace are moved to an unprivileged `mcp_` prefix.
 */
export const permissionAction = (tool: PolicyTool) => {
  if (isHostTool(tool)) return `${HOST_NAMESPACE}_${sanitize(tool.name)}`
  // Case-insensitive demotion matches Wildcard.match's case-insensitive behavior on win32.
  if (namespace(tool.server).toLowerCase().startsWith(HOST_NAMESPACE)) return `mcp_${name(tool.server, tool.name)}`
  return name(tool.server, tool.name)
}

const isHostTool = (tool: PolicyTool) => tool.trustedHost === true && tool.permissionNamespace === HOST_NAMESPACE

/**
 * Input keys carrying secrets. Only the verified host's `request_secret` qualifies; external configuration
 * cannot set this, because declaring sensitive inputs also changes how a tool is exposed.
 */
export const sensitiveInputs = (tool: PolicyTool) =>
  isHostTool(tool) && tool.name === "request_secret" ? ["value"] : undefined

/** Configured servers and verified host attachments may opt out of Code Mode; names never grant it. */
export const isCodeMode = (tool: Pick<Mcp.Tool, "codemode">) => tool.codemode ?? true

/** The registry ID a discovered MCP tool is registered under. */
export const registryID = (tool: Pick<Mcp.Tool, "server" | "name" | "codemode">) =>
  isCodeMode(tool) ? name(tool.server, tool.name) : directName(tool.server, tool.name)

export interface Interface {
  /** Wait for the initial MCP tool registration to settle. */
  readonly flush: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/McpTool") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const tools = yield* Tool.Service
    const bus = yield* Bus.Service
    const location = yield* Location.Service
    const permission = yield* Permission.Service
    const toolOutput = yield* ToolOutput.Service
    const sessions = yield* SessionStore.Service
    const config = yield* Config.Service
    const secretFiles = yield* SecretFile.Service
    const lock = Semaphore.makeUnsafe(1)
    let discovered: Mcp.Tool[] = []
    let collisions: string[] = []
    let sensitiveCodeMode: string[] = []
    let seen = 0
    let reconciled = 0
    // The change count whose reconcile failed; flush skips reconciling again until a new change arrives.
    let failed: number | undefined
    let initialReported = false

    // Servers announce tools in bursts and each read loads the whole catalog, so settle and refresh
    // once. Listen synchronously before initial discovery so `seen` updates before `bus.publish` returns.
    // `subscribe()` delivers asynchronously and cannot provide that barrier, so this keeps `listen`.
    const changes = yield* PubSub.sliding<void>(1)
    const unsubscribe = yield* bus.listen((event) => {
      if (event.type !== McpEvent.ToolsChanged.type) return Effect.void
      // An event without an envelope location came from outside any Location context, such as a host
      // attachment, and cannot be attributed elsewhere; refresh this Location's catalog anyway.
      const origin = event.location
      if (origin && (origin.directory !== location.directory || origin.workspaceID !== location.workspaceID))
        return Effect.void
      seen += 1
      return PubSub.publish(changes, undefined).pipe(Effect.asVoid)
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    const logCollisions = Effect.suspend(() =>
      Effect.all(
        [
          collisions.length === 0
            ? Effect.void
            : Effect.logWarning("Skipping MCP tools whose advertised names collide with registered tools", {
                tools: collisions,
              }),
          sensitiveCodeMode.length === 0
            ? Effect.void
            : Effect.logWarning("Skipping MCP tools that take secrets but are configured for Code Mode", {
                tools: sensitiveCodeMode,
              }),
        ],
        { discard: true },
      ),
    )

    // Host delegation spawns agents outside the subagent tool, so it must respect the same ceilings:
    // the caller's `subagent` permission and the configured nesting depth.
    const assertDelegation = Effect.fnUntraced(function* (context: Tool.Context) {
      yield* permission.assert({
        action: "subagent",
        resources: ["*"],
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
      })
      const limit = Config.latest(yield* config.entries(), "experimental")?.subagent_depth ?? 3
      const depth = yield* ancestry(context.sessionID)
      if (depth >= limit)
        return yield* new ToolFailure({
          message: `Subagent depth limit reached (${limit}). Increase "experimental.subagent_depth" to allow nested subagents.`,
        })
    })

    const ancestry = Effect.fnUntraced(function* (sessionID: Tool.Context["sessionID"]) {
      let current = yield* sessions.get(sessionID)
      let depth = 0
      while (current?.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      return depth
    })

    // Register once after initial discovery; only subsequent updates need a debounced reload.
    const initial = yield* lock
      .withPermit(
        Effect.gen(function* () {
          const target = seen
          discovered = yield* mcp.tools()
          yield* tools.transform((editor) => {
            collisions = []
            sensitiveCodeMode = []
            // Verified host tools claim their advertised names first so later clients cannot shadow them.
            const ordered = discovered.toSorted(
              (left, right) => Number(right.trustedHost === true) - Number(left.trustedHost === true),
            )
            const advertised = new Map<string, string>()
            for (const tool of ordered) {
              const id = registryID(tool)
              const canonical = `${tool.server}\0${tool.name}`
              const owner = advertised.get(id)
              if (owner === undefined ? editor.get(id) !== undefined : owner !== canonical) {
                collisions.push(`${tool.server}/${tool.name} -> ${id}`)
                continue
              }
              const codemode = isCodeMode(tool)
              const sensitive = sensitiveInputs(tool)
              if (sensitive && codemode) {
                sensitiveCodeMode.push(`${tool.server}/${tool.name}`)
                continue
              }
              advertised.set(id, canonical)
              const action = permissionAction(tool)
              const direct = !codemode && id !== name(tool.server, tool.name)
              const delegation = isHostTool(tool) && tool.name === "delegate_task"
              const secretRequest = sensitive !== undefined
              // Worktree handoff ends the turn physically; run it only once the stream and siblings finished.
              const deferred = isHostTool(tool) && tool.name === "t3_worktree_handoff"
              editor.add({
                // Aliased direct tools register under their alias so the registry ID is the advertised name.
                name: direct ? id : tool.name,
                options: {
                  ...(direct ? {} : { namespace: namespace(tool.server) }),
                  codemode,
                  permission: action,
                  ...(sensitive ? { sensitiveInputs: sensitive } : {}),
                  ...(deferred ? { deferred: "after-stream-and-siblings" as const } : {}),
                },
                description: tool.description ?? "",
                input: (tool.inputSchema ?? { type: "object", properties: {} }) as JsonSchema.JsonSchema,
                output: (tool.outputSchema ?? {}) as JsonSchema.JsonSchema,
                execute: (input, context) =>
                  Effect.gen(function* () {
                    yield* permission.assert({
                      action,
                      resources: ["*"],
                      save: ["*"],
                      metadata: { input: SensitiveInput.redact(input ?? {}, sensitive) },
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: {
                        type: "tool",
                        messageID: context.messageID,
                        id: context.id,
                      },
                    })
                    if (delegation) yield* assertDelegation(context)
                    const args = (input ?? {}) as Record<string, unknown>
                    // Progress reaches the durable event stream through the caller's context.
                    const runFork = Effect.runForkWith(yield* Effect.context<never>())
                    const result = yield* mcp
                      .callTool({
                        server: tool.server,
                        name: tool.name,
                        args,
                        sessionID: context.sessionID,
                        onProgress: (progress) => runFork(context.progress(progress).pipe(Effect.ignore)),
                      })
                      .pipe(
                        Effect.catchTags({
                          "MCP.NotFoundError": (error) =>
                            new ToolFailure({ message: `MCP server "${error.server}" is not available` }),
                          "MCP.ToolCallError": (error) => new ToolFailure({ message: error.message }),
                        }),
                      )
                    if (result.isError) {
                      const text = result.content
                        .flatMap((part) => (part.type === "text" ? [part.text] : []))
                        .join("\n")
                        .trim()
                      // A server can describe the failure only in structured content; keep it verbatim.
                      const structured =
                        result.structured === undefined
                          ? undefined
                          : `Structured error data:\n${stringify(result.structured)}`
                      return yield* new ToolFailure({
                        message: [text || "MCP tool returned an error", ...(structured ? [structured] : [])].join(
                          "\n\n",
                        ),
                      })
                    }
                    // Only the verified host may change wait state, so an impostor cannot mask real waits.
                    const externalWaits = yield* Effect.serviceOption(SessionExternalWait.Service)
                    if (Option.isSome(externalWaits) && isHostTool(tool))
                      yield* trackExternalWait(
                        externalWaits.value,
                        tool,
                        args,
                        result,
                        context.sessionID,
                        Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
                      )
                    const content = yield* Effect.forEach(result.content, (part) => toContent(part, toolOutput))
                    const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
                    // Results stay intact: secret references and file/FIFO paths are opaque handles the model needs.
                    // Registering `delivery: "fifo"` blocks `read`/`grep` and keeps `SecretFile.readSecretBytes`
                    // from opening or draining one-shot pipes via `stat`. This prevents accidental tool reads at
                    // the application boundary; OS-level sandboxing of child commands remains outside this layer.
                    if (secretRequest && isRecord(input) && (input.delivery === "file" || input.delivery === "fifo"))
                      yield* Effect.forEach(
                        deliveredFiles(result.structured, text),
                        (file) => secretFiles.register(file, context.sessionID),
                        { discard: true },
                      )
                    const output = () => {
                      if (result.structured !== undefined) return result.structured
                      if (text === "") return null
                      // Agents assume JSON returned as text is already an object, so parse it when the server declares no schema.
                      if (tool.outputSchema === undefined && (text.startsWith("{") || text.startsWith("[")))
                        return Option.getOrElse(decodeJson(text), () => text)
                      return text
                    }
                    return {
                      output: output(),
                      ...(content.length === 0 ? {} : { content }),
                    }
                  }).pipe(
                    Effect.mapError((error) => {
                      if (error instanceof ToolFailure) return error
                      if (error instanceof Permission.BlockedError)
                        return new ToolFailure({ message: error.message, error })
                      if (error instanceof Permission.CorrectedError)
                        return new ToolFailure({ message: error.feedback, error })
                      return new ToolFailure({ message: `Unable to execute ${id}`, error })
                    }),
                  ),
              })
            }
          })
          reconciled = Math.max(reconciled, target)
          yield* logCollisions
        }),
      )
      .pipe(Effect.forkScoped)
    const reconcile = lock.withPermit(
      Effect.gen(function* () {
        const target = seen
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            discovered = yield* mcp.tools()
            yield* tools.reload()
          }),
        )
        if (Exit.isFailure(exit)) {
          if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause)
          failed = target
          return yield* Effect.logError("MCP tool reconcile failed", { cause: Cause.pretty(exit.cause) })
        }
        failed = undefined
        reconciled = Math.max(reconciled, target)
        yield* logCollisions
      }),
    )

    const updates = yield* PubSub.subscribe(changes)
    yield* Stream.fromSubscription(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => reconcile),
      Effect.forkScoped({ startImmediately: true }),
    )
    const flush = Effect.gen(function* () {
      const exit = yield* Fiber.await(initial)
      if (Exit.isFailure(exit) && !initialReported) {
        initialReported = true
        yield* Effect.logError("Initial MCP tool registration failed", { cause: Cause.pretty(exit.cause) })
      }
      if (reconciled < seen && failed !== seen) yield* reconcile
    })
    return Service.of({ flush })
  }),
)

/** Prefers structured content; falls back to JSON text a server sends without an output schema. */
const resultRecord = (result: Mcp.ToolResult) => {
  if (result.structured !== undefined) return isRecord(result.structured) ? result.structured : {}
  const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
  const parsed = Option.getOrUndefined(decodeJson(text))
  return isRecord(parsed) ? parsed : {}
}

/**
 * Keeps durable external-wait leases in step with the verified host's own async tools. Each wait is a
 * bounded lease, so an unreported completion still expires instead of pinning a goal forever.
 */
const trackExternalWait = Effect.fnUntraced(function* (
  waits: SessionExternalWait.Interface,
  tool: Pick<Mcp.Tool, "server" | "name">,
  input: Record<string, unknown>,
  result: Mcp.ToolResult,
  sessionID: Tool.Context["sessionID"],
  location: Location.Ref,
) {
  const record = resultRecord(result)
  switch (tool.name) {
    case "watch_pull_request": {
      const key = pullRequestWaitKey(input, record)
      yield* waits.register({
        sessionID,
        waitID: `pr-watch:${key}`,
        source: "pull_request_watch",
        server: tool.server,
        description: `Watching pull request ${key === "branch" ? "for current branch" : key}`,
        location,
      })
      return
    }
    case "unwatch_pull_request": {
      const key = pullRequestWaitKey(input, record)
      yield* waits.clear(sessionID, `pr-watch:${key}`, { location })
      return
    }
    case "delegate_task": {
      // `mode: "wait"` blocks the call itself, so there is no wait to register.
      if (input.mode === "wait") return
      if (typeof record.taskId !== "string") return
      yield* waits.register({
        sessionID,
        waitID: `delegate:${record.taskId}`,
        source: "delegated_task",
        server: tool.server,
        description: `Delegated task ${String(input.title ?? record.taskId)}`,
        location,
      })
      return
    }
    case "task_cancel": {
      if (typeof input.taskId !== "string") return
      yield* waits.clear(sessionID, `delegate:${input.taskId}`, { location })
      return
    }
    case "task_status": {
      if (typeof input.taskId !== "string") return
      if (!isTaskStatusTerminal(record)) return
      yield* waits.clear(sessionID, `delegate:${input.taskId}`, { location })
      return
    }
    case "t3_background_wait": {
      // `t3_background_wait` is a non-blocking state toggle: `waiting: true` keeps the thread in
      // Working after the call returns until a later `waiting: false` (or a response reporting
      // `waiting: false`) clears those task IDs.
      if (!Array.isArray(input.taskIds)) return
      if (input.waiting === false || record.waiting === false) {
        yield* Effect.forEach(input.taskIds, (id) => waits.clear(sessionID, `bg:${String(id)}`, { location }), {
          discard: true,
        })
        return
      }
      yield* Effect.forEach(
        input.taskIds,
        (id) =>
          waits.register({
            sessionID,
            waitID: `bg:${String(id)}`,
            source: "background_wait",
            server: tool.server,
            description: `Waiting on background task ${String(id)}`,
            location,
          }),
        { discard: true },
      )
      return
    }
    default:
      return
  }
})

/**
 * Canonicalizes a pull-request target across URL and `{ host, repository, number }` forms so
 * watch/unwatch pairs match regardless of input spelling and distinct repositories never collide.
 */
function pullRequestWaitKey(input: Record<string, unknown>, record: Record<string, unknown>): string {
  const url = typeof record.url === "string" ? record.url : typeof input.url === "string" ? input.url : undefined
  if (url) {
    try {
      const parsed = new URL(url)
      const host = parsed.hostname.toLowerCase()
      const match =
        /^\/(.+)\/-\/merge_requests\/(\d+)/i.exec(parsed.pathname) ??
        /^\/(.+)\/(?:pull|pulls|merge_requests)\/(\d+)/i.exec(parsed.pathname)
      if (match) {
        const prefix = host === "github.com" ? "" : `${host}/`
        return `${prefix}${match[1].replace(/^\/+|\/+$/g, "").toLowerCase()}#${match[2]}`
      }
      return `${host}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`
    } catch {
      return url
    }
  }
  const repository =
    typeof record.repository === "string"
      ? record.repository
      : typeof input.repository === "string"
        ? input.repository
        : undefined
  const number =
    typeof record.number === "number" || typeof record.number === "string"
      ? String(record.number)
      : typeof input.number === "number" || typeof input.number === "string"
        ? String(input.number)
        : undefined
  const rawHost = typeof record.host === "string" ? record.host : typeof input.host === "string" ? input.host : undefined
  const host = rawHost?.toLowerCase()
  if (repository && number) {
    const prefix = host && host !== "github.com" ? `${host}/` : ""
    return `${prefix}${repository.replace(/^\/+|\/+$/g, "").toLowerCase()}#${number}`
  }
  if (number) return `number:${number}`
  return "branch"
}

/**
 * T3 Code's `task_status` uses `workState` (`working` | `waiting_for_children` | `result_available`)
 * and `hasPendingChildRuns`; a finished turn with live children is not yet done. Falls back to
 * `status` when `workState` is absent.
 */
function isTaskStatusTerminal(record: Record<string, unknown>) {
  if (record.hasPendingChildRuns === true) return false
  if (record.workState === "working" || record.workState === "waiting_for_children") return false
  if (record.workState === "result_available") return true
  return record.status === "completed" || record.status === "failed" || record.status === "cancelled"
}

const isAbsolutePath = (value: string) => path.posix.isAbsolute(value) || path.win32.isAbsolute(value)

const PLAIN_TEXT_PATH_PATTERN =
  /(?:^|[\s(=,])(?:"((?:[A-Za-z]:[\\/]|\\\\[^\\/"'`\r\n]+[\\/]|\/[^\s"'`\r\n])[^"\r\n]*)"|'((?:[A-Za-z]:[\\/]|\\\\[^\\/"'`\r\n]+[\\/]|\/[^\s"'`\r\n])[^'\r\n]*)'|`((?:[A-Za-z]:[\\/]|\\\\[^\\/"'`\r\n]+[\\/]|\/[^\s"'`\r\n])[^`\r\n]*)`)|(?:^|[\s"'`(=,])((?:[A-Za-z]:[\\/]|\\\\[^\s\\/"'`)]+[\\/]|\/)[^\s"'`)]+)/g

// The host reports a delivered file in structured content or JSON text; either carries an absolute path.
export function deliveredFiles(structured: unknown, text: string) {
  const parsed = structured ?? Option.getOrUndefined(decodeJson(text))
  const record = isRecord(parsed) ? parsed : {}
  const fields = ["path", "file", "filePath"].flatMap((key) => {
    const value = record[key]
    return typeof value === "string" && isAbsolutePath(value) ? [value] : []
  })
  if (fields.length > 0) return fields
  const matches = Array.from(
    text.matchAll(PLAIN_TEXT_PATH_PATTERN),
    (match) => match[1] ?? match[2] ?? match[3] ?? match[4],
  ).filter((value): value is string => value !== undefined && value.length > 1)
  return Array.from(new Set(matches))
}

// Only media the read tool also accepts is sent inline, and only while it fits the same ingest budget the
// read tool enforces; larger payloads would bloat durable content and every later request. Other types
// would also fail request lowering on every later turn.
const toContent = Effect.fnUntraced(function* (part: Mcp.ToolResultContent, toolOutput: ToolOutput.Interface) {
  if (part.type === "text") return { type: "text" as const, text: part.text }
  const mime = Mime.normalize(part.mimeType)
  const label = part.uri ?? "content"
  const bytes = Buffer.from(part.data, "base64")
  if (ReadToolFileSystem.MEDIA_MIMES.has(mime)) {
    if (bytes.byteLength <= ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES)
      return { type: "file" as const, uri: `data:${mime};base64,${part.data}`, mime }
    const file = yield* toolOutput.save(bytes, `.${extension(mime) || "bin"}`)
    return {
      type: "text" as const,
      text: `[Media resource ${label} (${mime}, ${bytes.byteLength} bytes) is too large to attach inline (limit ${ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES} bytes) and was saved to ${file}]`,
    }
  }
  if (Mime.isTextual(mime))
    return { type: "text" as const, text: `[Resource ${label} (${mime})]\n${bytes.toString("utf8")}` }
  const ext = extension(mime)
  const file = yield* toolOutput.save(bytes, ext ? `.${ext}` : "")
  return {
    type: "text" as const,
    text: `[Binary resource ${label} (${mime}, ${bytes.byteLength} bytes) saved to ${file}]`,
  }
})

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Tool.node,
    Mcp.node,
    Bus.node,
    Location.node,
    Permission.node,
    ToolOutput.node,
    SessionStore.node,
    Config.node,
    SecretFile.node,
    SessionExternalWait.node,
  ],
})
