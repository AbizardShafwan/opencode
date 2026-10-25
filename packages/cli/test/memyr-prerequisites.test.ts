import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const script = path.resolve(import.meta.dirname, "../../../scripts/memyr/prerequisites")

// These scripts provision POSIX hosts; Windows users run them in WSL.
test.skipIf(process.platform === "win32")(
  "prerequisite plans never install packages or download runtimes",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "memyr-prerequisites-"))
    try {
      const bin = path.join(root, "bin")
      await mkdir(bin)
      for (const name of ["bash", "dirname", "sed"]) {
        await symlink(Bun.which(name)!, path.join(bin, name))
      }
      for (const [name, body] of Object.entries({
        uname: 'if [ "$1" = -s ]; then echo Linux; else echo x86_64; fi',
        getconf: 'echo "glibc 2.39"',
        sudo: `echo executed > '${root}/executed'`,
        "apt-get": `echo executed > '${root}/executed'`,
      })) {
        await Bun.write(path.join(bin, name), `#!/bin/sh\n${body}\n`)
        await chmod(path.join(bin, name), 0o755)
      }
      const env = { ...process.env, PATH: bin, HOME: root, MEMYR_TOOLCHAIN_DIR: path.join(root, "tools") }
      const plan = Bun.spawn(["/bin/bash", script, "--plan"], { env, stdout: "pipe", stderr: "pipe" })
      const output = await new Response(plan.stdout).text()
      const errors = await new Response(plan.stderr).text()
      expect(errors).toContain("Missing system tools:")
      expect(await plan.exited).toBe(0)
      expect(output).toContain("apt-get install")
      expect(output).toContain("build-essential python3")
      expect(output).toContain("memyr_fetch_runtime bun")
      expect(output).toContain("memyr_fetch_runtime node")
      expect(await readdir(root)).toEqual(["bin"])

      const check = Bun.spawn(["/bin/bash", script, "--check"], { env, stdout: "pipe", stderr: "pipe" })
      expect(await new Response(check.stderr).text()).toContain("Missing system tools:")
      expect(await check.exited).toBe(1)
      expect(await readdir(root)).toEqual(["bin"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform === "win32")("help and invalid lifecycle arguments do not bootstrap", async () => {
  for (const action of ["install", "update", "uninstall"]) {
    const file = path.join(path.dirname(script), action)
    const help = Bun.spawn(["/bin/bash", file, "--help"], { stdout: "pipe", stderr: "pipe" })
    expect(await new Response(help.stdout).text()).toContain(`Usage: ${action}`)
    expect(await new Response(help.stderr).text()).toBe("")
    expect(await help.exited).toBe(0)
    const invalid = Bun.spawn(["/bin/bash", file, "--invalid"], { stdout: "pipe", stderr: "pipe" })
    expect(await new Response(invalid.stderr).text()).toStartWith("Usage:")
    expect(await invalid.exited).toBe(1)
  }
})
