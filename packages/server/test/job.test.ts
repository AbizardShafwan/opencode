import { expect } from "bun:test"
import { Job } from "@opencode/core/job"
import { Mcp } from "@opencode/core/mcp/index"
import { Session } from "@opencode/core/session"
import { SessionExternalWait } from "@opencode/core/session/external-wait"
import { SessionMessage } from "@opencode/core/session/message"
import { Job as JobSchema } from "@opencode/schema/job"
import { AbsolutePath } from "@opencode/schema/schema"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"

it.live("lists background jobs with session, kind, and descendant filters", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped("opencode-job-endpoints-")
    const other = yield* tmpdirScoped("opencode-job-other-")
    const context = yield* Layer.build(
      createRoutes({
        password: "secret",
        database: { path: ":memory:" },
        models: { fetch: false },
        fs: { filewatcher: false },
        config: { directory: tmp.path, project: false },
      }).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const jobs = Context.get(context, Job.Service)
    const sessions = Context.get(context, Session.Service)

    const parent = yield* sessions.create({
      location: { directory: AbsolutePath.make(tmp.path) },
      title: "parent",
    })
    const child = yield* sessions.create({
      parentID: parent.id,
      title: "child",
    })
    // Jobs from another location share the process-global registry but never this route's view.
    const elsewhere = yield* sessions.create({
      location: { directory: AbsolutePath.make(other.path) },
      title: "elsewhere",
    })

    const hold = yield* Deferred.make<string>()
    const parentShell = yield* jobs.startObserved({
      id: "job_parent_shell",
      type: "shell",
      title: "parent shell",
      notificationID: SessionMessage.ID.make("msg_job_parent_shell"),
      recovery: {
        kind: "shell",
        sessionID: parent.id,
        shellID: "sh_parent",
        command: "echo parent",
      },
      run: Deferred.await(hold),
    })
    const childShell = yield* jobs.startObserved({
      id: "job_child_shell",
      type: "shell",
      title: "child shell",
      notificationID: SessionMessage.ID.make("msg_job_child_shell"),
      recovery: {
        kind: "shell",
        sessionID: child.id,
        shellID: "sh_child",
        command: "echo child",
      },
      run: Deferred.await(hold),
    })
    const imageJob = yield* jobs.startObserved({
      id: "job_image",
      type: "image",
      title: "image job",
      notificationID: SessionMessage.ID.make("msg_job_image"),
      recovery: {
        kind: "image",
        sessionID: parent.id,
        path: `${tmp.path}/out`,
        model: "test/image",
      },
      run: Deferred.await(hold),
    })
    const otherJob = yield* jobs.startObserved({
      id: "job_other_shell",
      type: "shell",
      title: "other shell",
      notificationID: SessionMessage.ID.make("msg_job_other_shell"),
      recovery: {
        kind: "shell",
        sessionID: elsewhere.id,
        shellID: "sh_other",
        command: "echo other",
      },
      run: Deferred.await(hold),
    })
    yield* parentShell.background
    yield* childShell.background
    yield* imageJob.background
    yield* otherJob.background

    const request = (route: string) =>
      Effect.promise((signal) => {
        const url = new URL(route, "http://opencode.local")
        url.searchParams.set("location[directory]", tmp.path)
        return handler(
          new Request(url, {
            headers: { authorization: `Basic ${btoa("opencode:secret")}` },
            signal,
          }),
        )
      })

    const all = yield* request("/api/experimental/job")
    expect(all.status).toBe(200)
    const allBody = (yield* Effect.promise(() => all.json())) as {
      location: { directory: string }
      data: { data: Array<{ id: string; kind: string }> }
    }
    expect(allBody.location.directory).toBe(tmp.path)
    // The other location's job is filtered out even though the registry knows it.
    expect(allBody.data.data.map((item) => item.id).toSorted()).toEqual([
      "job_child_shell",
      "job_image",
      "job_parent_shell",
    ])

    const directShells = yield* request(`/api/experimental/job?sessionID=${parent.id}&kind=shell`)
    expect(directShells.status).toBe(200)
    const directBody = (yield* Effect.promise(() => directShells.json())) as {
      data: { data: Array<{ id: string; shellID: string; sessionID: string; command: string; status: string }> }
    }
    expect(directBody.data.data).toMatchObject([
      { id: "job_parent_shell", shellID: "sh_parent", sessionID: parent.id, command: "echo parent", status: "running" },
    ])

    const descendantShells = yield* request(`/api/experimental/job?sessionID=${parent.id}&kind=shell&descendants=true`)
    expect(descendantShells.status).toBe(200)
    const descendantBody = (yield* Effect.promise(() => descendantShells.json())) as {
      data: { data: Array<{ id: string }> }
    }
    expect(descendantBody.data.data.map((item) => item.id).toSorted()).toEqual(["job_child_shell", "job_parent_shell"])

    const images = yield* request(`/api/experimental/job?sessionID=${parent.id}&kind=image`)
    expect(images.status).toBe(200)
    const imagesBody = (yield* Effect.promise(() => images.json())) as {
      data: { data: Array<{ id: string; kind: string; path: string; model: string; status: string }> }
    }
    expect(imagesBody.data.data).toMatchObject([
      { id: "job_image", kind: "image", path: `${tmp.path}/out`, model: "test/image", status: "running" },
    ])

    const invalid = yield* request("/api/experimental/job?descendants=true")
    expect(invalid.status).toBe(400)

    const missing = yield* request("/api/experimental/job?sessionID=ses_missing")
    expect(missing.status).toBe(404)

    // A session that exists in another location is not addressable from this one.
    const crossLocation = yield* request(`/api/experimental/job?sessionID=${elsewhere.id}`)
    expect(crossLocation.status).toBe(404)

    yield* Deferred.succeed(hold, "done")
  }),
)

it.live("lists active external waits filtered by MCP attachment, session, descendants, kind, and location", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped("opencode-job-external-")
    const other = yield* tmpdirScoped("opencode-job-external-other-")
    const attachedServers = new Set(["t3-code-live"])
    const context = yield* Layer.build(
      createRoutes(
        {
          password: "secret",
          database: { path: ":memory:" },
          models: { fetch: false },
          fs: { filewatcher: false },
          config: { directory: tmp.path, project: false },
        },
        () => [],
        [
          Mcp.node.replace(
            Layer.mock(Mcp.Service, {
              isAttached: (server) => Effect.succeed(attachedServers.has(String(server))),
            }),
          ),
        ],
      ).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const sessions = Context.get(context, Session.Service)
    const waits = Context.get(context, SessionExternalWait.Service)

    const parent = yield* sessions.create({
      location: { directory: AbsolutePath.make(tmp.path) },
      title: "parent",
    })
    const child = yield* sessions.create({
      parentID: parent.id,
      title: "child",
    })
    const elsewhere = yield* sessions.create({
      location: { directory: AbsolutePath.make(other.path) },
      title: "elsewhere",
    })

    yield* waits.register({
      sessionID: parent.id,
      waitID: "wait_parent_live",
      source: "pr-watch",
      server: "t3-code-live",
      description: "Watching PR #42",
    })
    yield* waits.register({
      sessionID: parent.id,
      waitID: "wait_parent_dead",
      source: "pr-watch",
      server: "t3-code-dead",
      description: "Stale PR watch",
    })
    yield* waits.register({
      sessionID: child.id,
      waitID: "wait_child_live",
      source: "task",
      server: "t3-code-live",
      description: "Waiting on sub-task",
    })
    yield* waits.register({
      sessionID: elsewhere.id,
      waitID: "wait_other_live",
      source: "pr-watch",
      server: "t3-code-live",
      description: "Other workspace wait",
    })

    const request = (route: string) =>
      Effect.promise(async (signal) => {
        const url = new URL(route, "http://opencode.local")
        url.searchParams.set("location[directory]", tmp.path)
        const res = await handler(
          new Request(url, {
            headers: { authorization: `Basic ${btoa("opencode:secret")}` },
            signal,
          }),
        )
        return {
          status: res.status,
          body: (await res.json()) as { data: unknown },
        }
      })

    const allExternal = yield* request("/api/experimental/job?kind=external")
    expect(allExternal.status).toBe(200)
    const decodedAll = Schema.decodeUnknownSync(JobSchema.List)(allExternal.body.data)
    expect(decodedAll.data.map((item) => (item.kind === "external" ? item.waitID : item.id)).toSorted()).toEqual([
      "wait_child_live",
      "wait_parent_live",
    ])
    expect(decodedAll.data).toContainEqual(
      expect.objectContaining({
        kind: "external",
        sessionID: parent.id,
        waitID: "wait_parent_live",
        source: "pr-watch",
        server: "t3-code-live",
        description: "Watching PR #42",
        status: "running",
      }),
    )

    const shellOnly = yield* request("/api/experimental/job?kind=shell")
    expect(shellOnly.status).toBe(200)
    expect(Schema.decodeUnknownSync(JobSchema.List)(shellOnly.body.data).data).toEqual([])

    const parentDirect = yield* request(`/api/experimental/job?sessionID=${parent.id}`)
    expect(parentDirect.status).toBe(200)
    expect(Schema.decodeUnknownSync(JobSchema.List)(parentDirect.body.data).data.map((item) => item.id)).toEqual([
      `${parent.id}:wait_parent_live`,
    ])

    const parentDescendants = yield* request(`/api/experimental/job?sessionID=${parent.id}&descendants=true`)
    expect(parentDescendants.status).toBe(200)
    expect(
      Schema.decodeUnknownSync(JobSchema.List)(parentDescendants.body.data).data
        .map((item) => (item.kind === "external" ? item.waitID : item.id))
        .toSorted(),
    ).toEqual(["wait_child_live", "wait_parent_live"])

    // When the owning MCP server detaches, its active waits stop surfacing immediately.
    attachedServers.delete("t3-code-live")
    const afterDetach = yield* request("/api/experimental/job?kind=external")
    expect(afterDetach.status).toBe(200)
    expect(Schema.decodeUnknownSync(JobSchema.List)(afterDetach.body.data).data).toEqual([])

    attachedServers.add("t3-code-live")
    yield* waits.clear(parent.id, "wait_parent_live")
    const afterClear = yield* request("/api/experimental/job")
    expect(afterClear.status).toBe(200)
    expect(Schema.decodeUnknownSync(JobSchema.List)(afterClear.body.data).data.map((item) => item.id)).toEqual([
      `${child.id}:wait_child_live`,
    ])
  }),
)
