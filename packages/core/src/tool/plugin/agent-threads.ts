export * as AgentThreadTools from "./agent-threads.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Schema } from "effect"
import { Session } from "../../session.js"
import { SessionStore } from "../../session/store.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentJob } from "../../session/subagent-job.js"
import { SubagentCompletion } from "../../session/subagent-completion.js"
import { Job } from "../../job.js"
import { Permission } from "../../permission.js"
import type { Tool } from "@opencode/schema/tool"

const Target = Schema.String.annotate({ description: "Session ID, canonical /root/task path, or a child task name." })

const OUTCOME_STATUS = { succeeded: "completed", failed: "failed", interrupted: "cancelled" } as const

/**
 * One status vocabulary for every listed agent: a closed or running Session wins, then its job,
 * then the outcome recorded for its last execution.
 */
const agentStatus = (input: {
  readonly archived: boolean
  readonly active: boolean
  readonly job?: Job.Status
  readonly outcome?: SessionSchema.Info["outcome"]
}) => {
  if (input.archived) return "closed"
  if (input.active || input.job === "running") return "running"
  if (input.job === "completed") return "completed"
  if (input.job === "error") return "failed"
  if (input.job === "cancelled") return "cancelled"
  return input.outcome === undefined ? "idle" : OUTCOME_STATUS[input.outcome]
}

export const install = Effect.fn("AgentThreadTools.install")(function* (ctx: Context) {
  const sessions = yield* Session.Service
  const store = yield* SessionStore.Service
  const jobs = yield* Job.Service
  const subagents = yield* SubagentJob.Service
  const permission = yield* Permission.Service

  const tree = Effect.fn("AgentThreadTools.tree")(function* (caller: SessionSchema.ID) {
    let root = yield* sessions.get(caller)
    while (root.parentID) root = yield* sessions.get(root.parentID)
    const entries = [{ session: root, path: "/root" }]
    const children = Map.groupBy(
      yield* store.list({ parentID: root.id, descendants: true, order: "asc" }),
      (session) => session.parentID,
    )
    for (const entry of entries) {
      entries.push(
        ...(children.get(entry.session.id) ?? []).map((session) => ({
          session,
          path: `${entry.path}/${session.taskName ?? session.id}`,
        })),
      )
    }
    return entries
  })

  const resolve = Effect.fn("AgentThreadTools.resolve")(function* (
    caller: SessionSchema.ID,
    target: string,
    owned: boolean,
  ) {
    const entries = yield* tree(caller)
    const origin = entries.find((entry) => entry.session.id === caller)
    if (!origin) return yield* new ToolFailure({ message: "Caller is no longer in this conversation." })
    const entry = entries.find(
      (entry) => entry.session.id === target || entry.path === target || entry.path === `${origin.path}/${target}`,
    )
    if (!entry) return yield* new ToolFailure({ message: `Agent not found in this conversation: ${target}` })
    let owner = entry.session.parentID
    while (owner && owner !== caller) owner = entries.find((item) => item.session.id === owner)?.session.parentID
    if (owned && owner !== caller)
      return yield* new ToolFailure({
        message: "Only your descendants can be controlled. Use send_message to contact a parent or sibling.",
      })
    return entry
  })

  const authorize = (context: Tool.Context, action: string, resource: string) =>
    permission.assert({
      action,
      resources: [resource],
      save: [resource],
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
    })

  const describe = Effect.fn("AgentThreadTools.describe")(function* (entry: {
    session: SessionSchema.Info
    path: string
  }) {
    const active = yield* sessions.active
    const job = yield* jobs.get(entry.session.id)
    const messages = yield* sessions.messages({
      sessionID: entry.session.id,
      type: "assistant",
      order: "desc",
      limit: 1,
    })
    const last = messages[0]
    const thinking = last?.type === "assistant" ? last.thinking : undefined
    const lastResponse = last ? SubagentCompletion.text(last) : undefined
    return {
      sessionID: entry.session.id,
      path: entry.path,
      ...(entry.session.parentID === undefined ? {} : { parentID: entry.session.parentID }),
      ...(entry.session.agent === undefined ? {} : { agent: entry.session.agent }),
      ...(entry.session.title === undefined ? {} : { title: entry.session.title }),
      ...(entry.session.model === undefined ? {} : { model: entry.session.model }),
      ...(thinking === undefined ? {} : { thinking }),
      status: agentStatus({
        archived: entry.session.time.archived !== undefined,
        active: active.has(entry.session.id),
        job: job?.status,
        outcome: entry.session.outcome,
      }),
      ...(lastResponse === undefined ? {} : { last_response: lastResponse }),
    }
  })

  yield* ctx.tool
    .transform((editor) => {
      editor.add({
        name: "list_agents",
        options: { codemode: false, permission: "subagent" },
        description:
          "Inspect the conversation's named agent tree, models, thinking, status and latest responses. Completion notifications arrive automatically; do not poll.",
        input: Schema.Struct({}),
        execute: (_, context) =>
          Effect.gen(function* () {
            yield* authorize(context, "subagent", "*")
            const entries = yield* tree(context.sessionID)
            const output = yield* Effect.forEach(entries, describe)
            return { content: JSON.stringify(output), metadata: { agents: output } }
          }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
      })
      editor.add({
        name: "send_message",
        options: { codemode: false, permission: "subagent" },
        description:
          "Send a message to a running parent, sibling or child. An idle recipient receives it in its durable inbox without being started; use followup_task to resume an idle descendant.",
        input: Schema.Struct({ target: Target, message: Schema.NonEmptyString }),
        execute: (input, context) =>
          Effect.gen(function* () {
            const entry = yield* resolve(context.sessionID, input.target, false)
            if (entry.session.id === context.sessionID)
              return yield* new ToolFailure({ message: "Cannot send a message to yourself." })
            if (entry.session.time.archived)
              return yield* new ToolFailure({ message: "Agent is closed. Use followup_task to reopen it." })
            yield* authorize(context, "subagent", entry.path)
            const active = yield* sessions.active
            yield* sessions.synthetic({
              sessionID: entry.session.id,
              description: `Message from ${context.sessionID}`,
              text: input.message,
              metadata: { source: "agent_message", senderSessionID: context.sessionID },
              resume: active.has(entry.session.id),
            })
            return { content: `Message admitted for ${entry.path}.`, metadata: { sessionID: entry.session.id } }
          }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
      })
      editor.add({
        name: "followup_task",
        options: { codemode: false, permission: "subagent" },
        description:
          "Give an existing descendant a follow-up task. Resumes it when idle or steers its current work; returns immediately with automatic completion notification.",
        input: Schema.Struct({ target: Target, prompt: Schema.NonEmptyString }),
        execute: (input, context) =>
          Effect.gen(function* () {
            const entry = yield* resolve(context.sessionID, input.target, true)
            yield* authorize(context, "subagent", entry.session.agent ?? "general")
            // Validate the target before unarchiving or admitting anything into it.
            const parentSessionID = entry.session.parentID
            if (parentSessionID === undefined)
              return yield* new ToolFailure({ message: "Cannot resume a root as a subagent." })
            yield* sessions.unarchive(entry.session.id)
            yield* sessions.prompt({ sessionID: entry.session.id, text: input.prompt, resume: false })
            // Report running only after the task is actually admitted into the child.
            yield* context.progress({ sessionID: entry.session.id, status: "running" })
            const recovery = {
              kind: "subagent" as const,
              parentSessionID,
              childSessionID: entry.session.id,
              agent: entry.session.agent ?? "general",
              description: entry.session.title ?? entry.path,
            }
            const job = yield* subagents.start(recovery)
            yield* subagents.background(recovery, job)
            return {
              content: `Task admitted for ${entry.path}. Completion will be reported automatically.`,
              metadata: { sessionID: entry.session.id, status: "running" },
            }
          }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
      })
      editor.add({
        name: "wait_agent",
        options: { codemode: false, permission: "subagent" },
        description:
          "Wait for a descendant to become idle without polling. Use when its result is needed to proceed. Does not cancel work on timeout.",
        input: Schema.Struct({
          target: Target,
          timeout_ms: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600000 }))),
        }),
        execute: (input, context) =>
          Effect.gen(function* () {
            const entry = yield* resolve(context.sessionID, input.target, true)
            yield* authorize(context, "subagent", entry.path)
            const finished = yield* sessions
              .wait(entry.session.id)
              .pipe(Effect.timeoutOption(input.timeout_ms ?? 30000))
            const output = {
              timed_out: Option.isNone(finished),
              agent: yield* describe({ ...entry, session: yield* sessions.get(entry.session.id) }),
            }
            return { content: JSON.stringify(output), metadata: { sessionID: entry.session.id } }
          }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
      })
      for (const name of ["interrupt_agent", "close_agent"] as const)
        editor.add({
          name,
          options: { codemode: false, permission: "subagent" },
          description:
            name === "close_agent"
              ? "Interrupt and archive a descendant and its children, preserving their history. followup_task can reopen a thread."
              : "Interrupt a descendant's active work. Its durable conversation remains available for follow-up.",
          input: Schema.Struct({ target: Target }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const entry = yield* resolve(context.sessionID, input.target, true)
              yield* authorize(context, "subagent", entry.path)
              const entries =
                name === "close_agent"
                  ? [
                      entry,
                      ...(yield* store.list({ parentID: entry.session.id, descendants: true })).map((session) => ({
                        session,
                      })),
                    ].toReversed()
                  : [entry]
              yield* Effect.forEach(
                entries,
                (item) =>
                  Effect.gen(function* () {
                    yield* sessions.interrupt(item.session.id)
                    yield* jobs.cancel(item.session.id)
                    yield* sessions.wait(item.session.id)
                    if (name === "close_agent") yield* sessions.archive(item.session.id)
                  }),
                { discard: true },
              )
              // Closing also stops background shell jobs these Sessions own; interrupting leaves them running.
              if (name === "close_agent") {
                const closed = new Set(entries.map((item) => item.session.id))
                const background = yield* jobs.runningBackground
                yield* Effect.forEach(
                  background,
                  (recovery) =>
                    recovery.kind === "shell" && closed.has(recovery.sessionID)
                      ? jobs.cancel(recovery.shellID)
                      : Effect.void,
                  { discard: true },
                )
              }
              return {
                content: `${entry.path}: ${name === "close_agent" ? "closed" : "interrupted"}.`,
                metadata: { sessionID: entry.session.id },
              }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
        })
    })
    .pipe(Effect.orDie)
})
