# Bundled policy and stable request prefixes

## Prompt sources

These are build-time assets, not runtime reads from another checkout. The source
was the local `~/Documents/codex` checkout (HEAD
`e596f5054d4e044a5b5338e942ddc47833b4d4d7`, with local modifications) on 2026-10-24.

- `system.txt`: exact `codex-rs/models-manager/prompt.md`, the active compiled
  Memyr engineering policy. SHA-256: `eb708da445b093cfd961cb6d9a428791c7ec593eb31e0f0143ea268f2a2a2afd`.
- `compaction.txt`: exact `codex-rs/prompts/templates/compact/prompt.md`.
  SHA-256: `b084c795a4d08c34d0d037292a6a5fc99846b68540990cc8e53a810b37546b61`.
- `summary-prefix.txt`: exact `codex-rs/prompts/templates/compact/summary_prefix.md`,
  used inside the existing conversation-checkpoint wrapper.
- `plan.txt`: `codex-rs/collaboration-mode-templates/templates/plan.md`,
  adapted to OpenCode's agent-switch mode control and `question` tool. The
  unavailable `update_plan` discussion is omitted. Plan-file permission stays
  limited to the existing harness Plan directory and requires a user request.
- `plugin/command/initialize.txt`: `codex-rs/tui/assets/prompt_for_init_command.md`,
  adapted to the project root and command arguments. Existing AGENTS.md is not overwritten.
- `plugin/command/review.txt`: `codex-rs/prompts/templates/review/rubric.md`,
  with this harness's commit/branch/PR target selection and instruction-file discovery. The Codex JSON output
  contract is retained. The hidden review role reuses the rubric portion as its system assignment; `/review`
  launches a fresh reviewer and sends only the target section as the child prompt.
- `default.txt`: `codex-rs/collaboration-mode-templates/templates/default.md`,
  adapted to the same mode control and question tool, with a Plan-exit marker.

Provider-specific OpenCode policies no longer replace or append to this policy.
Stateless `Generate.text` calls also receive the bundled base policy.
Explicit custom agent policies still override the default literally.
Explore, title and short-summary agents share the policy with their own narrow
assignment contracts; Codex has no direct title/short-summary equivalent in this
checkout. Compaction uses the Codex handoff instructions while preserving the
existing checkpoint heading/parser contract. Tool descriptions, permissions,
repository instructions, environment facts and plugin customizations remain
owned by this harness, rather than copying unsupported Codex tool names.

See `packages/core/NOTICE` and `packages/core/LICENSE.codex`.

## Review command

`/review` resolves its target before drawing conclusions. With no argument it reviews uncommitted
changes (staged, unstaged and relevant untracked files). A commit selects that commit, a branch
compares against its merge base, and a pull-request URL or number selects that diff and context.
Only the `## Review target` section is sent as the child prompt; the rubric is the hidden
`review` role's system assignment.

Each invocation creates a fresh child Session with the caller as `parentID`. It uses
`sessions.create`, not `fork`, so no parent messages are copied. The child receives only the
resolved target prompt, while files and skills attached to the command are preserved. Its task name
is unique, its role is hidden, and its metadata includes `oneShotReview: true`.

The review role uses the existing agent configuration shape; no review-specific config key exists:

```json
{
  "agents": {
    "review": {
      "model": "provider/model#variant",
      "variant": "high"
    }
  }
}
```

`model` accepts the short `provider/model#variant` form or the explicit
`{ "providerID": "...", "model": "...", "variant": "..." }` form. The role model is used first and
its embedded variant wins over the standalone `variant`; the standalone variant applies when the
role model has no embedded variant. Without a role model, the caller's model and variant are
inherited unless the role `variant` overrides them. If neither the role nor the caller selects a
model, the catalog default is used, with the role `variant` applied when present.
Role system and permission fields remain available through the normal agent config, but `/review`
also installs a separate read-only authority ceiling that denies editing, delegation, web tools and
Code Mode regardless of role config. That ceiling filters the advertised tool and Code Mode
catalog; the snapshot executor dispatches only tools present in that filtered catalog, while
resource-specific decisions remain with each tool's permission checks. Setting `disabled: true`
removes the role and `/review` fails clearly.

A completed review is rendered from the reviewer's structured report. Malformed output is preserved
as raw text rather than treated as a clean review; missing final assistant text is reported as an
empty response; failure and cancellation are marked explicitly. Delivery admits one durable parent
synthetic inbox item and wakes the parent session, so the main agent receives the rendered report
as a user-visible turn and responds to it. The item reuses the persisted notification ID for
idempotent retries. A suspended parent in restart recovery receives the item without being revived;
it is delivered when the parent resumes. The existing linked-subagent notice still opens the raw
reviewer session; there is no separate inline review UI. Archiving after completion retains the
reviewer Session and its history; it is not deletion or an API-level closure.

The reviewer may use shell commands only under the review prompt's inspection instructions. That is
policy guidance, not an operating-system sandbox.

`/review` requires an idle parent and immediate (`steer`) delivery. Queued delivery and launching
while the parent is executing are rejected with a command error rather than silently replacing or
deferring the user's work.

Review work runs as a durable background subagent job. Restart recovery reconciles a terminal review
from its child outcome without sampling the reviewer again, and retries delivery, child archival and
marker acknowledgement idempotently. A process death between the started notice and job registration
can still leave an admitted child without a recovery marker; this pre-registration gap is the same
one that exists for ordinary subagents and is not made transactional here.

## Stable-prefix implementation

The reference is `~/Documents/deepseek-harness` at
`687f282e8625c6b8d11ff58211a90524be2e4317`, especially
`packages/core/agent-loop/src/runtime-context.ts`, its request-cache test, and
the compaction summarizer. The port uses this fork's existing durable instruction
events and content-addressed blobs instead of introducing an in-memory loop or
a second session journal.

1. A policy snapshot is admitted with other instructions at a safe step boundary.
   An unchanged observation writes nothing. The epoch baseline is read from
   durable state, not rebuilt from the currently selected agent.
2. Policy changes produce standalone chronological instruction deltas. Other
   simultaneous context changes remain separate, so a policy cannot be removed
   from a request by accidentally dropping project updates.
3. On protocols with native privileged system updates, requests keep the original
   policy prefix and replay updates in history. Protocols declare this capability;
   Core does not guess it from a provider name.
4. On leading-only protocols, requests use the current policy and omit historical
   policy snapshots. This intentionally invalidates the prefix when policy changes:
   cache reuse must not preserve obsolete higher-priority restrictions. Ordinary
   project/runtime deltas keep the existing protocol-specific lowering.
5. Compaction advances the instruction epoch; forks seed from current instruction
   values; revert uses the existing instruction-state rewind path. Preview/generate
   can observe changes without committing them. Legacy sessions without a policy
   baseline use their configured policy until a new epoch establishes one.
6. Tool declarations are sorted by their final advertised names after plugin hooks.
   Input-schema object keys are canonicalized recursively without reordering arrays.
   Tool additions, removals and schema changes are not hidden or frozen: permission
   and execution correctness take priority over reuse. This port does not emulate
   Harness-only native tool-addition protocols on endpoints that lack them.
7. Existing cache breakpoints, session affinity, append-only tool/result replay,
   image-retention hysteresis and prefix-preserving compaction remain in use.
   No cache TTL overrides, arbitrary padding, warm-up traffic or paid calls are added.

A changed model/provider, tool declaration, compaction/revert, explicit prompt hook
or provider cache eviction may still cause misses. This does not guarantee a cache
hit ratio. Wire-prefix regression tests establish deterministic request construction;
only real provider usage can establish cache hits. Use reported cache-read tokens
versus total input tokens for that measurement. No paid live run is implied by tests.

## Verification

Focused Core tests cover default/custom prompts, role contracts, policy updates,
reload, fork/epoch handling, and post-hook tool ordering. Existing runner tests cover
instruction updates, compaction, reverts and the one-request-per-step invariant.
AI tests cover native-system capability declarations and wire roles.

Run from `packages/core`:

```sh
CI=true RECORD=false bun run script/test.ts test/session-system-prompt.test.ts test/instruction-state.test.ts test/session-model-request-hooks.test.ts test/session-runner.test.ts test/session-compaction.test.ts test/agent.test.ts test/plugin/plan.test.ts
bun typecheck
```

Run `CI=true RECORD=false bun test --timeout 30000 --only-failures` and
`bun typecheck` from `packages/ai`, then
`bun run check` from the repository root. Use the repository-pinned Bun.
The existing recorded transport test supplies its captured historical policy as
an explicit test agent override, so strict cassette matching remains intact;
it is not an evaluation of the new default policy.

Previous prompt/cache implementation verification (before the reply-attribution and visual-verification additions), 2026-10-24, using locally installed Bun 1.4.4 and the frozen
lockfile without replacing global Bun:

- The full AI suite passed: 1,836 passed, 28 skipped, zero failures.
- The full Core suite passed: 6,432 passed, 371 skipped, zero failures.
- Seven focused Core files passed three consecutive runs: 897 tests, zero failures.
- Root `bun run check` passed all 34 type-check tasks; lint reports warnings but
  no errors. An earlier run hit a Turbo SIGSEGV while stopping after a test type
  error; the corrected rerun completed successfully.
- Core and AI `bun run typecheck:tsc` passed.
- Exact imported prompt copies and `git diff --check` passed.
- No live-provider cache measurements or paid provider calls have been made.

## Proactive visual verification

The imported Codex policy remains byte-for-byte unchanged. `SessionSystemPrompt.make()`
appends the static `visual-verification.txt` policy; literal custom system overrides
remain literal. This is a one-time default-policy change on upgrade, represented by
the existing durable policy update mechanism, not a changing per-step insertion.
The real bundled policy is included in the deterministic wire-prefix regression test.

Local Codex analysis found an image-input tool (`codex-rs/core/src/tools/handlers/
view_image_spec.rs` and `view_image.rs`) and explicit render–inspect–iterate instructions
in the installed documents/PDF skills. Skill selection and tool affordances explain
the proactive behavior; there is no general automatic screenshot trigger in the base
policy. Memyr reuses its permission-checked `read` image/PDF support plus available
shell/browser renderers. Generated mockups are not evidence of an implementation.
Tools and image-capable models must actually be available, and the policy does not
provide authority to install software, expose private captures, or change live services.
No live model compliance or provider cache-hit rate has been measured.
