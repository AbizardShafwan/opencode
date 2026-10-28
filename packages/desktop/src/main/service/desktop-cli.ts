export * as DesktopCli from "./desktop-cli"

import { execFile } from "node:child_process"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { promisify } from "node:util"
import { app } from "electron"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { product } from "../../../product"
import { DesktopPaths } from "../paths"
import { BUNDLED_CLI_VERSION_KEY } from "../storage/keys"
import { getStore } from "../storage/store"
import { parseCliVersion } from "./cli-version"

const execFileAsync = promisify(execFile)

export interface Resolved {
  readonly version: string
  readonly command: readonly string[]
  readonly binary?: string
}

export interface Installed {
  readonly path: string
  /** False when a command already exists and was left untouched. */
  readonly created: boolean
}

export interface Interface {
  readonly resolve: Effect.Effect<Resolved>
  readonly install: Effect.Effect<Installed, Error>
}

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/DesktopCli") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const path = yield* Path.Path

    const resolve = yield* Effect.cached(
      make().pipe(Effect.provide(yield* Effect.context<FileSystem.FileSystem | Path.Path>()), Effect.orDie),
    )

    const install = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      if (process.platform !== "darwin")
        return yield* Effect.fail(new Error("CLI installation requires macOS"))
      const cli = yield* resolve

      if (!cli.binary) return yield* Effect.fail(new Error("Bundled CLI executable is unavailable"))
      const directory = path.join(app.getPath("home"), ".local", "bin")
      const destination = path.join(directory, product.cli.executable)

      // Never replace a command another installer owns (scripts/memyr keeps a symlink here) or one
      // the user put there. Report it so the menu action stays honest instead of silently failing.
      if (commandExists(destination)) {
        yield* Effect.logInfo("v2 CLI install skipped, command already exists", { path: destination })

        return { path: destination, created: false }
      }

      const temp = `${destination}.${process.pid}.tmp`

      yield* fs.makeDirectory(directory, { recursive: true })
      yield* fs.copyFile(cli.binary, temp)
      // The command did not exist, so the rename cannot replace another file or symlink.
      yield* fs.rename(temp, destination)
      yield* fs.chmod(destination, 0o755)

      return { path: destination, created: true }
    }).pipe(Effect.provide(yield* Effect.context<FileSystem.FileSystem>()))

    return Service.of({ resolve, install })
  }),
)

const make = Effect.fn("DesktopCli.resolve")(function* () {
  const development = !app.isPackaged && process.env.OPENCODE_DESKTOP_CLI_DEV
  const version = process.env.OPENCODE_VERSION ?? "local"

  const cli = development
    ? {
        version,
        // Bun's transpiler cache key includes the define table, and the dev version changes on every
        // run. Reading it from the inherited environment keeps the define fixed and the cache warm.
        command: [
          "bun",
          "run",
          "--cwd",
          development,
          "--define=OPENCODE_VERSION=process.env.OPENCODE_VERSION",
          `--define=OPENCODE_APP_ID=${JSON.stringify(product.cli.appId)}`,
          "src/index.ts",
        ],
        binary: undefined,
      }
    : yield* resolveBundledCli(!app.isPackaged && process.env.OPENCODE_DESKTOP_ISOLATED_SERVER === "1")

  return cli satisfies Resolved
})

const resolveBundledCli = Effect.fn("DesktopCli.resolveBundled")(function* (isolated: boolean) {
  const path = yield* Path.Path
  const paths = yield* DesktopPaths.resolve

  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, executableName())
    : path.join(paths.developmentResourcesRoot, isolated ? developmentExecutableName() : executableName())

  yield* Effect.logInfo("v2 CLI executable resolved", { bundled, packaged: app.isPackaged })
  const version = yield* bundledVersion(bundled)
  const binary = app.isPackaged || isolated ? yield* installCli(bundled, version) : bundled

  return { version, binary, command: [binary] }
})

// Spawning the bundled executable for `--version` costs ~400 ms of startup on a 200 MB binary (and
// several seconds on the first launch after an update, while the antivirus scans it). The build
// writes the version next to the executable, so a packaged app never spawns; the per-identity cache
// covers executables that arrived without that file.
const bundledVersion = Effect.fn("DesktopCli.bundledVersion")(function* (bundled: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  // Synchronous on purpose: this sits on the path to the first window's IPC port, and a queued
  // async read waits behind everything else the main thread is doing at that moment.
  const shipped = yield* Effect.sync(() => {
    try {
      return readFileSync(path.join(path.dirname(bundled), product.cli.versionFile), "utf8").trim()
    } catch {
      return ""
    }
  })

  if (shipped) {
    yield* Effect.logInfo("v2 CLI version bundled", { version: shipped })

    return shipped
  }

  const stat = yield* fs.stat(bundled).pipe(Effect.orElseSucceed(() => undefined))
  const identity = stat ? `${stat.size}:${Option.getOrUndefined(stat.mtime)?.getTime() ?? ""}` : undefined
  const store = getStore()
  const cached = Option.getOrUndefined(Schema.decodeUnknownOption(VersionCache)(store.get(BUNDLED_CLI_VERSION_KEY)))

  if (identity && cached?.path === bundled && cached.identity === identity) {
    yield* Effect.logInfo("v2 CLI version reused", { version: cached.version })

    return cached.version
  }

  const version = parseCliVersion(yield* run(bundled, ["--version"]))

  if (identity)
    store.set(BUNDLED_CLI_VERSION_KEY, { path: bundled, identity, version } satisfies typeof VersionCache.Type)

  return version
})

const VersionCache = Schema.Struct({ path: Schema.String, identity: Schema.String, version: Schema.String })

const ExecFailure = Schema.Struct({ stdout: Schema.optional(Schema.String), stderr: Schema.optional(Schema.String) })

const installCli = Effect.fn("DesktopCli.install")(function* (source: string, version: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  // x64 and ARM64 installers share userData on Windows ARM64, so a same-version switch must not reuse the other copy.
  const stage = `${version}-${process.arch}`.replace(/[^a-zA-Z0-9._-]/g, "-")
  const directory = path.join(app.getPath("userData"), "cli", stage)
  const destination = path.join(directory, executableName())

  if (existsSync(destination)) {
    yield* Effect.logInfo("v2 CLI staged executable reused", { path: destination, version })

    return destination
  }

  const temp = destination + `.${process.pid}.tmp`
  yield* fs.makeDirectory(directory, { recursive: true })
  yield* fs.copyFile(source, temp)

  if (process.platform !== "win32") yield* fs.chmod(temp, 0o755)
  yield* fs
    .rename(temp, destination)
    .pipe(Effect.catch((error) => fs.remove(temp, { force: true }).pipe(Effect.andThen(Effect.fail(error)))))
  yield* Effect.logInfo("v2 CLI executable staged", { source, path: destination, version })

  return destination
})

const run = Effect.fn("DesktopCli.run")(function* (binary: string, args: string[]) {
  yield* Effect.logInfo("v2 CLI command started", { binary, args })

  const result = yield* Effect.tryPromise(() => execFileAsync(binary, args, { windowsHide: true })).pipe(
    Effect.tapError((error) => {
      const output = Option.getOrUndefined(Schema.decodeUnknownOption(ExecFailure)(error.cause))

      return Effect.logError("v2 CLI command failed", {
        args,
        error: error.cause instanceof Error ? error.cause.message : String(error.cause),
        stdout: output?.stdout?.trim() ?? "",
        stderr: output?.stderr?.trim() ?? "",
      })
    }),
  )

  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()
  yield* Effect.logInfo("v2 CLI command completed", { args, stdout, stderr })

  return stdout
})

function executableName() {
  return process.platform === "win32" ? `${product.cli.resource}.exe` : product.cli.resource
}

// A broken symlink still occupies the command path; existsSync would follow it and report false.
function commandExists(file: string) {
  try {
    lstatSync(file)

    return true
  } catch {
    return false
  }
}

function developmentExecutableName() {
  return process.platform === "win32" ? `${product.cli.resource}-dev.exe` : `${product.cli.resource}-dev`
}
