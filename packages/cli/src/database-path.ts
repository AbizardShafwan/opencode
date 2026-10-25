import { Global } from "@opencode/util/global"
import path from "node:path"
import { OPENCODE_CHANNEL } from "./version"

export function databasePath(data: string) {
  const filename =
    Global.env("DB") ??
    (["latest", "dev", "beta", "next", "prod"].includes(OPENCODE_CHANNEL) ||
    Global.env("DISABLE_CHANNEL_DB") === "1" ||
    Global.env("DISABLE_CHANNEL_DB") === "true"
      ? "opencode.db"
      : `opencode-${OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
