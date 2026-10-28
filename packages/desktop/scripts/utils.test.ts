import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyWslCliToResources, getCurrentCli } from "./utils"

// WSL runs a Linux CLI. Its directory layout comes from the same artifact naming as the host CLI,
// so this exercises the identity guard without depending on the build machine's platform.
const directory = getCurrentCli(process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu")
  .package.replace("@opencode/", "")

async function fixture(executable: boolean) {
  const root = await mkdtemp(join(tmpdir(), "memyr-cli-identity-"))
  const pkg = join(root, directory)
  const dest = join(root, "out", "memyr-cli-linux")
  await mkdir(join(pkg, "bin"), { recursive: true })
  await mkdir(join(root, "out"), { recursive: true })
  await writeFile(join(pkg, "package.json"), JSON.stringify({ version: "1.0.0" }))

  if (executable) await writeFile(join(pkg, "bin", "memyr"), "#!/bin/sh\n")

  return { root, dest }
}

test("refuses a distribution without a Memyr executable", async () => {
  const { root, dest } = await fixture(false)

  try {
    await expect(copyWslCliToResources(root, dest)).rejects.toThrow("not a Memyr build")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("copies the Memyr executable", async () => {
  const { root, dest } = await fixture(true)

  try {
    expect(await copyWslCliToResources(root, dest)).toBe(true)
    expect(await Bun.file(dest).text()).toBe("#!/bin/sh\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
