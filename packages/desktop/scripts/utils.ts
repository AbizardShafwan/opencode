import { chmod, copyFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Option, Schema } from "effect"
import { product } from "../product"

const Manifest = Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString }))

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = process.env.OPENCODE_CHANNEL

  if (raw === "dev" || raw === "beta" || raw === "prod") return raw

  if (raw === "latest") return "prod"

  return "dev"
}

// The upstream release package names describe the artifact directory layout produced by the CLI
// build (`cli-<os>-<arch>`); the executable inside is the Memyr binary.
export const CLI_BINARIES: Array<{ target: string; package: string; os: string; cpu: string }> = [
  {
    target: "aarch64-apple-darwin",
    package: "@opencode/cli-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
  },
  {
    target: "x86_64-apple-darwin",
    package: "@opencode/cli-darwin-x64-baseline",
    os: "darwin",
    cpu: "x64",
  },
  {
    target: "aarch64-pc-windows-msvc",
    package: "@opencode/cli-windows-arm64",
    os: "win32",
    cpu: "arm64",
  },
  {
    target: "x86_64-pc-windows-msvc",
    package: "@opencode/cli-windows-x64-baseline",
    os: "win32",
    cpu: "x64",
  },
  {
    target: "x86_64-unknown-linux-gnu",
    package: "@opencode/cli-linux-x64-baseline",
    os: "linux",
    cpu: "x64",
  },
  {
    target: "aarch64-unknown-linux-gnu",
    package: "@opencode/cli-linux-arm64",
    os: "linux",
    cpu: "arm64",
  },
]

/** The packaging target selected for this run, or undefined for the native target. */
export const CLI_TARGET = process.env.OPENCODE_CLI_TARGET

function nativeTarget() {
  const { platform, arch } = process

  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"

  if (platform === "win32") return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"

  if (platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  throw new Error(`Unsupported platform: ${platform}/${arch}`)
}

export function getCurrentCli(target = process.env.OPENCODE_CLI_TARGET ?? nativeTarget()) {
  const binaryConfig = CLI_BINARIES.find((item) => item.target === target)

  if (!binaryConfig) throw new Error(`CLI configuration not available for target '${target}'`)

  return binaryConfig
}

export function nodePtyPackage(target?: string) {
  const cli = getCurrentCli(target)

  return `@lydell/node-pty-${cli.os}-${cli.cpu}`
}

export async function copyBuiltCliToResources(root: string, dest = windowsify(`resources/${product.cli.resource}`)) {
  const cli = getCurrentCli()
  const directory = cli.package.replace("@opencode/", "")
  await copyCliToResources(join(root, directory), dest)
}

// The package directory is the CLI build output: its package.json version is the string the
// executable prints for --version. Writing it next to the executable spares the desktop a ~400 ms
// spawn of the 200 MB binary on first launch.
async function copyCliToResources(pkg: string, dest: string) {
  const cli = getCurrentCli()
  const executable = join(pkg, "bin", cli.os === "win32" ? `${product.cli.executable}.exe` : product.cli.executable)

  // Only a --memyr build emits this executable. An upstream artifact would register under
  // OpenCode's identity, and the desktop would never find the service it started.
  if (!(await Bun.file(executable).exists()))
    throw new Error(`Bundled CLI is not a Memyr build: ${pkg} has no ${product.cli.executable} executable`)

  await copyFile(executable, dest)
  await prepareCli(dest)

  const manifest = Option.getOrUndefined(
    Schema.decodeUnknownOption(Manifest)(await Bun.file(join(pkg, "package.json")).text()),
  )

  if (!manifest) throw new Error(`Bundled CLI package has no version: ${pkg}`)

  await Bun.write(versionFile(dest), manifest.version)
}

export function versionFile(cli: string) {
  return join(dirname(cli), product.cli.versionFile)
}

// The Windows desktop runs a Linux CLI inside WSL, so a Windows package carries one when the
// supplied distribution includes the matching Linux target. Without it, WSL has nothing to install.
export async function copyWslCliToResources(root: string, dest = `resources/${product.cli.wslResource}`) {
  const target = process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  const pkg = join(root, getCurrentCli(target).package.replace("@opencode/", ""))

  if (!(await Bun.file(join(pkg, "package.json")).exists())) return false

  const executable = join(pkg, "bin", product.cli.executable)

  if (!(await Bun.file(executable).exists()))
    throw new Error(`WSL CLI is not a Memyr build: ${pkg} has no ${product.cli.executable} executable`)

  await copyFile(executable, dest)
  await chmod(dest, 0o755)

  return true
}

async function prepareCli(dest: string) {
  const { $ } = await import("bun")

  if (process.platform !== "win32") await chmod(dest, 0o755)

  if (process.platform === "win32" && process.env.GITHUB_ACTIONS === "true") {
    await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ../../script/sign-windows.ps1 ${dest}`
  }

  if (process.platform === "darwin") await $`codesign --force --sign - ${dest}`
}

export function windowsify(path: string) {
  if (path.endsWith(".exe")) return path

  return `${path}${process.platform === "win32" ? ".exe" : ""}`
}
