export * as SessionReview from "./review.js"

import { Effect, Schema } from "effect"
import { Agent } from "../agent.js"
import { Bus } from "../bus.js"
import type { Command } from "../command.js"
import { Location } from "../location.js"
import { Model } from "../model.js"
import { Permission } from "../permission.js"
import PROMPT_REVIEW from "../plugin/command/review.txt"
import { Session } from "../session.js"
import { SessionEvent } from "./event.js"
import { ReviewAuthority } from "./review-authority.js"
import { SessionSchema } from "./schema.js"
import { SubagentJob } from "./subagent-job.js"

export const agentID = Agent.ID.make("review")

export class LaunchError extends Schema.TaggedError<LaunchError>()("SessionReview.LaunchError", {
  message: Schema.String,
}) {}

const targetHeading = /^## Review target\r?$/m

export const launch = Effect.fn("SessionReview.launch")(function* (invocation: Command.Invocation) {
  if (invocation.delivery === "queue")
    return yield* new LaunchError({
      message: "Queued delivery is not supported for /review; it starts a reviewer immediately.",
    })

  const sessions = yield* Session.Service
  const agents = yield* Agent.Service
  const permission = yield* Permission.Service
  const subagents = yield* SubagentJob.Service
  const bus = yield* Bus.Service
  const location = yield* Location.Service

  const parent = yield* sessions.get(invocation.sessionID)
  const review = yield* agents.resolve(agentID)
  if (!review) return yield* new LaunchError({ message: `Review agent is unavailable: ${agentID}` })
  if (review.mode === "primary")
    return yield* new LaunchError({ message: `Review agent must be configured as a subagent: ${agentID}` })

  const target = targetPrompt(invocation, location.project.directory)
  if (target === undefined) return yield* new LaunchError({ message: "The review target prompt is unavailable." })

  yield* requireIdle(sessions, parent)
  yield* permission
    .assert({
      action: "subagent",
      resources: [review.id],
      sessionID: parent.id,
      agent: parent.agent,
    })
    .pipe(
      Effect.catchTag("Permission.CorrectedError", (error) =>
        Effect.fail(new LaunchError({ message: declineMessage(error.feedback) })),
      ),
      Effect.catchDefect((defect) =>
        defect instanceof Permission.DeclinedError
          ? Effect.fail(new LaunchError({ message: declineMessage() }))
          : Effect.die(defect),
      ),
    )
  const authority = yield* permission.authority(parent.id, parent.agent)
  yield* requireIdle(sessions, parent)
  const model = yield* resolveModel(review, parent)
  const description = `Review: ${invocation.prompt.text.trim() || "uncommitted changes"}`
  const childID = SessionSchema.ID.create()

  let child: SessionSchema.Info | undefined
  let job: SubagentJob.Handle | undefined

  // A client disconnect must not leave an admitted child without its owned job.
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      child = yield* sessions.create({
        id: childID,
        parentID: parent.id,
        taskName: `review-${childID.slice(-8).toLowerCase()}`,
        title: description,
        agent: review.id,
        model,
        authority: [...authority, ReviewAuthority.rules],
        metadata: { ...(parent.metadata ?? {}), oneShotReview: true },
      })
      yield* sessions.prompt({
        ...invocation.prompt,
        sessionID: child.id,
        text: target,
        resume: false,
      })
      yield* bus.publish(SessionEvent.Synthetic, {
        sessionID: parent.id,
        text: `Host notice: a one-shot review is running in session ${child.id}.`,
        description: `${description} — open the reviewer to inspect or stop it.`,
        metadata: { source: "subagent", childID: child.id, agent: review.name, state: "running" },
      })
      const recovery = {
        kind: "subagent" as const,
        parentSessionID: parent.id,
        childSessionID: child.id,
        agent: review.name,
        description,
        mode: "review" as const,
      }
      job = yield* subagents.start(recovery)
      yield* subagents.background(recovery, job)
      return child
    }).pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          if (job !== undefined) yield* Effect.all([job.interrupt, job.cancel], { discard: true })
          if (child === undefined) {
            // create may have published the child before failing to read it back.
            yield* sessions.interrupt(childID)
            yield* sessions.archive(childID)
            return
          }
          if (job === undefined) yield* sessions.interrupt(child.id)
          yield* sessions.archive(child.id)
        }).pipe(Effect.ignore),
      ),
    ),
  )
})

const resolveModel = Effect.fn("SessionReview.resolveModel")(function* (
  review: Agent.Info,
  parent: SessionSchema.Info,
) {
  // No role override: inherit the caller's exact model and variant.
  if (review.model === undefined && parent.model !== undefined && review.variant === undefined) return parent.model

  const models = yield* Model.Service
  const base = review.model ?? parent.model
  const variant = review.model
    ? (review.model.variant ?? review.variant)
    : (review.variant ?? parent.model?.variant)

  if (base === undefined) {
    const fallback = yield* models.default()
    if (!fallback) return yield* new LaunchError({ message: "No model is available for the review." })
    return yield* validateModel(Model.Ref.make({ providerID: fallback.providerID, id: fallback.id }), variant, fallback)
  }

  const selected = (yield* models.available()).find(
    (model) => model.providerID === base.providerID && model.id === base.id,
  )
  if (!selected)
    return yield* new LaunchError({
      message: `Model "${base.providerID}/${base.id}" is not available for the review.`,
    })
  return yield* validateModel(base, variant, selected)
})

const validateModel = Effect.fnUntraced(function* (
  base: Model.Ref,
  variant: Model.VariantID | undefined,
  selected: Model.Info,
) {
  if (variant !== undefined && variant !== "default" && !selected.variants.some((item) => item.id === variant))
    return yield* new LaunchError({
      message:
        selected.variants.length === 0
          ? `Model "${base.providerID}/${base.id}" has no variants. Omit the variant.`
          : `Variant "${variant}" is not available for "${base.providerID}/${base.id}". Available: ${selected.variants.map((item) => item.id).join(", ")}.`,
    })
  return Model.Ref.make({
    providerID: base.providerID,
    id: base.id,
    ...(variant === undefined ? {} : { variant }),
  })
})

function declineMessage(feedback?: string) {
  const detail = feedback?.trim()
  return detail ? `Review permission was declined: ${detail}` : "Review permission was declined."
}

function requireIdle(sessions: Session.Interface, parent: SessionSchema.Info) {
  return Effect.gen(function* () {
    if ((yield* sessions.active).has(parent.id))
      return yield* new LaunchError({
        message: "Cannot start a review while the current session is executing. Wait for it to finish or stop it first.",
      })
  })
}

function targetPrompt(invocation: Command.Invocation, directory: string) {
  const index = PROMPT_REVIEW.search(targetHeading)
  if (index === -1) return undefined
  return PROMPT_REVIEW.slice(index)
    .replace("${path}", () => directory)
    .replaceAll("$ARGUMENTS", () => invocation.prompt.text.trim())
    .trim()
}
