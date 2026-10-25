# Memyr handoff

Snapshot date: 2026-10-24

## Current state

- Repository: `/home/abizard/Documents/opencode`
- Branch: `dev`
- HEAD: `09399e3eec776400ea4f9f44e3b999c34a4e71ba` (`origin/dev`)
- Worktree is intentionally dirty: 151 entries before this handoff file was added. Preserve them; do not reset, rebase, or overwrite unrelated changes.
- Nothing has been committed. `MEMYR.md` and most of the delegated-thread work are uncommitted/untracked.
- Product identity is **Memyr**. Keep the `memyr` command, `MEMYR_*` variables, and Memyr data paths. There is no `opencode-phasea` identifier and no rename was requested.

## Installed build

The user completed a real-home install and confirmed it works.

- Command: `/home/abizard/.local/bin/memyr`
- Version: `memyr v0.0.0-memyr-202610241255`
- Service: running at `http://127.0.0.1:19394`
- Install root: `/home/abizard/.local/share/memyr-install`
- Active release: `/home/abizard/.local/share/memyr-install/releases/release-eDUt6e`
- Data/config/state are separate from OpenCode under `~/.local/share/memyr`, `~/.config/memyr`, and `~/.local/state/memyr`.

The service is the installed Memyr build, not the upstream OpenCode service. Do not modify or restart the upstream OpenCode installation unless explicitly asked.

## What is working

- Native install/update/uninstall lifecycle, including the embedded web UI.
- Memyr-specific command, service registration, runtime data, config, state, and cache paths.
- Persistent provider credentials across provider/model switches.
- Configurable TOML/Markdown agents under Memyr/agent config directories.
- Named background threads: `spawn_agent`, `list_agents`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `close_agent`.
- Nested subagent trees, inherited permission limits, and thread navigation in the TUI.
- Reply attribution with recorded model/thinking configuration.
- Codex-derived prompts and stable-prefix behavior documented in `MEMYR.md` and `packages/core/src/session/runner/prompt/README.md`.
- Visual-verification prompt policy and cache-stability work.

## Verification evidence

Recorded in `MEMYR.md`; not every check was rerun after the user's install.

- Focused Core subagent suite: 15 passed; repeated 10 times for 150 passes.
- Core `bun check` and `bun run typecheck:tsc`: passed.
- Root `bun run check`: 34/34 tasks passed; lint warnings only.
- CLI Memyr lifecycle, isolation, and prerequisite tests: 5 passed.
- Native build with embedded web UI: passed.
- Isolated install served authenticated API and web UI with HTTP 200.
- Isolated update preserved the running service PID/version and kept endpoints at HTTP 200.
- Isolated uninstall stopped the service, removed the install prefix and command link, preserved the runtime database, and left the upstream OpenCode tree unchanged.
- A live `ollama-cloud/gpt-oss:20b` request returned exactly `OK` in about 2.4 seconds. The credential was supplied through the environment and never logged.

Not covered by the last pass: full Core/Client suites, full TUI/browser checks, macOS, WSL, optional third-party tools, real-provider visual compliance, and cache-hit rates.

`bun run dev:live` connects to the existing OpenCode server, not Memyr. It is not a Memyr installation test.

## Accepted known issue

The user accepted this edge case for now. No fix has been implemented.

**Stale subagent completion notice on reopen.** An archived session can retain a pending synthetic completion notice. When `followup_task` reopens it with a new prompt, both items can be promoted as steers, with the old notice ahead of the new task. The reopened model may act on obsolete child output or the old completion instead of the new instruction.

Provenance is mixed:

- Upstream already has `SubagentCompletion.deliver`, synthetic inbox notices, and FIFO steer promotion.
- This fork added the archived-session wake guard in `packages/core/src/session/session.ts`.
- `followup_task` and `close_agent` are new in `packages/core/src/tool/plugin/agent-threads.ts`, which does not exist in `HEAD`.

So the notification machinery is upstream, but the stale-on-reopen scenario is exposed by this fork's delegated-thread work.

If this is fixed later, the likely policy is an atomic reopen operation that either:

1. cancels only pending `source: "subagent"` notices before admitting the new prompt, or
2. folds them into clearly labeled context with the new task as the final instruction.

The fix must serialize the reopen boundary; a naive list/cancel/prompt sequence races with asynchronous completion delivery. Add a regression with the shape `A -> B -> C`: archive `B`, finish `C`, reopen `B` with a new prompt, and assert that the new task drives the first resumed behavior.

Relevant files:

- `packages/core/src/session/subagent-completion.ts`
- `packages/core/src/session/subagent-job.ts`
- `packages/core/src/session/session.ts`
- `packages/core/src/session/inbox.ts`
- `packages/core/src/tool/plugin/agent-threads.ts`
- `packages/core/test/tool-subagent.test.ts`

## Lifecycle commands

Run from the repository root:

```sh
./scripts/memyr/install
./scripts/memyr/update
./scripts/memyr/uninstall
```

`install` and `update` build the current checkout, including local modifications. They do not run `git pull`, reset, or commit. The standalone `scripts/memyr/prerequisites` step is optional; install/update run the prerequisite setup automatically. Use `--plan` only to preview toolchain downloads.

After updating, the running service keeps its current version until restarted:

```sh
memyr service status
memyr service restart   # interrupts active work
```

Then run:

```sh
memyr --version
memyr
```

## Verification commands

```sh
# From the repository root
bun run check

# From the affected package for focused type checking
cd packages/core
bun typecheck
```

Tests must not run from the repository root. Run them from package directories, for example `packages/core`. Follow the matching repository skill before changing tests.

## Next useful steps

1. Exercise the installed Memyr TUI against the normal day-to-day flows: provider switching, persisted logins, subagent creation/navigation, close/reopen, and reply attribution.
2. Review the dirty worktree and split it into coherent commits when ready. Do not commit automatically.
3. If the stale-notice edge case becomes disruptive, implement the atomic reopen policy above and add the `A -> B -> C` regression.
4. Before a release or PR, rerun the full relevant test matrix and target `dev`; this repository does not use Changesets.

## Resume prompt

> Continue the Memyr work in `/home/abizard/Documents/opencode`. Read `MEMYR.md` and `MEMYR-HANDOFF.md` first. Preserve the dirty worktree and the installed `memyr` build. The stale subagent completion-on-reopen issue is accepted for now unless I ask you to fix it. Use the existing `memyr` / `MEMYR_*` naming; do not rename anything to `opencode-phasea`.
