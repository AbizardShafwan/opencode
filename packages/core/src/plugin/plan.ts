export * as PlanPlugin from "./plan.js"

import { Message, ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import type { SessionEvent } from "@opencode/schema/session-event"
import { Global } from "@opencode/util/global"
import { Effect, Stream } from "effect"
import path from "path"
import { Permission } from "../permission.js"

import PLAN from "../session/runner/prompt/plan.txt"
import DEFAULT from "../session/runner/prompt/default.txt"

const plan = Agent.ID.make("plan")

const enter = (directory: string) => `<system-reminder>
${PLAN.trim()}

## Harness contract
Discuss plans in the conversation. Do not create or update plan files unless the user explicitly requests them; write those only in:
${directory}

Do not modify any other files or ask a subagent to do so. If implementation is requested, tell the user to switch agents first.
</system-reminder>`

const leave = `<system-reminder>
${DEFAULT.trim()}
</system-reminder>`

export const Plugin = define({
  id: "opencode.plan",
  effect: Effect.fn(function* (ctx) {
    const global = yield* Global.Service
    const directory = path.join(global.home, `.${Global.name}`, "plan")
    const enterReminder = enter(directory)
    yield* ctx.agent.transform((editor) => {
      editor.update(plan, (item) => {
        item.name = Agent.Name.make("Plan")
        item.description = "Read-only agent for exploring the codebase and planning work before implementation."
        item.mode = "primary"
        item.permissions.push(...permissions(directory))
      })
    })

    yield* ctx.tool.hook("execute.after", (event) => {
      if (event.agent !== plan) return Effect.void
      if (event.status !== "error") return Effect.void
      if (event.tool !== "edit" && event.tool !== "write" && event.tool !== "patch") return Effect.void
      if (!(event.error.error instanceof Permission.BlockedError)) return Effect.void
      event.error = new ToolFailure({
        message: `Cannot use ${event.tool} to modify files outside the Plan directory: ${directory}`,
      })
      return Effect.void
    })

    // Compaction and committed reverts can strip reminders while the session's agent stays
    // put. Reconcile per request, appending near the tail so the cached prefix stays warm.
    yield* ctx.session.hook("context", (event) => {
      const reminder = lastReminder(event.messages, enterReminder)
      const missing = event.agent === plan && reminder !== enterReminder
      const stale = event.agent !== plan && reminder === enterReminder
      const text = missing ? enterReminder : stale ? leave : undefined
      if (!text) return Effect.void
      // Before the user's prompt, matching where agent-switch reminders land.
      const at = event.messages.at(-1)?.role === "user" ? event.messages.length - 1 : event.messages.length
      event.messages.splice(at, 0, Message.user(text))
      return ctx.session
        .synthetic({ sessionID: event.sessionID, text, resume: false })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to persist Plan mode reminder", { sessionID: event.sessionID, cause }),
          ),
        )
    })

    yield* ctx.event.subscribe().pipe(
      Stream.filter(
        (event): event is SessionEvent.Created | SessionEvent.AgentSelected =>
          event.type === "session.created" || event.type === "session.agent.selected",
      ),
      Stream.runForEach((event) => {
        const text = switchReminder(event, enterReminder)
        if (!text) return Effect.void
        return ctx.session
          .synthetic({
            sessionID: event.data.sessionID,
            text,
            resume: false,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to inject Plan mode reminder", { sessionID: event.data.sessionID, cause }),
            ),
          )
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

/**
 * Read-only T3 Code host actions. Exact names only: `t3-code_` actions are reserved for the verified host
 * attachment, and a wildcard would also grant every mutating host tool added later.
 */
export const READ_ONLY_HOST_ACTIONS = [
  "t3-code_pull_request_read",
  "t3-code_pull_request_list",
  "t3-code_ci_logs",
  "t3-code_list_issues",
  "t3-code_read_issue",
  "t3-code_list_thread_pull_requests",
  "t3-code_list_thread_issues",
  "t3-code_read_pull_request_guide",
  "t3-code_t3_thread_list",
  "t3-code_t3_thread_read",
  "t3-code_t3_thread_search",
  "t3-code_device_list",
  "t3-code_device_screenshot",
  "t3-code_preview_status",
  "t3-code_preview_wait_for",
  "t3-code_t3_preview_list",
  "t3-code_html_preview",
  "t3-code_html_render",
  "t3-code_t3_worktree_status",
  "t3-code_t3_worktree_list",
  "t3-code_t3_environment_read",
  "t3-code_t3_environment_links",
  "t3-code_t3_project_list",
  "t3-code_t3_project_read",
  "t3-code_t3_theme_read",
  "t3-code_t3_background_wait",
  "t3-code_t3_thread_wait",
  "t3-code_t3_submit_output",
  "t3-code_send_to_user",
  "t3-code_orchestrator_capabilities",
  "t3-code_list_scheduled_tasks",
] as const

/** An explicit allowlist over deny-all; shell asks because commands can mutate state. */
function permissions(directory: string): Permission.Ruleset {
  return [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "webfetch", resource: "*", effect: "allow" },
    { action: "websearch", resource: "*", effect: "allow" },
    { action: "question", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "ask" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "edit", resource: path.join(directory, "*"), effect: "allow" },
    ...READ_ONLY_HOST_ACTIONS.flatMap((action) => [
      { action, resource: "*", effect: "allow" as const },
      // Per-thread loopback host registrations preserve `t3-code-<hash>_<tool>` for thread isolation.
      { action: action.replace("t3-code_", "t3-code-*_"), resource: "*", effect: "allow" as const },
    ]),
  ]
}

function switchReminder(
  event: SessionEvent.Created | SessionEvent.AgentSelected,
  enterReminder: string,
): string | undefined {
  if (event.type === "session.created") {
    if (event.data.agent !== plan) return undefined
    return enterReminder
  }
  if (event.data.agent === event.data.previous) return undefined
  if (event.data.agent === plan) return enterReminder
  if (event.data.previous === plan) return leave
  return undefined
}

function lastReminder(messages: ReadonlyArray<Message>, enterReminder: string) {
  return messages.reduce<string | undefined>((found, message) => {
    const part = message.role === "user" && message.content.length === 1 ? message.content[0] : undefined
    if (part?.type !== "text") return found
    return part.text === enterReminder || part.text === leave ? part.text : found
  }, undefined)
}
