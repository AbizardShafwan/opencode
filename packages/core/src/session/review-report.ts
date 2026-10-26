export * as ReviewReport from "./review-report.js"

import path from "path"
import { Option, Schema } from "effect"

const Confidence = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

const CodeLocation = Schema.Struct({
  absolute_file_path: Schema.String.check(
    Schema.makeFilter((value) =>
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value) ? undefined : "an absolute file path",
    ),
  ),
  line_range: Schema.Struct({
    start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    end: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }).check(
    Schema.makeFilter((range) => (range.end >= range.start ? undefined : "an ordered line range"), {
      expected: "end to be greater than or equal to start",
    }),
  ),
})

export const Finding = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  confidence_score: Confidence,
  priority: Schema.optional(Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })))),
  code_location: CodeLocation,
})
export type Finding = typeof Finding.Type

export interface Report extends Schema.Schema.Type<typeof Report> {}
export const Report = Schema.Struct({
  findings: Schema.Array(Finding),
  overall_correctness: Schema.Literals(["patch is correct", "patch is incorrect"]),
  overall_explanation: Schema.String,
  overall_confidence_score: Confidence,
})

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeReport = Schema.decodeUnknownOption(Report)
const fence = /```[^\n]*\n([\s\S]*?)```/g

/** Returns a report only when the model produced a valid structured result. */
export function parse(text: string): Report | undefined {
  for (const candidate of candidates(text)) {
    const value = Option.getOrUndefined(decodeJson(candidate))
    if (value === undefined) continue
    const report = Option.getOrUndefined(decodeReport(value))
    if (report !== undefined) return report
  }
}

/**
 * Renders the review for the parent. Invalid or empty output stays visible and is
 * never presented as a clean review.
 */
export function render(text: string) {
  const report = parse(text)
  if (report === undefined) return unparsed(text)
  const findings = report.findings.flatMap((finding, index) => [
    `### ${index + 1}. ${finding.title}`,
    "",
    `\`${finding.code_location.absolute_file_path}:${finding.code_location.line_range.start}-${finding.code_location.line_range.end}\` · confidence ${finding.confidence_score}`,
    "",
    finding.body,
    "",
  ])
  return [
    "## Review report",
    "",
    `**Overall correctness:** ${report.overall_correctness} (confidence ${report.overall_confidence_score})`,
    "",
    report.overall_explanation,
    "",
    "### Findings",
    "",
    ...(report.findings.length === 0 ? ["No findings were reported."] : findings),
  ]
    .join("\n")
    .trimEnd()
}

function candidates(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return []
  const fenced = Array.from(trimmed.matchAll(fence), (match) => match[1]?.trim() ?? "")
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  // Surrounding prose is common even though the rubric forbids it.
  const wrapped = start >= 0 && end > start ? [trimmed.slice(start, end + 1)] : []
  return [trimmed, ...fenced, ...wrapped].filter(
    (value, index, all) => value.length > 0 && all.indexOf(value) === index,
  )
}

function unparsed(text: string) {
  const raw = text.trim()
  if (!raw) return "The reviewer returned an empty response; no review report was produced."
  return [
    "The reviewer response did not match the review report format, so it was not interpreted as a no-findings result. Raw response:",
    "",
    "````text",
    raw,
    "````",
  ].join("\n")
}
