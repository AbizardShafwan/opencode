import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("compiled identity separates paths, database overrides and client service discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memyr-identity-"))
  try {
    const repo = path.resolve(import.meta.dirname, "../../..")
    const entry = path.join(root, "probe.ts")
    await Bun.write(
      entry,
      `
      import { Global } from ${JSON.stringify(path.join(repo, "packages/util/src/global.ts"))}
      import { fallback, defaultCommand } from ${JSON.stringify(path.join(repo, "packages/client/src/service-probe.ts"))}
      import { databasePath } from ${JSON.stringify(path.join(repo, "packages/cli/src/database-path.ts"))}
      console.log(JSON.stringify({name: Global.name, data: Global.Path.data, config: Global.env("CONFIG_DIR") ?? Global.Path.config, db: databasePath(Global.Path.data), registration: fallback(), command: defaultCommand}))
    `,
    )
    const output = await Bun.build({
      entrypoints: [entry],
      outdir: root,
      target: "bun",
      define: { OPENCODE_APP_ID: '"memyr"', OPENCODE_CHANNEL: '"memyr"' },
    })
    expect(output.success).toBe(true)
    const child = Bun.spawn([process.execPath, path.join(root, "probe.js")], {
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"),
        OPENCODE_DB: path.join(root, "upstream.db"),
        OPENCODE_CONFIG_DIR: path.join(root, "upstream-config"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const text = await new Response(child.stdout).text()
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
    expect(JSON.parse(text)).toEqual({
      name: "memyr",
      command: "memyr",
      data: path.join(root, "data/memyr"),
      config: path.join(root, "config/memyr"),
      db: path.join(root, "data/memyr/opencode-memyr.db"),
      registration: path.join(root, "state/memyr/service-memyr.json"),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
