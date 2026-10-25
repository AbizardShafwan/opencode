import type { SessionMessageAssistant } from "@opencode/client/promise"

type Step = Pick<SessionMessageAssistant, "time" | "tokens">

/**
 * Output tokens per second for one completed turn, weighted by each step's provider-active duration.
 * Matches the TUI footer: reasoning counts as output, and a step without a streamed timestamp makes
 * the rate unavailable rather than guessing from the step's total duration.
 */
export function turnTokensPerSecond(steps: readonly Step[]) {
  if (steps.length === 0) return
  const durations = steps.flatMap((step) =>
    step.time.streamed === undefined ? [] : [Math.max(0, step.time.streamed - step.time.created)],
  )
  if (durations.length !== steps.length) return
  const output = steps.reduce(
    (total, step) => total + (step.tokens?.output ?? 0) + (step.tokens?.reasoning ?? 0),
    0,
  )
  const duration = durations.reduce((total, value) => total + value, 0)
  if (output <= 0 || duration <= 0) return
  return output / (duration / 1_000)
}
