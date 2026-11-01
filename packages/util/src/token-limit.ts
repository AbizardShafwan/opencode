export * as TokenLimit from "./token-limit.js"

export const MIN_TOKEN_LIMIT = 40_000

export type ParseTokenLimitResult =
  | { tokens: number; clamped?: boolean; clear?: undefined; error?: undefined }
  | { clear: true; tokens?: undefined; clamped?: undefined; error?: undefined }
  | { error: string; tokens?: undefined; clamped?: undefined; clear?: undefined }

const CLEAR_KEYWORDS = new Set(["default", "reset", "none"])

/**
 * Parses user token limit input into a token number, clear directive, or error.
 * "max" selects the physical window; "default", "reset", and "none" inherit configuration.
 * Enforces a 40k token floor and clamps to hardLimit if provided.
 */
export function parseTokenLimit(input: string, hardLimit?: number): ParseTokenLimitResult {
  const trimmed = input.trim()
  if (!trimmed) {
    return { error: "Invalid token limit format" }
  }

  const lower = trimmed.toLowerCase()
  if (lower === "max") {
    return hardLimit && Number.isFinite(hardLimit) && hardLimit > 0
      ? { tokens: hardLimit }
      : { error: "Model capacity is unknown" }
  }
  if (CLEAR_KEYWORDS.has(lower)) {
    return { clear: true }
  }

  const normalized = trimmed.replaceAll(",", "")
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(normalized)
  if (!match) {
    return { error: "Invalid token limit format" }
  }

  const num = Number.parseFloat(match[1] ?? "")
  if (!Number.isFinite(num)) {
    return { error: "Invalid token limit format" }
  }

  const unit = match[2]?.toLowerCase()
  const multiplier = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1
  const tokens = Math.round(num * multiplier)

  if (tokens < MIN_TOKEN_LIMIT) {
    return { error: "Soft limit must be at least 40k tokens" }
  }

  if (hardLimit && tokens > hardLimit) {
    return { tokens: hardLimit, clamped: true }
  }

  return { tokens }
}

/** Resolves opaque session metadata before the model-specific and global configuration fallbacks. */
export function resolveSoftLimit(sessionLimit: unknown, modelLimit?: number, defaultLimit?: number) {
  return [sessionLimit, modelLimit, defaultLimit].find(
    (limit): limit is number => typeof limit === "number" && Number.isFinite(limit) && limit > 0,
  )
}

/** Caps a soft limit at the physical window; zero means the model's capacity is unknown. */
export function effectiveContextWindow(hardWindow: number, softLimit?: number) {
  return hardWindow > 0 ? Math.min(softLimit || hardWindow, hardWindow) : 0
}

/** The shared Core/UI compaction threshold, retaining 15% or at least 16k unless a usable buffer is configured. */
export function calculateCompactionCeiling(hardWindow: number, buffer?: number, softLimit?: number) {
  const window = effectiveContextWindow(hardWindow, softLimit)
  if (window <= 0) return Number.POSITIVE_INFINITY
  if (buffer !== undefined && buffer < window) return window - buffer
  return window - Math.max(Math.floor(window * 0.15), window >= 32_000 ? 16_000 : 0)
}

/**
 * Formats a token number into compact human notation:
 * - 372000 -> "372k"
 * - 1000000 -> "1M"
 */
export function formatTokenLimit(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens === 0) return "0"
  if (tokens < 0) return `-${formatTokenLimit(-tokens)}`

  if (tokens >= 1_000_000) {
    const val = tokens / 1_000_000
    return `${Number(val.toFixed(2))}M`
  }
  if (tokens >= 1_000) {
    const val = tokens / 1_000
    return `${Number(val.toFixed(2))}k`
  }
  return String(Math.round(tokens))
}
