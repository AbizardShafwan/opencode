import { expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Job } from "@opencode/core/job"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { testEffect } from "./lib/effect"

const recovery = {
  kind: "subagent" as const,
  parentSessionID: Session.ID.make("ses_subagent_job_parent"),
  childSessionID: Session.ID.make("ses_subagent_job_child"),
  agent: "general",
  description: "Background task",
}

// The mocked layer only needs the members `start` reads: scheduling, observed jobs, and the child's messages.
const build = (input: {
  readonly messages: ReadonlyArray<{ readonly type: string; readonly content: ReadonlyArray<unknown> }>
  readonly runs: Array<Effect.Effect<string, unknown>>
}) =>
  testEffect(
    AppNodeBuilder.build(LayerNode.group([SubagentJob.node]), [
      Session.node.replace(
        Layer.mock(Session.Service, {
          messages: () => Effect.succeed(input.messages as never),
          revert: {
            stage: () => Effect.die("unused session.revert.stage"),
            clear: () => Effect.die("unused session.revert.clear"),
            commit: () => Effect.die("unused session.revert.commit"),
          },
        }),
      ),
      SessionExecution.node.replace(
        Layer.mock(SessionExecution.Service, {
          // Nothing promotable and no active execution: the child will not run on its own.
          schedule: () => Effect.succeed(undefined),
        }),
      ),
      SessionStore.node.replace(Layer.mock(SessionStore.Service, {})),
      Job.node.replace(
        Layer.mock(Job.Service, {
          observe: () => Effect.succeed(undefined),
          startObserved: (started) =>
            Effect.sync(() => {
              input.runs.push(started.run)
              return {
                owner: {},
                info: {
                  id: started.id,
                  type: started.type,
                  title: started.title,
                  status: "running" as const,
                  started_at: 0,
                },
                wait: () => Effect.succeed({ timedOut: false }),
                block: () => Effect.die("unused job.block"),
                background: Effect.succeed(undefined),
                cancel: Effect.succeed(undefined),
              }
            }),
        }),
      ),
    ]),
  )

const emptyRuns: Array<Effect.Effect<string, unknown>> = []
build({ messages: [], runs: emptyRuns }).effect(
  "fails cleanly when the child has neither an execution nor a reply",
  () =>
    Effect.gen(function* () {
      const service = yield* SubagentJob.Service

      const job = yield* service.start(recovery)
      expect(job.info.status).toBe("running")

      const exit = yield* Effect.exit(emptyRuns[0]!)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(exit._tag === "Failure" ? Cause.pretty(exit.cause) : "").toContain("was not scheduled")
      expect(exit._tag === "Failure" ? Cause.pretty(exit.cause) : "").toContain(recovery.childSessionID)
    }),
)

const replayRuns: Array<Effect.Effect<string, unknown>> = []
build({
  messages: [{ type: "assistant", content: [{ type: "text", text: "All tests pass." }] }],
  runs: replayRuns,
}).effect("reports the child's recorded reply when nothing is left to run", () =>
  Effect.gen(function* () {
    const service = yield* SubagentJob.Service

    yield* service.start(recovery)

    expect(yield* replayRuns[0]!).toBe("All tests pass.")
  }),
)
