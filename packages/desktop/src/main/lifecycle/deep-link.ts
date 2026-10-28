import { product } from "../../../product"

// Memyr claims only its own scheme, so an installed OpenCode Desktop keeps the upstream
// `opencode://` handler. Console return links may still be handed to this process directly, and
// those keep working here; the window focus is simply not automatic for a browser redirect.
const schemes = new Set([`${product.protocol}:`, "opencode:"])

export function consoleReturnWindow(value: string) {
  try {
    const url = new URL(value)

    if (!schemes.has(url.protocol) || url.hostname !== "console" || url.pathname !== "/authorized") return
    const id = url.searchParams.get("window")

    if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) return

    return id
  } catch {
    return
  }
}
