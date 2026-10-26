export * as SubagentJob from "./subagent-job.js"

import { Cause, Context, Effect, Exit, Layer, Scope } from "effect"
import { Node } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "../bus.js"
import { Job } from "../job.js"
import { Session } from "../session.js"
import { SubagentCompletion } from "./subagent-completion.js"
import { SessionExecution } from "./execution.js"
import { SessionStore } from "./store.js"

type Recovery = Extract<Job.Recovery, { kind: "subagent" }>

export interface Handle extends Job.Handle {
  /** Stops only the execution servicing this receipt, never a later successor. */
  readonly interrupt: Effect.Effect<boolean>
}

export interface Interface {
  start: (recovery: Recovery) => Effect.Effect<Handle>
  background: (recovery: Recovery, job: Job.Handle) => Effect.Effect<void>
  notify: (recovery: Recovery, job: Job.Handle) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentJob") {}

/** Converts the captured execution outcome, preserving user cancellation versus shutdown recovery. */
export const result = (receipt: SessionExecution.Receipt) =>
  Effect.gen(function* () {
    const outcome = yield* receipt.outcome
    if (Exit.isSuccess(outcome.exit)) return SubagentCompletion.text(outcome.exit.value || undefined)
    if (Cause.hasInterruptsOnly(outcome.exit.cause) && outcome.reason === "user") return yield* new Job.Cancelled()
    return yield* Effect.failCause(outcome.exit.cause)
  })

const make: Effect.Effect<
  Interface,
  never,
  Session.Service | Job.Service | SessionExecution.Service | Bus.Service | SessionStore.Service | Scope.Scope
> = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const jobs = yield* Job.Service
  const execution = yield* SessionExecution.Service
  const bus = yield* Bus.Service
  const store = yield* SessionStore.Service
  const scope = yield* Scope.Scope
  // Jobs and their completion observers outlive the plugin that launched them.
  // Fork with the global context too, rather than retaining the caller's location.
  const context = yield* Effect.context<never>()
  // One observer per job generation, including continuations of the same child.
  const notifications = new Set<object>()

  const notify = Effect.fn("SubagentJob.notify")(function* (recovery: Recovery, job: Job.Handle) {
    const key = job.owner
    if (notifications.has(key)) return
    notifications.add(key)
    yield* Effect.gen(function* () {
      const info = (yield* job.wait()).info
      if (info)
        yield* SubagentCompletion.deliver(sessions, jobs, { ...info, recovery }).pipe(
          Effect.provideService(Bus.Service, bus),
          Effect.provideService(SessionStore.Service, store),
        )
    }).pipe(
      Effect.ensuring(Effect.sync(() => notifications.delete(key))),
      Effect.forkIn(scope, { startImmediately: true }),
      Effect.setContext(context),
    )
  })

  return Service.of({
    start: (recovery: Recovery) =>
      Effect.gen(function* () {
        // Scheduling belongs to admission, not Job registration: an older generation may
        // still be collecting its result after this Session has already become idle.
        const receipt = yield* execution.schedule(recovery.childSessionID)
        if (!receipt) {
          const existing = yield* jobs.observe(recovery.childSessionID)
          if (existing) return { ...existing, interrupt: Effect.succeed(false) }
        }
        const job = yield* jobs.startObserved({
          id: recovery.childSessionID,
          type: "subagent",
          title: recovery.description,
          metadata: {},
          recovery,
          owner: receipt?.owner,
          run: receipt ? result(receipt) : Effect.succeed(SubagentCompletion.NO_TEXT),
        })
        return {
          ...job,
          interrupt: receipt
            ? execution.interrupt(recovery.childSessionID, { owner: receipt.owner })
            : Effect.succeed(false),
        }
      }).pipe(Effect.uninterruptible, Effect.setContext(context)),
    background: Effect.fn("SubagentJob.background")(function* (recovery: Recovery, job: Job.Handle) {
      const info = yield* job.background
      if (info) yield* notify(recovery, job)
    }),
    notify,
  })
})

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, make),
  deps: [Session.node, Job.node, SessionExecution.node, Bus.node, SessionStore.node],
})
