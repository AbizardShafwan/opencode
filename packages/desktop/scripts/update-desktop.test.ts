import { expect, test } from "bun:test"
import { constants } from "node:fs"
import { access, chmod, copyFile, mkdir, mkdtemp, readlink, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const scripts = path.resolve(import.meta.dirname, "../../../scripts/memyr")

// Linux installer entry points require Bash and POSIX symlinks; other platforms use different packaging.
const linux = test.skipIf(process.platform !== "linux")

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "memyr-desktop-"))
  const checkout = path.join(root, "source checkout")
  const home = path.join(root, "home")
  const bin = path.join(root, "bin")
  const log = path.join(root, "calls")
  await mkdir(path.join(checkout, "scripts/memyr"), { recursive: true })
  await mkdir(home)
  await mkdir(bin)

  for (const name of ["install-desktop", "update-desktop"]) {
    await copyFile(path.join(scripts, name), path.join(checkout, "scripts/memyr", name))
  }

  // Isolate toolchain provisioning, not the installer: a test must never download or provision a host.
  await Bun.write(
    path.join(checkout, "scripts/memyr/prerequisites"),
    'memyr_prerequisites() { echo "prerequisites $*" >> "$CALLS"; }\n',
  )

  for (const name of ["bash", "dirname", "cat", "mkdir", "rm", "cp", "chmod", "ln"]) {
    const executable = Bun.which(name)

    if (!executable) throw new Error(`Missing installer test tool: ${name}`)
    await symlink(executable, path.join(bin, name))
  }

  for (const [name, body] of Object.entries({
    uname: 'if [ "$1" = -s ]; then echo Linux; else echo x86_64; fi',
    pacman: `case "$1" in
      -Qq) [ "$PACKAGE_INSTALLED" = true ] ;;
      -Qi) exit 0 ;;
      *) echo "unexpected pacman $*" >> "$CALLS"; exit 99 ;;
    esac`,
    makepkg: 'echo "makepkg $*" >> "$CALLS"; exit "${MAKEPKG_EXIT:-0}"',
    bun: `echo "bun $*" >> "$CALLS"
      if [ "$1" = run ] && [ "$3" = packages/desktop ]; then exit "\${BUILD_EXIT:-0}"; fi`,
    sudo: 'echo "unexpected sudo $*" >> "$CALLS"; exit 99',
  })) {
    await Bun.write(path.join(bin, name), `#!/bin/sh\n${body}\n`)
    await chmod(path.join(bin, name), 0o755)
  }

  const run = async (args: string[], env: Record<string, string> = {}, action = "update-desktop") => {
    const child = Bun.spawn(["/bin/bash", path.join(checkout, "scripts/memyr", action), ...args], {
      cwd: root,
      env: { PATH: bin, HOME: home, CALLS: log, PACKAGE_INSTALLED: "false", ...env },
      stdout: "pipe",
      stderr: "pipe",
    })

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    return { stdout, stderr, code }
  }

  return {
    checkout,
    home,
    bin,
    run,
    calls: () =>
      Bun.file(log)
        .text()
        .catch(() => ""),
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

linux("desktop update help, detection, and plans never bootstrap or install", async () => {
  // A real manual system install may exist on a developer host. Plans can observe it but never alter it.
  const system = await access("/opt/memyr/ai.memyr", constants.X_OK).then(
    () => true,
    () => false,
  )

  for (const row of [
    { args: ["--help"], code: 0, output: "Usage: update-desktop" },
    { args: ["--invalid"], code: 1, error: "Unknown option: --invalid" },
    {
      args: ["--plan"],
      code: system ? 0 : 1,
      output: system ? "Install Mode:        system" : undefined,
      error: system ? undefined : "No Memyr Desktop installation detected",
    },
    { args: ["--plan"], installed: true, code: 0, output: "makepkg -si --noconfirm --force" },
    {
      args: ["--plan"],
      user: true,
      code: system ? 1 : 0,
      output: system ? undefined : "Install Mode:        user",
      error: system ? "Multiple Memyr Desktop installations detected" : undefined,
    },
    { args: ["--plan"], installed: true, user: true, code: 1, error: "Multiple Memyr Desktop installations detected" },
    { args: ["--user", "--plan"], installed: true, user: true, code: 0, output: "Install Mode:        user" },
    { args: ["--system", "--plan"], installed: true, code: 1, error: "managed by pacman" },
    { args: ["--system", "--plan"], code: 0, output: "Install Mode:        system" },
    { args: ["--build-only", "--plan"], code: 0, output: "without installing" },
    { args: ["--pacman", "--build-only", "--plan"], code: 0, output: "without installing" },
  ]) {
    await using dir = await fixture()

    if (row.user) {
      await Bun.write(path.join(dir.home, ".local/lib/memyr/ai.memyr"), "old desktop")
      await chmod(path.join(dir.home, ".local/lib/memyr/ai.memyr"), 0o755)
    }

    const result = await dir.run(row.args, { PACKAGE_INSTALLED: String(row.installed ?? false) })
    expect(result.code, `${JSON.stringify(row)}\n${result.stdout}\n${result.stderr}`).toBe(row.code)

    if (row.output) expect(result.stdout).toContain(row.output)

    if (row.error) expect(result.stderr).toContain(row.error)

    if (row.args.includes("--build-only")) expect(result.stdout).not.toContain("makepkg -si")
    expect(await dir.calls()).toBe("")
  }
})

linux("pacman desktop updates force rebuilding and propagate package failures", async () => {
  for (const row of [
    { action: "update-desktop", exit: "0", force: " --force" },
    { action: "update-desktop", exit: "42", force: " --force" },
    { action: "install-desktop", exit: "0", force: "" },
  ]) {
    await using dir = await fixture()
    const result = await dir.run(["--pacman"], { MAKEPKG_EXIT: row.exit }, row.action)

    if (process.getuid?.() === 0 && row.action === "update-desktop") {
      expect(result.stderr).toContain("Run update-desktop as a normal user")
      expect(result.code).toBe(1)
      expect(await dir.calls()).toBe("")
      continue
    }

    expect(result.stderr).toBe("")
    expect(result.code, result.stdout).toBe(Number(row.exit))
    expect(await dir.calls()).toBe(`prerequisites install build\nmakepkg -si --noconfirm${row.force}\n`)

    if (row.exit !== "0") expect(result.stdout).not.toContain("successfully installed")
  }
})

linux("pacman update rejects missing tools before provisioning", async () => {
  await using dir = await fixture()
  await rm(path.join(dir.bin, "makepkg"))
  const result = await dir.run(["--pacman"])
  expect(result.stderr).toContain("Pacman updates require makepkg and pacman")
  expect(result.code).toBe(1)
  expect(await dir.calls()).toBe("")
})

linux("manual desktop updates replace built files only after success and preserve CLI ownership", async () => {
  for (const row of [
    { cli: "file", exit: "0", buildOnly: false },
    { cli: "symlink", exit: "0", buildOnly: false },
    { cli: "missing", exit: "0", buildOnly: false },
    { cli: "file", exit: "37", buildOnly: false },
    { cli: "file", exit: "0", buildOnly: true },
  ]) {
    await using dir = await fixture()
    const target = path.join(dir.home, ".local/lib/memyr")
    const command = path.join(dir.home, ".local/bin/memyr")
    await Bun.write(path.join(target, "ai.memyr"), "old desktop")
    await Bun.write(path.join(target, "obsolete"), "old resource")
    await chmod(path.join(target, "ai.memyr"), 0o755)
    await mkdir(path.dirname(command), { recursive: true })

    if (row.cli === "file") await Bun.write(command, "standalone CLI")

    if (row.cli === "symlink") await symlink("/missing/standalone-memyr", command)
    const unpacked = path.join(dir.checkout, "packages/desktop/dist/linux-unpacked")
    await Bun.write(path.join(unpacked, "ai.memyr"), "new desktop")
    await Bun.write(path.join(unpacked, "resources/memyr-cli"), "bundled CLI")

    for (const icon of ["32x32.png", "64x64.png", "128x128.png", "128x128@2x.png", "icon.png"]) {
      await Bun.write(path.join(dir.checkout, "packages/desktop/icons/prod", icon), "icon")
    }

    const result = await dir.run(["--user", ...(row.buildOnly ? ["--build-only"] : [])], { BUILD_EXIT: row.exit })
    expect(result.stderr).toBe("")
    expect(result.code, result.stdout).toBe(Number(row.exit))
    const installed = row.exit === "0" && !row.buildOnly
    expect(await Bun.file(path.join(target, "ai.memyr")).text()).toBe(installed ? "new desktop" : "old desktop")
    expect(await Bun.file(path.join(target, "obsolete")).exists()).toBe(!installed)

    if (row.cli === "file") expect(await Bun.file(command).text()).toBe("standalone CLI")

    if (row.cli === "symlink") expect(await readlink(command)).toBe("/missing/standalone-memyr")

    if (row.cli === "missing" && installed)
      expect(await readlink(command)).toBe(path.join(target, "resources/memyr-cli"))

    if (installed) {
      expect(await readlink(path.join(dir.home, ".local/bin/memyr-desktop"))).toBe(path.join(target, "ai.memyr"))
      expect(
        await Bun.file(path.join(dir.home, ".local/share/applications/ai.memyr.desktop.desktop")).text(),
      ).toContain(`Exec=${target}/ai.memyr %U`)
    }

    const calls = await dir.calls()
    expect(calls).toContain(
      "bun run --cwd packages/cli script/build.ts --memyr --target=memyr-linux-x64-baseline --skip-install",
    )
    expect(calls).not.toContain("unexpected")

    if (row.exit !== "0") expect(calls).not.toContain("electron-builder")
  }
})
