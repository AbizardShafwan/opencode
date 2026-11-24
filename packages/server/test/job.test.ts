import { expect } from "bun:test"
import { Job } from "@opencode/core/job"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { AbsolutePath } from "@opencode/schema/schema"
import { Context, Deferred, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"

it.live("lists background jobs with session, kind, and descendant filters", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped("opencode-job-endpoints-")
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
    yield* parentShell.background
    yield* childShell.background
    yield* imageJob.background

    const request = (route: string) =>
      Effect.promise((signal) =>
        handler(
          new Request(new URL(route, "http://opencode.local"), {
            headers: { authorization: `Basic ${btoa("opencode:secret")}` },
            signal,
          }),
        ),
      )

    const all = yield* request("/api/experimental/job")
    expect(all.status).toBe(200)
    const allBody = (yield* Effect.promise(() => all.json())) as { data: Array<{ id: string; kind: string }> }
    expect(allBody.data.map((item) => item.id).toSorted()).toEqual([
      "job_child_shell",
      "job_image",
      "job_parent_shell",
    ])

    const directShells = yield* request(`/api/experimental/job?sessionID=${parent.id}&kind=shell`)
    expect(directShells.status).toBe(200)
    const directBody = (yield* Effect.promise(() => directShells.json())) as {
      data: Array<{ id: string; shellID: string; sessionID: string; command: string; status: string }>
    }
    expect(directBody.data).toMatchObject([
      { id: "job_parent_shell", shellID: "sh_parent", sessionID: parent.id, command: "echo parent", status: "running" },
    ])

    const descendantShells = yield* request(`/api/experimental/job?sessionID=${parent.id}&kind=shell&descendants=true`)
    expect(descendantShells.status).toBe(200)
    const descendantBody = (yield* Effect.promise(() => descendantShells.json())) as { data: Array<{ id: string }> }
    expect(descendantBody.data.map((item) => item.id).toSorted()).toEqual(["job_child_shell", "job_parent_shell"])

    const images = yield* request(`/api/experimental/job?sessionID=${parent.id}&kind=image`)
    expect(images.status).toBe(200)
    const imagesBody = (yield* Effect.promise(() => images.json())) as {
      data: Array<{ id: string; kind: string; path: string; model: string; status: string }>
    }
    expect(imagesBody.data).toMatchObject([
      { id: "job_image", kind: "image", path: `${tmp.path}/out`, model: "test/image", status: "running" },
    ])

    const invalid = yield* request("/api/experimental/job?descendants=true")
    expect(invalid.status).toBe(400)

    const missing = yield* request("/api/experimental/job?sessionID=ses_missing")
    expect(missing.status).toBe(404)

    yield* Deferred.succeed(hold, "done")
  }),
)
