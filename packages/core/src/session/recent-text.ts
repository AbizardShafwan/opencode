export * as SessionRecentText from "./recent-text.js"

import type { SessionMessage } from "./message.js"

const TOOL_OUTPUT_MAX_CHARS = 1_250
/**
 * A link the next agent can still follow after truncation: a T3 thread deep link, or a pull request,
 * merge request, or issue URL. Only the target is kept, because that is what survives a summary.
 */
const LINK_PATTERN =
  /t3-thread:\/\/[^\s)\]"'<>]+|https?:\/\/[^\s)\]"'<>]*\/(?:pull|pull_request|pullrequests|issues|merge_requests)\/\d+[^\s)\]"'<>]*/g
/** Characters of preserved links appended to a truncated tool output, so the notice stays compact. */
const LINK_BUDGET = 800
const LINK_MAX = 6

/**
 * The text of the messages a summary compaction kept verbatim. History rebuilds it from `metadata.keepID`;
 * compactions written before that reference carry the text they stored.
 */
export const kept = (message: SessionMessage.CompactionCompleted) =>
  typeof message.metadata?.recent === "string" ? message.metadata.recent : ""

/** One message as the recent, verbatim part of a summary shows it. Empty for messages that part leaves out. */
export const messageToText = (message: SessionMessage.Info): string => {
  switch (message.type) {
    // Earlier summaries and instruction updates are handled outside the recent part.
    case "compaction":
    case "system":
      return ""

    case "user": {
      const skills =
        message.skills?.flatMap((skill) =>
          skill.text === undefined ? [] : [`[Skill activated: ${skill.name}]\n${skill.text}`],
        ) ?? []
      const files =
        message.files?.map((file) => {
          const name = file.name ?? (file.source.type === "uri" ? file.source.uri : "inline attachment")
          return `[Attached ${file.mime}: ${name}]`
        }) ?? []
      return [...skills, `[User]: ${message.text}`, ...files].join("\n")
    }

    case "location-switched":
      return `[User]: The working directory has been changed to ${message.location.directory}.`

    case "assistant":
      return message.content
        .flatMap((part) => {
          if (part.type === "text") return [`[Assistant]: ${part.text}`]
          // Providers return summaries of the real reasoning, and written out as text it can read like an attempt to
          // extract the model's thinking.
          if (part.type === "reasoning") return []

          const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
          const call = `[Assistant tool call]: ${part.name}(${input})`
          if (part.state.status === "completed") {
            return [call, `[Tool result]: ${truncateToolOutput(serializeToolContent(part.state.content))}`]
          }
          if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error.message}`]
          return [call]
        })
        .join("\n")

    case "synthetic":
      return `[Synthetic context]: ${message.text}`

    case "skill":
      return `[Skill activated: ${message.name}]\n${message.text}`

    case "shell":
      if (message.metadata?.background === true) return ""
      return `[Shell]: ${message.command}\n${truncateToolOutput(message.output?.output ?? "")}`

    default:
      return ""
  }
}

export const truncateToolOutput = (value: string) => {
  if (value.length <= TOOL_OUTPUT_MAX_CHARS) return value

  // Count code points so a surrogate pair is never split.
  let end = 0
  let kept = 0
  for (const char of value) {
    if (kept === TOOL_OUTPUT_MAX_CHARS) break
    end += char.length
    kept++
  }
  if (end === value.length) return value
  const links = preservedLinks(value.slice(end))
  // A thread, pull request, or issue link is often the only durable handle in a long output, so carry it forward.
  const notice = links.length === 0 ? "" : `\n[Links from truncated output: ${links.join(" ")}]`
  return `${value.slice(0, end)}\n[truncated]${notice}`
}

function preservedLinks(tail: string) {
  const links: string[] = []
  const seen = new Set<string>()
  let budget = LINK_BUDGET
  for (const match of tail.matchAll(LINK_PATTERN)) {
    // Sentence punctuation after a URL is not part of it.
    const link = match[0].replace(/[.,;:]+$/, "")
    if (!link || seen.has(link) || link.length > budget) continue
    seen.add(link)
    budget -= link.length
    links.push(link)
    if (links.length === LINK_MAX) break
  }
  return links
}

export const serializeToolContent = (content: ReadonlyArray<SessionMessage.ToolStateCompleted["content"][number]>) =>
  content
    .map((item) => {
      if (item.type === "text") return item.text
      return `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`
    })
    .join("\n")
