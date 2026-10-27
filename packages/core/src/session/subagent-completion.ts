export * as SubagentCompletion from "./subagent-completion.js"

import { Effect } from "effect"
import type { Job } from "../job.js"
import type { Session } from "../session.js"
import { SessionMessage } from "./message.js"
import { ReviewReport } from "./review-report.js"
import { SessionStore } from "./store.js"

export const NO_TEXT = "Subagent completed without a text response."

type Recovery = Extract<Job.Recovery, { kind: "subagent" }>
type TerminalStatus = Exclude<Job.Status, "running">
type DeliveryInput = Pick<Job.Info, "status" | "output" | "error" | "notificationID"> & {
  recovery: Recovery
  resume?: boolean
  /** Restart recovery only: a durable child terminal outcome proves a running marker stale. */
  terminal?: boolean
}

export function text(message: SessionMessage.Info | undefined) {
  if (message?.type !== "assistant") return NO_TEXT
  return (
    message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .filter((text) => text.length > 0)
      .join("\n\n") || NO_TEXT
  )
}

export const deliver = Effect.fnUntraced(function* (
  sessions: Pick<Session.Interface, "synthetic" | "archive">,
  jobs: Pick<Job.Interface, "completeBackground" | "pendingBackground">,
  input: DeliveryInput,
) {
  if (input.status === "running") return
  const recovery = input.recovery
  if (recovery.mode === "review") return yield* deliverReview(sessions, jobs, { ...input, status: input.status })
  const text =
    input.status === "completed"
      ? (input.output ?? NO_TEXT)
      : input.status === "error"
        ? (input.error ?? "Subagent failed")
        : "Subagent cancelled"
  yield* sessions.synthetic({
    ...(input.notificationID ? { id: input.notificationID } : {}),
    sessionID: recovery.parentSessionID,
    ...(input.resume === false ? { resume: false } : {}),
    description: recovery.description,
    text: subagentMessage(recovery, input.status, text),
    metadata: { source: "subagent", childID: recovery.childSessionID, agent: recovery.agent, state: input.status },
  })
  if (input.notificationID) yield* jobs.completeBackground(input.notificationID)
})

function subagentMessage(recovery: Recovery, status: TerminalStatus, text: string) {
  return `<subagent sessionID="${recovery.childSessionID}" state="${status}" description="${recovery.description}">\n${text}\n</subagent>`
}

const deliverReview = Effect.fnUntraced(function* (
  sessions: Pick<Session.Interface, "synthetic" | "archive">,
  jobs: Pick<Job.Interface, "completeBackground" | "pendingBackground">,
  input: DeliveryInput & { status: TerminalStatus },
) {
  const recovery = input.recovery
  const notificationID = input.notificationID
  if (!notificationID) return yield* Effect.die(new Error("Review completion requires a persisted notification ID"))

  if (input.status === "cancelled" && !input.terminal) {
    // Shutdown keeps the durable marker running; only a deliberate cancellation
    // has already persisted its terminal status. Restart recovery may instead
    // prove the child terminal from its durable outcome.
    const marker = (yield* jobs.pendingBackground).find((item) => item.notificationID === notificationID)
    if (marker?.status === "running") return
  }

  const store = yield* SessionStore.Service
  const description = `${recovery.description} — ${statusWord(input.status)}`
  const metadata = {
    source: "subagent",
    childID: recovery.childSessionID,
    agent: recovery.agent,
    state: input.status,
  }

  const existing = yield* store.message(notificationID)
  if (existing) {
    if (existing.sessionID !== recovery.parentSessionID)
      return yield* Effect.die(
        new Error(
          `Review completion ${notificationID} belongs to session ${existing.sessionID}, expected ${recovery.parentSessionID}`,
        ),
      )
    if (existing.message.type !== "synthetic")
      return yield* Effect.die(
        new Error(`Review completion ${notificationID} has type ${existing.message.type}, expected synthetic`),
      )
    const delivered = existing.message.metadata
    if (delivered?.source !== "subagent" || delivered.childID !== recovery.childSessionID)
      return yield* Effect.die(
        new Error(`Review completion ${notificationID} does not belong to child ${recovery.childSessionID}`),
      )
    if (delivered.state !== input.status)
      return yield* Effect.die(
        new Error(`Review completion ${notificationID} has state ${String(delivered.state)}, expected ${input.status}`),
      )
  }
  if (!existing) {
    const parent = yield* store.get(recovery.parentSessionID)
    if (parent)
      yield* sessions
        .synthetic({
          id: notificationID,
          sessionID: recovery.parentSessionID,
          ...(input.resume === false ? { resume: false } : {}),
          description,
          text: subagentMessage(recovery, input.status, reviewDeliveryText(input)),
          metadata,
        })
        .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void))
  }

  yield* sessions
    .archive(recovery.childSessionID)
    .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void))
  yield* jobs.completeBackground(notificationID)
})

function reviewDeliveryText(input: DeliveryInput & { status: TerminalStatus }) {
  const context =
    input.status === "completed"
      ? "The user requested a one-shot review. Use the report below to respond with the findings and take the appropriate follow-up action."
      : "The user requested a one-shot review, but it did not complete. Respond to the user with the outcome."
  return [context, "", reviewText(input)].join("\n")
}

function reviewText(input: DeliveryInput & { status: TerminalStatus }) {
  if (input.status === "completed") {
    const output = input.output === NO_TEXT ? "" : (input.output ?? "")
    return ReviewReport.render(output)
  }
  if (input.status === "error")
    return [
      "## Review failed",
      "",
      "The reviewer did not complete, so this is not a review result.",
      "",
      input.error ?? "The reviewer failed without an error message.",
    ].join("\n")
  return ["## Review cancelled", "", "The reviewer was cancelled before producing a review result."].join("\n")
}

function statusWord(status: TerminalStatus) {
  return status === "completed" ? "completed" : status === "error" ? "failed" : "cancelled"
}
