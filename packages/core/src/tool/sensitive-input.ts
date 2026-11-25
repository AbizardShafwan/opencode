export * as SensitiveInput from "./sensitive-input.js"

import { isRecord } from "@opencode/ai/utils/record"
import { Option, Schema } from "effect"

export const REDACTED = "[REDACTED]"

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** Replaces the values of sensitive top-level keys; other values and non-record inputs pass through. */
export function redact(input: unknown, keys: ReadonlyArray<string> | undefined): unknown {
  if (keys === undefined || keys.length === 0 || !isRecord(input)) return input
  if (!keys.some((key) => key in input)) return input
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, keys.includes(key) ? REDACTED : value] as const),
  )
}

/**
 * Redacts sensitive keys in raw tool-argument JSON. Text that cannot be parsed into an object may still
 * contain a secret, so it is masked whole.
 */
export function redactJsonText(text: string, keys: ReadonlyArray<string> | undefined) {
  if (keys === undefined || keys.length === 0) return text
  const parsed = Option.getOrUndefined(decodeJson(text))
  if (!isRecord(parsed)) return REDACTED
  return JSON.stringify(redact(parsed, keys))
}
