import path from "node:path"
import os from "node:os"
import { chmod, mkdir, mkdtemp, readdir, readlink, rename, rm, symlink } from "node:fs/promises"

// Only the install prefix and its command link are owned here. Runtime data is never removed.
export async function lifecycle(input: {
  action: "install" | "update" | "uninstall"
  prefix: string
  bin: string
  artifact?: string
  root: string
}) {
  if (process.platform === "win32")
    throw new Error("Use these scripts inside WSL. Native Windows installation is not supported.")
  const prefix = path.resolve(input.prefix)
  const command = path.join(path.resolve(input.bin), "memyr")
  const target = path.join(prefix, "current", "memyr")
  const marker = path.join(prefix, "installation.json")
  const installed = await Bun.file(marker).exists()
  const link = await readlink(command).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return
    throw new Error(`Refusing to replace a command not owned by this installer: ${command}`, { cause: error })
  })
  if (link !== undefined && link !== target) throw new Error(`Command belongs to another installation: ${command}`)
  if (installed) {
    const record: unknown = await Bun.file(marker).json()
    if (
      !record ||
      typeof record !== "object" ||
      !("command" in record) ||
      record.command !== command ||
      !("identity" in record) ||
      record.identity !== "memyr"
    )
      throw new Error(`Installation record does not match ${command}`)
  }
  if (
    !installed &&
    (
      await readdir(prefix).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []
        throw error
      })
    ).length
  )
    throw new Error(`Refusing a nonempty installation directory: ${prefix}`)
  if (!installed && input.action !== "install") throw new Error(`No Memyr installation at ${prefix}`)
  if (input.action === "uninstall") {
    // Use the installed binary's own authenticated registration, never search/kill by process name.
    await run([target, "service", "stop"], input.root)
    if (link !== undefined) await rm(command)
    await rm(prefix, { recursive: true })
    console.log(
      "Memyr removed. Configuration, credentials, sessions, and caches were preserved; OpenCode was not changed.",
    )
    return
  }
  if (!installed && (await Bun.file(path.join(prefix, "current", "memyr")).exists()))
    throw new Error(`Refusing an unrecognized installation at ${prefix}`)
  const stage = await mkdtemp(path.join(os.tmpdir(), "memyr-build-"))
  try {
    const artifact = input.artifact ?? (await build(input.root, stage))
    const output = await run(
      [artifact, "--version"],
      input.root,
      {
        HOME: stage,
        XDG_DATA_HOME: `${stage}/data`,
        XDG_CONFIG_HOME: `${stage}/config`,
        XDG_CACHE_HOME: `${stage}/cache`,
        XDG_STATE_HOME: `${stage}/state`,
        MEMYR_CONFIG_DIR: `${stage}/config/memyr`,
      },
      true,
    )
    // Stable versions must identify Memyr; a bare version could belong to upstream OpenCode.
    if (!/^memyr v\d+\.\d+\.\d+\s*$/.test(output) && !/^(?:memyr v)?0\.0\.0-memyr-[\d.]+\s*$/.test(output))
      throw new Error(`Not a Memyr build: ${output}`)
    await mkdir(path.join(prefix, "releases"), { recursive: true })
    const release = await mkdtemp(path.join(prefix, "releases", "release-"))
    const next = path.join(prefix, `current-${crypto.randomUUID()}`)
    try {
      await Bun.write(path.join(release, "memyr"), Bun.file(artifact))
      await chmod(path.join(release, "memyr"), 0o755)
      await symlink(release, next)
      await mkdir(path.dirname(command), { recursive: true })
      if (link === undefined) await symlink(target, command)
      await Bun.write(marker, JSON.stringify({ identity: "memyr", command }, null, 2) + "\n")
      // POSIX rename replaces the symlink, not the running executable. Failed builds never reach this point.
      await rename(next, path.join(prefix, "current"))
    } catch (error) {
      await rm(release, { recursive: true, force: true })
      if (link === undefined) await rm(command, { force: true })
      if (!installed) await rm(marker, { force: true })
      throw error
    } finally {
      await rm(next, { force: true })
    }
    console.log(`Installed ${output.trim()} at ${command}`)
    console.log(`Add ${path.dirname(command)} to PATH if needed. No shell files were edited.`)
    console.log("Existing Memyr services were not restarted. Run memyr service restart when ready to use this build.")
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

async function build(root: string, stage: string) {
  const manifest = await Bun.file(path.join(root, "package.json")).json()
  const required = String(manifest.packageManager).replace(/^bun@/, "")
  if (Bun.version !== required)
    throw new Error(`Build requires Bun ${required}; found ${Bun.version}. Install that version first.`)
  await run([process.execPath, "install", "--frozen-lockfile"], root)
  await run(
    [
      process.execPath,
      "run",
      "script/build.ts",
      "--memyr",
      "--single",
      "--skip-install",
      `--outdir=${stage}/artifacts`,
    ],
    path.join(root, "packages/cli"),
    { OPENCODE_CHANNEL: "memyr" },
  )
  return path.join(stage, "artifacts", `cli-${process.platform}-${process.arch}`, "bin", "memyr")
}

async function run(command: string[], cwd: string, env?: Record<string, string>, capture = false) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    stdin: "inherit",
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
    detached: true,
  })
  // The installer owns this process group, including native/web build subprocesses.
  const stop = () => process.kill(-child.pid, "SIGTERM")
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    const output = capture ? new Response(child.stdout).text() : Promise.resolve("")
    if ((await child.exited) !== 0) throw new Error(`Command failed: ${command.join(" ")}`)
    return await output
  } finally {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
  }
}

if (import.meta.main) {
  const action = process.argv[2]
  if (action !== "install" && action !== "update" && action !== "uninstall")
    throw new Error("Expected install, update, or uninstall")
  const args = process.argv.slice(3)
  if (
    args.length > 2 ||
    (args.length > 0 && (args[0] !== "--artifact" || !args[1])) ||
    (action === "uninstall" && args.length)
  )
    throw new Error("Usage: install|update [--artifact /absolute/path/to/memyr]; uninstall")
  await lifecycle({
    action,
    prefix: process.env.MEMYR_INSTALL_PREFIX ?? path.join(os.homedir(), ".local/share/memyr-install"),
    bin: process.env.MEMYR_BIN_DIR ?? path.join(os.homedir(), ".local/bin"),
    artifact: args[1] ? path.resolve(args[1]) : undefined,
    root: path.resolve(import.meta.dirname, "../.."),
  })
}
