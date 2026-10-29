import { expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"

it.live("usage reads answer nothing for a provider without a usage account", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped("opencode-usage-endpoints-")
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
    const request = (route: string) =>
      Effect.promise((signal) => {
        const url = new URL(route, "http://opencode.local")
        url.searchParams.set("location[directory]", tmp.path)
        return handler(
          new Request(url, { headers: { authorization: `Basic ${btoa("opencode:secret")}` }, signal }),
        )
      })

    const none = yield* request("/api/usage?providerID=opencode").pipe(Effect.timeout("5 seconds"))
    expect(none.status).toBe(200)
    expect(yield* Effect.promise(() => none.json())).toMatchObject({
      location: { directory: tmp.path },
      data: null,
    })

    // providerID owns the selection, so a read without one is a schema rejection at the boundary.
    const missing = yield* request("/api/usage").pipe(Effect.timeout("5 seconds"))
    expect(missing.status).toBe(400)
  }),
)
