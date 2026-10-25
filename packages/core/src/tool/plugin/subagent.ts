export * as SubagentTool from "./subagent.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Predicate, Schema, Semaphore } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { Job } from "../../job.js"
import { Model } from "../../model.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentCompletion } from "../../session/subagent-completion.js"
import { SubagentJob } from "../../session/subagent-job.js"
import { AgentThreadTools } from "./agent-threads.js"
import { SessionStore } from "../../session/store.js"

export const name = "subagent"

const backgroundResult = (sessionID: SessionSchema.ID) => ({
  sessionID,
  status: "running" as const,
  output: [
    `The subagent is working in the background (sessionID: ${sessionID}). You will be notified automatically when it finishes.`,
    "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.",
    "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
  ].join("\n"),
})

export const Input = Schema.Struct({
  task_name: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/))).annotate({
    description: "Unique name among this session's children, used in paths such as /root/reviewer.",
  }),
  fork_turns: Schema.optionalKey(Schema.Literals(["none", "all"])).annotate({
    description:
      "Use all to inherit settled history and the parent's role/model/thinking; overrides are then forbidden.",
  }),
  agent: Schema.String.annotate({
    description:
      "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.",
  }),
  description: Schema.String.annotate({ description: "A short 3-5 word label for the task, displayed to the user" }),
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      'Optional model override: "providerID/modelID" or "providerID/modelID#variant". Otherwise use the role model or inherit the caller. Respect user model preferences; use the models tool to find valid IDs.',
  }),
  variant: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description: "Optional thinking variant, independent of model. Use a variant supported by the selected model.",
  }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description:
      "Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress.",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
})
export const description = [
  "Spawns an agent in a child session to work on the specified task.",
  "The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "Foreground (default) runs the subagent to completion and returns its final response.",
  "Background mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.",
  "Use background only for independent work that can run while you continue elsewhere.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const models = yield* Model.Service
    const subagents = yield* SubagentJob.Service
    const store = yield* SessionStore.Service
    const spawning = Semaphore.makeUnsafe(1)
    yield* AgentThreadTools.install(ctx)

    const resolveModel = Effect.fn("SubagentTool.resolveModel")(function* (input: string, variant?: string) {
      const parsed = yield* Effect.try({
        try: () => Model.Ref.parse(input),
        catch: () =>
          new ToolFailure({
            message: `Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`,
          }),
      })
      const ref = variant === undefined ? parsed : { ...parsed, variant: Model.VariantID.make(variant) }
      const model = (yield* models.available()).find(
        (model) => model.providerID === ref.providerID && model.id === ref.id,
      )
      if (model === undefined)
        return yield* new ToolFailure({
          message: `Model "${ref.providerID}/${ref.id}" is not available. Use the models tool to see what is available.`,
        })
      if (
        ref.variant !== undefined &&
        ref.variant !== "default" &&
        !model.variants.some((variant) => variant.id === ref.variant)
      )
        return yield* new ToolFailure({
          message:
            model.variants.length === 0
              ? `Model "${ref.providerID}/${ref.id}" has no variants. Omit the variant.`
              : `Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.id}". Available: ${model.variants.map((variant) => variant.id).join(", ")}.`,
        })
      return ref
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const parent = yield* sessions
                .get(context.sessionID)
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                  ),
                )
              let current = parent
              let depth = 0
              while (current.parentID) {
                depth++
                current = yield* sessions
                  .get(current.parentID)
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${current.parentID}`, error }),
                    ),
                  )
              }
              const limit = Config.latest(yield* config.entries(), "experimental")?.subagent_depth ?? 3
              if (input.sessionID === undefined && depth >= limit)
                return yield* new ToolFailure({
                  message: `Subagent depth limit reached (${limit}). Increase "experimental.subagent_depth" to allow nested subagents.`,
                })
              const fork = input.fork_turns === "all"
              if (fork && (input.model !== undefined || input.variant !== undefined || input.sessionID !== undefined))
                return yield* new ToolFailure({
                  message:
                    "Full-history children inherit role, model and thinking; omit model, variant and sessionID overrides.",
                })
              const agent = yield* agents.resolve(fork ? parent.agent : input.agent)
              if (agent === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${input.agent}` })
              if (!fork && agent.mode === "primary")
                return yield* new ToolFailure({ message: `Agent ${input.agent} cannot run as a subagent` })
              yield* permission
                .assert({
                  action: name,
                  resources: [agent.id],
                  save: [agent.id],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool",
                    messageID: context.messageID,
                    id: context.id,
                  },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Subagent denied: ${agent.id}`, error })))

              const existing =
                input.sessionID === undefined
                  ? undefined
                  : yield* sessions
                      .get(input.sessionID)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                        ),
                      )
              if (existing !== undefined && existing.parentID !== context.sessionID)
                return yield* new ToolFailure({
                  message: `Session ${existing.id} is not a child of the current session`,
                })
              const message = yield* sessions.message({ sessionID: parent.id, messageID: context.messageID })
              const inherited = message?.type === "assistant" ? message.model : parent.model
              const switched = existing !== undefined && existing.agent !== agent.id
              const base = existing && !switched ? existing.model : (agent.model ?? inherited)
              const variant = fork
                ? undefined
                : (input.variant ?? (existing && !switched ? undefined : (agent.model?.variant ?? agent.variant)))
              const selected =
                base ??
                (variant === undefined
                  ? undefined
                  : yield* models
                      .default()
                      .pipe(Effect.map((model) => model && { providerID: model.providerID, id: model.id })))
              if (variant !== undefined && !selected && input.model === undefined)
                return yield* new ToolFailure({ message: "No model is available for the requested thinking variant." })
              const override =
                input.model !== undefined
                  ? yield* resolveModel(
                      input.model,
                      input.variant ?? (input.model.includes("#") ? undefined : agent.variant),
                    )
                  : variant === "default" && selected
                    ? { ...selected, variant: Model.VariantID.make("default") }
                    : variant !== undefined && selected
                      ? yield* resolveModel(`${selected.providerID}/${selected.id}`, variant)
                      : undefined
              // Continuing with a different agent switches the child, mirroring create semantics
              // where an explicit model wins over the agent's configured model, which wins over the inherited one.
              if (existing !== undefined) {
                const model = override ?? (switched ? agent.model : undefined)
                yield* Effect.all([
                  switched ? sessions.switchAgent({ sessionID: existing.id, agent: agent.id }) : Effect.void,
                  model === undefined ? Effect.void : sessions.switchModel({ sessionID: existing.id, model }),
                ]).pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to switch subagent session: ${existing.id}`, error }),
                  ),
                )
              }

              const model = override ?? agent.model ?? inherited
              const child =
                existing ??
                (yield* spawning
                  .withPermit(
                    Effect.gen(function* () {
                      const taskName =
                        input.task_name ??
                        `${agent.id
                          .replace(/[^a-z0-9_-]/gi, "-")
                          .slice(0, 48)
                          .toLowerCase()}-${SessionSchema.ID.create().slice(-8).toLowerCase()}`
                      if ((yield* store.list({ parentID: parent.id })).some((session) => session.taskName === taskName))
                        return yield* new ToolFailure({
                          message: `Task name already exists: ${taskName}. Use followup_task to continue it.`,
                        })
                      const authority = yield* permission.authority(parent.id, context.agent)
                      if (fork)
                        return yield* sessions.fork({
                          sessionID: parent.id,
                          delegation: {
                            taskName,
                            title: input.description,
                            agent: agent.id,
                            model: inherited,
                            authority,
                          },
                        })
                      return yield* sessions.create({
                        parentID: parent.id,
                        taskName,
                        title: input.description,
                        agent: agent.id,
                        model,
                        authority,
                      })
                    }),
                  )
                  .pipe(
                    Effect.mapError((error) =>
                      error instanceof ToolFailure
                        ? error
                        : new ToolFailure({ message: `Failed to create child: ${error.message}`, error }),
                    ),
                  ))

              const background = input.background === true
              yield* context.progress({ sessionID: child.id, status: "running" })

              // Steer a running child, but let the job start an idle child from its admitted prompt.
              // Waking here too would race the job and can start a second, inputless execution.
              const running = (yield* sessions.active).has(child.id)
              yield* sessions
                .prompt({
                  sessionID: child.id,
                  text:
                    existing === undefined
                      ? ["You are a subagent spawned by another session.", input.prompt].join("\n")
                      : input.prompt,
                  ...(running ? {} : { resume: false }),
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to prompt subagent: ${child.id}`, error }),
                  ),
                )

              const recovery = {
                kind: "subagent" as const,
                parentSessionID: context.sessionID,
                childSessionID: child.id,
                agent: agent.name,
                description: input.description,
              }
              yield* subagents.start(recovery)

              if (background) {
                yield* subagents.background(recovery)
                return backgroundResult(child.id)
              }

              const result = yield* jobs.block({ id: child.id, sessionID: context.sessionID }).pipe(
                Effect.onInterrupt(() =>
                  Effect.all([sessions.interrupt(child.id), jobs.cancel(child.id)], {
                    discard: true,
                  }),
                ),
              )
              if (result?.type === "backgrounded") {
                yield* subagents.notify(recovery, result.info.started_at)
                return backgroundResult(child.id)
              }
              // Failure surfaces keep the sessionID visible so the model can continue the child.
              if (result?.info.status === "error")
                return yield* new ToolFailure({
                  message: `Subagent failed (sessionID: ${child.id}): ${result.info.error ?? "unknown error"}`,
                })
              if (result?.info.status === "cancelled")
                return yield* new ToolFailure({ message: `Subagent cancelled (sessionID: ${child.id})` })
              return {
                sessionID: child.id,
                status: "completed" as const,
                output: result?.info.output ?? SubagentCompletion.NO_TEXT,
              }
            }).pipe(
              Effect.map((output) => ({
                output,
                content:
                  output.status === "completed"
                    ? `<subagent sessionID="${output.sessionID}" state="completed">\n${output.output}\n</subagent>`
                    : output.output,
                metadata: { sessionID: output.sessionID, status: output.status },
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)

    yield* ctx.tool
      .transform((editor) => {
        const original = editor.get(name)
        if (!original) return
        editor.add({
          ...original,
          name: "spawn_agent",
          options: { codemode: false, permission: name },
          input: Schema.Struct({ ...Input.fields, agent: Schema.optionalKey(Schema.String) }),
          description: `${description}\nStarts in the background by default. Use task_name for a stable path.`,
          execute: (input, context) => {
            if (input.fork_turns === "all" && input.agent !== undefined)
              return Effect.fail(new ToolFailure({ message: "Full-history children inherit their role; omit agent." }))
            return original.execute(
              { ...input, agent: input.agent ?? "general", background: input.background ?? true },
              context,
            )
          },
        })
      })
      .pipe(Effect.orDie)

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.sync(() => {
        if (event.tool !== name || !Predicate.isObject(event.input)) return
        if (event.input.model !== "" && event.input.sessionID !== "") return
        const input = { ...event.input }
        if (input.model === "") delete input.model
        if (input.sessionID === "") delete input.sessionID
        event.input = input
      }),
    )

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tools = [event.tools[name], event.tools.spawn_agent].filter((tool) => tool !== undefined)
        if (!tools.length) return
        const selected = yield* agents.resolve(event.agent)
        if (!selected) return
        const available = (yield* agents.list())
          .filter(
            (agent) =>
              agent.mode !== "primary" &&
              !agent.hidden &&
              Permission.evaluate(name, agent.id, selected.permissions).effect !== "deny",
          )
          .toSorted((a, b) => a.id.localeCompare(b.id))
        if (available.length === 0) return
        for (const tool of tools) {
          tool.description = [
            tool.description,
            "",
            "Available subagents:",
            ...available.map((agent) =>
              [
                `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`,
                agent.model ? `Model: ${agent.model.providerID}/${agent.model.id}.` : "Model: inherited.",
                (agent.model?.variant ?? agent.variant)
                  ? `Thinking variant: ${agent.model?.variant ?? agent.variant}.`
                  : "",
              ]
                .filter(Boolean)
                .join(" "),
            ),
          ].join("\n")
        }
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
