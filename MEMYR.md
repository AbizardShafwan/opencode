# Memyr fork

## Install, update, uninstall

These scripts install the full native CLI, TUI, local server, persistent-terminal
support, and embedded web UI. They do not build the desktop app; see
[Desktop](#desktop) for that.
The source installer targets glibc Linux and macOS; on Windows use WSL. Native Windows
installation is not implemented. Linux x64 is the locally verified platform.

Start with a checkout, Bash, sufficient disk space, and network access. The installer
bootstraps the repository-pinned **Bun 1.4.4**, Node >=24 (downloads Node 24 when
needed), Git, curl, unzip, tar/gzip, Python, Make, and a C++ compiler. Linux system
packages use apt, pacman, dnf, or zypper with sudo when needed; pacman performs the
full upgrade required by Arch. On macOS, it opens Apple's Command Line Tools
installer when needed (finish it and rerun), and uses an existing Homebrew for
missing tools. Unsupported systems report the missing requirements.

Downloaded Bun/Node archives come from their official release servers and are
checked against the published SHA-256 checksums before use. They live in
`$XDG_DATA_HOME/memyr-toolchain` (normally `~/.local/share/memyr-toolchain`),
overridable with `MEMYR_TOOLCHAIN_DIR`. Global runtimes and shell profiles are not
replaced. The scripts reuse compatible runtimes already on PATH. System packages
and this reusable toolchain remain after uninstall. Provider credentials and
optional project tools still need their usual setup; installation does not make
paid model requests.

From this checkout:

```sh
./scripts/memyr/install
# Select/review your desired source revision yourself; update never runs git pull/reset.
./scripts/memyr/update
./scripts/memyr/uninstall

# Inspect or install the build toolchain independently:
./scripts/memyr/prerequisites --plan  # no changes or downloads
./scripts/memyr/prerequisites --check # nonzero when requirements are missing
./scripts/memyr/prerequisites
```

Install/update builds the current checkout, including local modifications, using
`bun install --frozen-lockfile`. It embeds the web UI; it never uses the CLI's
web-UI-skipping build mode. The installed command is `~/.local/bin/memyr`.
Add `~/.local/bin` to your PATH if necessary; scripts do not edit shell profiles.
The desktop's "Install CLI" action writes that same command only when nothing
already exists there, so it never replaces the symlink this installer owns.
Use `memyr --help`, `memyr`, `memyr serve`, and `memyr service status` normally.
Upstream `upgrade` and `uninstall` commands refuse to operate in the Memyr build;
use the scripts above instead.

`MEMYR_INSTALL_PREFIX` overrides `~/.local/share/memyr-install` and `MEMYR_BIN_DIR`
overrides `~/.local/bin`. Use the same values for all lifecycle operations. The
prefix is installer-owned and must be empty on first install. Existing unrelated
commands/directories are refused. `install --artifact /path/to/memyr` and
`update --artifact /path/to/memyr` accept a trusted, locally built Memyr executable
without reinstalling build dependencies; the build identity is checked, not a
cryptographic signature. Never supply an untrusted executable.

A new release is staged before an atomic symlink switch. Build/identity-check
failures preserve the working installation. Prior release binaries are retained
until uninstall so running processes can finish. Install/update do not restart a
service: run `memyr service restart` when ready (this interrupts its active work).
Launching a new client can also replace a version-mismatched Memyr service under
the existing managed-service policy. OpenCode remains separate.
Uninstall stops only the registered Memyr service, removes the owned installation
and command link, and **preserves runtime data and credentials**. It aborts if the
service cannot be stopped. It does not delete projects or OpenCode files.

## Separation from OpenCode

Compiled Memyr builds use a build-time identity, not an executable-name guess:

| Resource               | Memyr default                                             |
| ---------------------- | --------------------------------------------------------- |
| Command                | `memyr`                                                   |
| Data                   | `$XDG_DATA_HOME/memyr` (normally `~/.local/share/memyr`)  |
| Config                 | `$XDG_CONFIG_HOME/memyr` (normally `~/.config/memyr`)     |
| State                  | `$XDG_STATE_HOME/memyr` (normally `~/.local/state/memyr`) |
| Cache                  | `$XDG_CACHE_HOME/memyr` (normally `~/.cache/memyr`)       |
| Temporary files        | OS temporary directory `/memyr` child                     |
| Project config/plugins | `memyr.json[c]`, `.memyr/`                                |
| Plans                  | `~/.memyr/plan`                                           |
| Service registration   | Memyr state directory, `service-memyr.json`               |

System configuration also uses `memyr` rather than `opencode`. Credentials,
sessions, locks, terminal caches, and TUI state live under these separate roots.
The Memyr channel chooses its own default service port, also used by `memyr serve`,
separating browser-origin storage from the upstream default. Explicitly overriding
ports, config paths, or connecting with `--server` is still possible and is your
responsibility. Project `AGENTS.md`, `.agents`, and `.claude` compatibility remains
intentional; repository-level Git locks remain shared to protect the same Git data.

Path/database/config overrides use `MEMYR_CONFIG_DIR`, `MEMYR_CONFIG`,
`MEMYR_CONFIG_CONTENT`, `MEMYR_DB`, and corresponding `MEMYR_CONFIG_*` controls.
Passwords use `MEMYR_PASSWORD` (legacy alias `MEMYR_SERVER_PASSWORD`), and the TUI
channel override is `MEMYR_TUI_CHANNEL`. Inherited `OPENCODE_*` equivalents cannot
redirect these resources. Other existing feature/debug environment variables keep
their upstream names. No upstream account/session/config migration is automatic.
Source development without `--memyr` still uses the repository's normal identity;
`dev:live` deliberately connects to the existing OpenCode server, not Memyr.

## Desktop

The desktop app is a first-class Memyr build that coexists with OpenCode Desktop.
It uses `ai.memyr.desktop` (and `.dev`/`.beta`), artifacts named
`memyr-desktop-*`, Linux packages `memyr`, `memyr-dev`, and `memyr-beta`, and the
`memyr://` protocol. It does not register `opencode://`, so the upstream app keeps
that handler; Console return links handed directly to the process still resolve.

Updates are disabled. Packaging declares no `publish` feed, `Build.updates` is
false, and the updater menu item is disabled. There is no upstream server to
check. Build the CLI first, then the app; the CLI distribution is mandatory for
every channel:

```sh
OPENCODE_CHANNEL=memyr bun run --cwd packages/cli build -- --memyr
OPENCODE_CHANNEL=prod OPENCODE_CLI_DIST="$PWD/packages/cli/dist" bun run --cwd packages/desktop build
OPENCODE_CHANNEL=prod bun run --cwd packages/desktop package
```

Local macOS builds are unsigned and unnotarized; signing opts in through
`CSC_LINK`/`CSC_NAME`. On Windows, the package carries a Linux Memyr CLI for WSL
when the supplied distribution includes it, and the WSL flow installs that binary
as `~/.memyr/bin/memyr` instead of downloading OpenCode. See
[the desktop guide](packages/desktop/README.md) for details.

## Configurable agents and threads

Roles are not limited to the bundled General and Explore agents. Place TOML files
under `~/.config/memyr/agents/` or a project's `.memyr/agents/`. Shared roles under
`~/.agents/agents/` and ancestor/project `.agents/agents/` are loaded first; native
configuration takes precedence. Files are scanned recursively and reloaded after
changes. Existing Markdown agent files and `agents` entries in `memyr.json` remain
supported. In local Codex, roles live under each config directory's `agents/`
folder (normally `.codex/agents`); `.agent` is not the convention.

```toml
# .memyr/agents/reviewer.toml
name = "reviewer"
description = "Review changes for correctness and regressions"
model = "openai/gpt-6.1-sol" # Choose an ID available from your configured provider.
model_reasoning_effort = "high"
developer_instructions = "Report actionable findings with evidence. Do not edit files."

[[permissions]]
action = "edit"
resource = "*"
effect = "deny"
```

Omit `model` to inherit it while retaining a role's thinking variant. Alternatively
use `model_provider = "openai"` and `model = "gpt-6.1-sol"`. Thinking names must be
variants offered by the selected model; unsupported choices fail before spawning.
Markdown/JSON roles use `variant` for the same independent setting. TOML roles
default to `subagent` and add their assignment to the bundled system policy.
Unknown fields, including sandbox or approval overrides, reject the TOML file
with a log warning. Provider/model IDs in this example are illustrative.

`spawn_agent` creates named background threads, such as `/root/reviewer`, with
optional model and thinking overrides. `fork_turns: "all"` inherits settled
history, the current role/model/thinking, and permission limits; model and role
overrides are rejected in this mode. `list_agents`, `send_message`,
`followup_task`, `wait_agent`, `interrupt_agent`, and `close_agent` provide thread
inspection and lifecycle controls. The original `subagent` tool remains supported.
Messages to idle agents stay in their durable inbox; follow-up tasks resume them.
Only descendants can be controlled; messaging stays within the conversation tree.
Closing preserves history and allows later follow-up. Names remain reserved after
closing, so follow up an existing name or choose a new one.

General agents can delegate. The configurable `experimental.subagent_depth`
defaults to 3; set 0 to disable spawning. Explore retains its restricted tool
policy. Child creation snapshots the parent's permission limits: child roles,
session overrides and saved grants cannot bypass an inherited denial. Requests
that require approval still reach the user's existing permission UI. These are
application tool permissions, not an OS sandbox; a shell permission grants the
shell command's capabilities.

The TUI Subagents tab shows all threads by default, including nested descendants.
Ctrl+A cycles the activity filter, Ctrl+Left/Right collapses/expands a branch, and
Enter opens the selected conversation. The selected thread shows its path, model,
and thinking variant. Ordinary Left/Right still switches composer tabs. The web
and terminal timelines recognize both new and legacy delegation calls as linked
child conversations. Updates rebuild these capabilities and preserve your role
configuration; no separate agent daemon or extra runtime is required.

## Reply attribution

Each text reply displays its own model and recorded thinking configuration, including
streaming replies and mobile/narrow terminals. The request snapshot travels through
the durable step-start event, message projection, and client event reducer. Historical
replies do not change when the selected model or variant changes. CLI JSON step-start
output includes the metadata; legacy v1 JSON keeps its existing shape.

Thinking means **configured reasoning**, not a measurement of hidden internal model
computation. Provider defaults are labeled as such; older/malformed unrecorded settings
are not guessed. Named effort, enabled/disabled/adaptive modes, and token budgets are
supported for the built-in reasoning option shapes. Custom transport hooks or provider
behavior can still alter actual execution after the snapshot. Tool-only terminal
completion footers also retain attribution.

## Visual verification and cache stability

The static bundled visual policy tells the agent to render and inspect the actual
result for visual work, using existing browser/shell workflows and the permission-
checked image/PDF `read` tool. It does not pretend that generated mockups, successful
commands, or image placeholders prove visual correctness. Missing renderers or image
input support must be reported rather than concealed.

This follows the local Codex pattern: tool affordances plus applicable skill
instructions, not an automatic screenshot daemon. See
[the prompt implementation notes](packages/core/src/session/runner/prompt/README.md).
The exact imported base policy is preserved; the static addition changes the default
policy once on upgrade. Existing durable policy updates and deterministic request
prefixes remain in use. This is not a guarantee of model compliance or cache-hit rate.

## Verification for this change

Verified on Linux x64 with Bun 1.4.4 on 2026-10-24 (worktree HEAD `09399e3eec`):

- Focused Core subagent suite: 15 passed; repeated 10 times, 150 passed.
- Core package `bun check` and `bun run typecheck:tsc`: passed.
- Root `bun run check`: 34/34 tasks succeeded; lint warnings only.
- CLI Memyr lifecycle, isolation, and prerequisite tests: 5 passed.
- Native build with embedded web UI: passed. The isolated install
  `0.0.0-memyr-202610241211` served authenticated API and web UI with HTTP 200.
- Isolated update to `0.0.0-memyr-202610241224`: passed. The already-running
  service kept the same PID and version, and its API/web endpoints stayed HTTP 200.
- Isolated uninstall: stopped the registered service, removed the install prefix
  and `memyr` bin link, preserved the runtime database, and left the upstream
  OpenCode file-tree hash unchanged.
- A second isolated install (`0.0.0-memyr-202610241226`) completed a live
  `ollama-cloud/gpt-oss:20b` request returning exactly `OK`; the credential stayed
  in the process environment and was not logged. That install was then removed.
- `git diff --check` passed.

This pass did not rerun the full Core/Client suites, TUI/browser checks, or the
earlier performance sample, and did not test macOS, WSL, optional third-party
tools, real-provider visual compliance, or cache-hit rates. The scripts build from
the checkout and do not guarantee compatibility with every external provider/plugin.
