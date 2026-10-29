#!/usr/bin/env bun
import { $ } from "bun"
import { rm } from "node:fs/promises"

import { product } from "../product"
import { copyBuiltCliToResources, copyWslCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()

const cliDist = Bun.env.OPENCODE_CLI_DIST

if (!cliDist) {
  throw new Error(
    "OPENCODE_CLI_DIST is required: build the Memyr CLI first (bun run --cwd packages/cli build -- --memyr) and point OPENCODE_CLI_DIST at packages/cli/dist",
  )
}

await $`bun ./scripts/copy-icons.ts ${channel}`

await $`bun ./scripts/copy-metainfo.ts ${channel}`

await copyBuiltCliToResources(cliDist)

// A Linux CLI is only useful inside a Windows package, where WSL runs it.
if (process.platform === "win32" && !(await copyWslCliToResources(cliDist))) {
  await rm(`resources/${product.cli.wslResource}`, { force: true })
  console.warn(
    `No Linux CLI in ${cliDist}: WSL settings will report that no ${product.name} CLI is available to install.`,
  )
}

if (process.platform !== "win32") await rm(`resources/${product.cli.wslResource}`, { force: true })
