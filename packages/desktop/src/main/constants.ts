import { app } from "electron"
import { channelIdentity, product, type DesktopChannel } from "../../product"

const raw = import.meta.env.OPENCODE_CHANNEL

export const CHANNEL: "local" | DesktopChannel =
  raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const VERSION = app.isPackaged ? app.getVersion() : (process.env.OPENCODE_VERSION ?? app.getVersion())

// This fork has no update feed, so a packaged build never runs the updater.
export const UPDATES = product.updates

// Local renderer/server mode keeps the dev application identity.
export const APP_NAME = app.isPackaged
  ? channelIdentity(CHANNEL === "local" ? "dev" : CHANNEL).name
  : channelIdentity("dev").name

export const APP_ID = app.isPackaged
  ? channelIdentity(CHANNEL === "local" ? "dev" : CHANNEL).appId
  : channelIdentity("dev").appId
