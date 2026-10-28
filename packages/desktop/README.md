# Memyr Desktop

Memyr Desktop is the Electron app for this fork. It is a first-class Memyr build, not a rename of
OpenCode Desktop: it has its own app identity, data directory, protocol and Linux packages, and it
coexists with an installed OpenCode Desktop.

| Surface            | Value                                                   |
| ------------------ | ------------------------------------------------------- |
| App id (prod)      | `ai.memyr.desktop`                                      |
| App id (dev/beta)  | `ai.memyr.desktop.dev`, `ai.memyr.desktop.beta`         |
| Product name       | `Memyr`, `Memyr Dev`, `Memyr Beta`                      |
| Protocol           | `memyr://`                                              |
| Artifacts          | `memyr-desktop-<os>-<arch>.<ext>`                       |
| Linux packages     | `memyr`, `memyr-dev`, `memyr-beta`                      |
| Bundled CLI        | `memyr-cli` plus `memyr-cli.version` in `resources/`   |

Only `memyr://` is registered with the operating system, so an installed OpenCode Desktop keeps the
upstream `opencode://` handler. Console return links passed to this process directly still resolve.

## Updates

This fork has no update service. `publish` is not configured, the App menu's update item is disabled,
and `Build.updates` is `false`, so the updater never tries to reach an upstream feed. Update the app by
rebuilding and installing it.

## Development

```bash
bun install
bun dev
```

`bun dev` runs the renderer in local mode and the Memyr CLI from this checkout (`packages/cli`) with
`OPENCODE_APP_ID=memyr`, so the desktop and its service use the Memyr state directory and registration
file (`<state>/memyr/service-local.json`). There is no server-download option; both `--build-server`
and `--download-server` are rejected.

## Build

Build the Memyr CLI first, then the desktop. The CLI distribution is required for every packaging
channel because this fork cannot download an upstream CLI.

```bash
OPENCODE_CHANNEL=memyr bun run --cwd packages/cli build -- --memyr
OPENCODE_CHANNEL=prod OPENCODE_CLI_DIST="$PWD/packages/cli/dist" bun run --cwd packages/desktop build
OPENCODE_CHANNEL=prod bun run --cwd packages/desktop package
```

`bun run build` runs `prebuild`, which copies the target CLI to `resources/memyr-cli` and writes
`resources/memyr-cli.version`; `bun run package` then bundles those resources outside `app.asar`.
Packaging fails if the CLI or its version file is missing. Set `OPENCODE_CLI_TARGET` when packaging for
a different architecture.

The CLI executable is named `memyr`. On macOS, "Install CLI" copies it to `~/.local/bin/memyr`; it does
not run an upstream installer or edit shell profiles. It never replaces an existing `memyr` command,
such as the symlink owned by `scripts/memyr/install`; it reports that path instead.

### Windows and WSL

WSL needs a Linux CLI. When `OPENCODE_CLI_DIST` contains the matching `cli-linux-*` target, `prebuild`
copies it to `resources/memyr-cli-linux` and the Windows package carries it. The WSL settings then copy
that binary into the distro as `~/.memyr/bin/memyr`. If the distribution has no Linux target, packaging
still succeeds but the WSL dialog reports that no Linux Memyr CLI is available instead of installing
upstream OpenCode. Development builds compile `memyr-linux-*` from this checkout on demand.

### macOS signing

Local macOS builds are unsigned (`identity: null`) and never notarized. A signed build opts in by
setting `CSC_LINK` or `CSC_NAME`; notarization stays off because this fork has no notary credentials.

## Startup benchmark

`bun run bench:startup` measures a **packaged** build from process spawn to the restored tab being ready and the
renderer going idle, so dev-server and bundling costs are not part of the numbers.

From `packages/desktop`:

```bash
OPENCODE_CHANNEL=dev OPENCODE_CLI_DIST="$PWD/../cli/dist" bun run build && bun x electron-builder --win --dir --config electron-builder.config.ts
bun run bench:startup -- --runs 5                                  # warm service (started once, reused by every launch)
bun run bench:startup -- --runs 5 --compare dist/other/Memyr\ Dev.exe   # A/B: alternate launches of two builds
bun run bench:startup -- --service cold                            # each launch spawns the service
bun run bench:startup -- --fresh                                   # first launch after an install (profile wiped each time)
bun run bench:startup -- --profile-main --profile-renderer --trace # CPU profiles and a Chromium startup trace
bun run bench:startup -- --seed "%APPDATA%\ai.memyr.desktop.dev"   # restore tabs and drafts from an existing profile
```

The app runs in an isolated home (`%TEMP%\memyr-bench-startup`): its own `%APPDATA%`, XDG directories, Memyr
database, config and service registration, with the developer's `OPENCODE_*`, `MEMYR_*` and `OTEL_*`
environment stripped (an inherited OTLP endpoint alone adds a network round trip to every CLI exit). It
never attaches to or restarts the developer's live service, and only ever kills the process tree it
spawned. `--service cold` stops the service before each launch so the desktop has to spawn it; the isolated
config directory gives that service a private port. One `--warmup` launch per build is discarded by default
because the first launch of a new binary pays the antivirus scan. `--compare` alternates two builds so
machine drift affects both equally; they must bundle the same CLI or the desktop restarts the service on
the version mismatch.

Milestones (ms since spawn) come from the main log, the renderer's performance timeline and DOM readiness polled over
CDP. Node's bootstrap timing is read from the main process after each run over `--inspect` (nothing attaches until the
run is over): `processCreated` → `nodeStart` is Electron's native init, `nodeStart` → `nodeBootstrapped` is Node
itself, and `nodeBootstrapped` → `appStarting` is Electron's JavaScript init plus our main bundle up to its first
log line. Renderer idle is the start of the first 500 ms window with under 10 % main-thread task time that stays quiet
for `--settle-ms`; `rendererTaskMs` is the renderer's total main-thread task time until then. Raw samples are
written to `dist/bench-startup`.
