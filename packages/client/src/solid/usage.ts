import type { ConfigEntry, SessionMessageAssistant, SessionMessageInfo } from "../promise"

/** Resolve each compaction field independently in document order, matching Core's config observer. */
export function compactionSettings(entries: ReadonlyArray<ConfigEntry> | undefined, modelKey?: string) {
  const settings: { modelLimit?: number; defaultLimit?: number; buffer?: number } = {}
  for (const entry of entries ?? []) {
    if (entry.type !== "document" || !entry.info.compaction) continue
    const compaction = entry.info.compaction
    if (modelKey && compaction.soft_limits?.[modelKey] !== undefined)
      settings.modelLimit = compaction.soft_limits[modelKey]
    if (compaction.default_soft_limit !== undefined) settings.defaultLimit = compaction.default_soft_limit
    if (compaction.buffer !== undefined) settings.buffer = compaction.buffer
  }
  return settings
}

/**
 * The assistant step whose tokens fill the context window now: the latest one after the last completed
 * compaction and before the revert boundary. Every client shows context usage from this step, so the TUI
 * and the desktop app agree on it.
 */
export function lastAssistantWithUsage(messages: ReadonlyArray<SessionMessageInfo>, boundary?: string) {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1

  if (boundary && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex

  const compactionIndex = messages.findLastIndex(
    (message, index) => message.type === "compaction" && message.status === "completed" && index < end,
  )

  return messages.findLast(
    (message, index): message is SessionMessageAssistant & { tokens: NonNullable<SessionMessageAssistant["tokens"]> } =>
      message.type === "assistant" && message.tokens !== undefined && index > compactionIndex && index < end,
  )
}
