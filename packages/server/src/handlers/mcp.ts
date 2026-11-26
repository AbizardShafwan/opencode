import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Mcp } from "@opencode/core/mcp/index"
import { PtyTicket } from "@opencode/core/pty/ticket"
import { ForbiddenError, McpServerNotFoundError } from "@opencode/protocol/errors"
import { MCP_HOST_TOKEN_HEADER } from "@opencode/protocol/groups/mcp"
import { PTY_CONNECT_TOKEN_HEADER, PTY_CONNECT_TOKEN_HEADER_VALUE } from "@opencode/protocol/groups/pty"
import { Effect, Queue } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Socket } from "effect/socket"
import { Api } from "../api"
import { CorsConfig, isAllowedRequestOrigin } from "../cors"
import { locationErrors, requestRef, response } from "../location"
import { TrustedHostConfig, hostPolicy, runtimeMcpHostPolicy } from "../trusted-host"
import { holdLocation, type Outbound, runPtySocket } from "./pty-socket"

const notFound = <A, R>(effect: Effect.Effect<A, Mcp.NotFoundError, R>) =>
  effect.pipe(Effect.mapError((error) => new McpServerNotFoundError({ server: error.server, message: error.message })))

export const McpHandler = HttpApiBuilder.group(Api, "server.mcp", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const cors = yield* CorsConfig
    const tickets = yield* PtyTicket.Service
    const trustedHost = yield* TrustedHostConfig

    return handlers
      .handle(
        "mcp.list",
        Effect.fn(function* () {
          const service = yield* Mcp.Service
          return yield* response(service.servers())
        }),
      )
      .handle(
        "mcp.add",
        Effect.fn(function* (ctx) {
          const service = yield* Mcp.Service
          const policy = runtimeMcpHostPolicy({ name: ctx.params.server, config: ctx.payload.config }, trustedHost)
          yield* service.add(ctx.params.server, ctx.payload.config, policy)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.remove",
        Effect.fn(function* (ctx) {
          const service = yield* Mcp.Service
          yield* notFound(service.remove(ctx.params.server))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.connect",
        Effect.fn(function* (ctx) {
          const service = yield* Mcp.Service
          yield* notFound(service.connect(ctx.params.server))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.disconnect",
        Effect.fn(function* (ctx) {
          const service = yield* Mcp.Service
          yield* notFound(service.disconnect(ctx.params.server))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.resource.catalog",
        Effect.fn(function* () {
          const service = yield* Mcp.Service
          return yield* response(service.resourceCatalog())
        }),
      )
      .handle(
        "mcp.clientToken",
        Effect.fn(function* (ctx) {
          // The custom header forces a CORS preflight, so cross-origin pages cannot mint tickets.
          if (
            ctx.headers[PTY_CONNECT_TOKEN_HEADER] !== PTY_CONNECT_TOKEN_HEADER_VALUE ||
            !isAllowedRequestOrigin(ctx.request.headers.origin, ctx.request.headers.host, cors)
          )
            return yield* new ForbiddenError({ message: "Invalid client MCP connect token request" })
          const location = yield* Location.Service
          const policy = hostPolicy({ token: ctx.headers[MCP_HOST_TOKEN_HEADER], name: ctx.query.name }, trustedHost)
          return yield* response(
            tickets.issue({
              mcpClient: ctx.query.name,
              ...(policy === undefined ? {} : { mcpPolicy: policy }),
              directory: location.directory,
              workspaceID: location.workspaceID,
            }),
          )
        }),
      )
      .handleRaw(
        "mcp.client",
        Effect.fn("McpHandler.client")(function* (ctx) {
          if (!isAllowedRequestOrigin(ctx.request.headers.origin, ctx.request.headers.host, cors))
            return HttpServerResponse.empty({ status: 403 })

          const name = ctx.query.name
          const ref = LocationServiceMap.canonical(requestRef(ctx.request))
          const ticket = ctx.query.ticket
            ? yield* tickets.consumeMcp({
                ticket: ctx.query.ticket,
                mcpClient: name,
                directory: ref.directory,
                workspaceID: ref.workspaceID,
              })
            : undefined
          if (ctx.query.ticket && !ticket) return HttpServerResponse.empty({ status: 403 })
          // Ticketed connections carry the policy proven when the ticket was minted; direct upgrades prove it here.
          const header = ctx.request.headers[MCP_HOST_TOKEN_HEADER]
          const policy = ctx.query.ticket
            ? ticket?.policy
            : hostPolicy({ token: typeof header === "string" ? header : undefined, name }, trustedHost)

          return yield* Effect.gen(function* () {
            const mcp = yield* Mcp.Service
            const { McpSocketClient } = yield* Effect.promise(() => import("@opencode/core/mcp/socket-client"))
            const socket = yield* Effect.orDie(ctx.request.upgrade)
            const outbox = yield* Queue.unbounded<Outbound>()
            yield* holdLocation(outbox)
            const state = { attached: false, disconnected: false }
            const transport = McpSocketClient.make({
              send: (text) => Queue.offerUnsafe(outbox, text),
              // A failed attach closes the transport before reporting the error; ignore that close so the
              // socket closes with 1011 below instead of a normal 1000.
              close: (code, reason) => {
                if (state.attached) Queue.offerUnsafe(outbox, new Socket.CloseEvent(code, reason))
              },
            })
            const decoder = new TextDecoder()
            // The attachment lives in this scope, so it ends with the socket.
            yield* mcp.attach(name, transport, policy).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  state.attached = true
                }),
              ),
              Effect.catch((error) =>
                state.disconnected
                  ? Effect.logInfo("client MCP disconnected during initialize", { name, error: error.message })
                  : Effect.logError("client MCP attach failed", { name, error: error.message }).pipe(
                      Effect.andThen(
                        Effect.sync(() => Queue.offerUnsafe(outbox, new Socket.CloseEvent(1011, "attach failed"))),
                      ),
                    ),
              ),
              Effect.forkScoped,
            )
            yield* runPtySocket({
              socket,
              outbox,
              // Frames should be text, but binary frames are accepted and decoded as UTF-8.
              onMessage: (message) =>
                Effect.sync(() => transport.deliver(typeof message === "string" ? message : decoder.decode(message))),
              detach: () => {
                state.disconnected = true
                transport.ended()
              },
            })
            return HttpServerResponse.empty()
          }).pipe(Effect.scoped, Effect.provide(locations.get(ref)), locationErrors)
        }),
      )
  }),
)
