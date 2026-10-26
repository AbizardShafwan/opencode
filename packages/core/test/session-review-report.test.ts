import { describe, expect, test } from "bun:test"
import { ReviewReport } from "@opencode/core/session/review-report"

const report = () => ({
  findings: [
    {
      title: "[P1] Guard the missing value",
      body: "`read` can return `undefined` here.",
      confidence_score: 0.9,
      priority: 1,
      code_location: {
        absolute_file_path: "/repo/src/index.ts",
        line_range: { start: 10, end: 12 },
      },
    },
  ],
  overall_correctness: "patch is incorrect" as const,
  overall_explanation: "The read path can crash.",
  overall_confidence_score: 0.8,
})

const withFinding = (finding: Record<string, unknown>) =>
  JSON.stringify({ ...report(), findings: [{ ...report().findings[0], ...finding }] })

describe("ReviewReport", () => {
  test("parses a direct JSON report", () => {
    expect(ReviewReport.parse(JSON.stringify(report()))).toEqual(report())
  })

  test("parses a fenced report surrounded by prose", () => {
    const text = ["Review complete.", "", "```json", JSON.stringify(report()), "```", "", "Thanks."].join("\n")
    expect(ReviewReport.parse(text)).toEqual(report())
  })

  test("parses a report surrounded by prose", () => {
    const text = `Review complete.\n\n${JSON.stringify(report())}\n\nLet me know if you need more.`
    expect(ReviewReport.parse(text)).toEqual(report())
  })

  test("accepts an omitted or null priority", () => {
    const finding = { ...report().findings[0], priority: undefined }
    expect(ReviewReport.parse(withFinding(finding))?.findings[0]?.priority).toBeUndefined()
    expect(ReviewReport.parse(withFinding({ ...finding, priority: null }))?.findings[0]?.priority).toBeNull()
  })

  test("rejects malformed output", () => {
    expect(ReviewReport.parse("The change looks fine to me.")).toBeUndefined()
    expect(ReviewReport.parse("")).toBeUndefined()
  })

  test("rejects out-of-range confidence", () => {
    expect(ReviewReport.parse(withFinding({ confidence_score: 1.5 }))).toBeUndefined()
    expect(ReviewReport.parse(withFinding({ confidence_score: -0.1 }))).toBeUndefined()
    expect(ReviewReport.parse(JSON.stringify({ ...report(), overall_confidence_score: 2 }))).toBeUndefined()
  })

  test("rejects a relative file path", () => {
    expect(
      ReviewReport.parse(
        withFinding({ code_location: { absolute_file_path: "src/index.ts", line_range: { start: 1, end: 1 } } }),
      ),
    ).toBeUndefined()
  })

  test("rejects a non-positive or unordered line range", () => {
    for (const line_range of [
      { start: 0, end: 1 },
      { start: 4, end: 2 },
    ])
      expect(
        ReviewReport.parse(
          withFinding({ code_location: { absolute_file_path: "/repo/src/index.ts", line_range } }),
        ),
      ).toBeUndefined()
  })

  test("rejects a priority outside the rubric's range", () => {
    expect(ReviewReport.parse(withFinding({ priority: 4 }))).toBeUndefined()
  })

  test("renders findings with their path, range and confidence", () => {
    const markdown = ReviewReport.render(JSON.stringify(report()))
    expect(markdown).toContain("## Review report")
    expect(markdown).toContain("**Overall correctness:** patch is incorrect (confidence 0.8)")
    expect(markdown).toContain("[P1] Guard the missing value")
    expect(markdown).toContain("`/repo/src/index.ts:10-12` · confidence 0.9")
    expect(markdown).toContain("The read path can crash.")
  })

  test("preserves malformed output instead of reporting no findings", () => {
    const raw = "I could not analyze this change."
    const markdown = ReviewReport.render(raw)
    expect(markdown).toContain(raw)
    expect(markdown).toContain("did not match the review report format")
    expect(markdown.toLowerCase()).not.toContain("no findings")
  })

  test("preserves an empty response instead of reporting no findings", () => {
    const markdown = ReviewReport.render("   ")
    expect(markdown).toContain("empty response")
    expect(markdown.toLowerCase()).not.toContain("no findings")
  })

  test("renders an explicitly empty findings list", () => {
    const markdown = ReviewReport.render(
      JSON.stringify({ ...report(), findings: [], overall_correctness: "patch is correct" }),
    )
    expect(markdown).toContain("No findings were reported.")
  })
})
