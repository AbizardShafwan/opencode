# Memyr

Use this guide as the starting point for work involving Memyr itself. It
covers the core concepts needed to configure and customize Memyr, extend it
with plugins, and build integrations with the Memyr SDK, clients, and API.

Memyr is a fork of OpenCode V2. The executable, configuration, data, state,
cache, service, and lifecycle are Memyr-specific. Source packages, the HTTP
API, the plugin API, SDK imports, and provider integrations retain their
upstream identifiers, including `@opencode/*` and the `opencode` provider ID.

The documentation linked below describes upstream OpenCode V2. Use it for
shared behavior, but translate its command and path examples with this map:

| Upstream OpenCode                                                        | Memyr                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `opencode` command                                                       | `memyr`                                                            |
| `~/.config/opencode/opencode.json(c)`                                     | `~/.config/memyr/memyr.json(c)` (or `$XDG_CONFIG_HOME/memyr`)       |
| `opencode.json(c)` or `.opencode/opencode.json(c)`                        | `memyr.json(c)` or `.memyr/memyr.json(c)`                           |
| `~/.config/opencode/cli.json`                                            | `~/.config/memyr/cli.json`                                          |
| `~/.local/share/opencode`                                                | `~/.local/share/memyr`                                              |
| `~/.local/state/opencode`                                                | `~/.local/state/memyr`                                              |
| `~/.cache/opencode`                                                      | `~/.cache/memyr`                                                    |
| `~/.opencode/plan`                                                       | `~/.memyr/plan`                                                     |
| `service.json` / `service-<channel>.json` in state                       | `service-memyr.json` (default port `19394`)                         |
| `OPENCODE_PASSWORD` / `OPENCODE_SERVER_PASSWORD`                         | `MEMYR_PASSWORD` / `MEMYR_SERVER_PASSWORD`                          |
| `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_DB` | matching `MEMYR_*` variables                                        |
| `OPENCODE_CLI_CONFIG_CONTENT`                                            | `MEMYR_CLI_CONFIG_CONTENT`                                          |

Do not rename `@opencode/*` imports, the `opencode` provider ID, provider and
service names such as OpenCode Zen, OpenCode Go, OpenCode Console, or OpenCode
Free, `opencode.ai` URLs, `OPENCODE_*` feature or debug variables, or legal
attribution. Those are not Memyr product branding. `OPENCODE_LOG_LEVEL` is one
example of a debug variable that intentionally keeps its upstream name.

Full documentation is available at <https://opencode.ai/v2/docs/>. This overview is
only an index of core concepts. Before answering a question about a topic below,
fetch the URL named in that section and use the full page as the source of
truth. Follow links from that page when the question needs more detail. Fetch
<https://opencode.ai/v2/docs/> first when you need to discover the relevant
documentation page.

A machine-readable documentation index is available at
<https://opencode.ai/v2/llms.txt>.

## Version policy

Always answer for Memyr's V2 behavior. Memyr is based on OpenCode V2, so the
upstream V2 documentation is the reference for shared behavior. Answer for
upstream OpenCode V1 only when the user explicitly asks about V1, legacy
OpenCode, or migrating from V1.

Use only <https://opencode.ai/v2/docs/> documentation as the source of truth for
V2 behavior. Do not use <https://opencode.ai/docs/>, which documents V1, and do
not use general web search to resolve a V2 documentation question when the V2
docs or linked pages cover it. The schema served from
<https://opencode.ai/config.json> accepts both V2 fields and deprecated V1
fields. Never recommend a field it marks deprecated. If V2 documentation is
missing or contradictory, state the uncertainty or ask for clarification instead of falling back to V1. If the documentation disagrees with Memyr's
actual naming or lifecycle, follow the repository's `MEMYR.md` and the map above.

V1 documentation and syntax may be consulted only when the user explicitly
asks about V1 or when needed as migration input. Outputs and recommendations
must still use V2 unless the user specifically requests a V1 result.

## [CLI](https://opencode.ai/v2/docs/cli)

For questions about the terminal interface, command-line invocation, `run`,
`mini`, terminal providers, or other CLI behavior, fetch the
[CLI guide](https://opencode.ai/v2/docs/cli) and the relevant page linked from
that section.

CLI and TUI preferences are separate from Memyr's server and project
configuration. They live in the global `~/.config/memyr/cli.json`, or
`$XDG_CONFIG_HOME/memyr/cli.json` when `XDG_CONFIG_HOME` is set. There is no
project-local CLI configuration. Set `MEMYR_CLI_CONFIG_CONTENT` to merge
inline JSON over the global settings. Most preferences can also be changed from
the TUI by pressing `Ctrl+P` and selecting **Open settings**.

### [Settings](https://opencode.ai/v2/docs/cli/config)

Fetch the full [CLI settings reference](https://opencode.ai/v2/docs/cli/config)
before editing `cli.json`. It documents every terminal-only setting, accepted
values, and examples, including themes, input, sessions, tabs, diffs, alerts,
Mini, keybindings, terminal plugins, and debugging. Do not put these settings
in `memyr.json(c)`.

### [Keybinds](https://opencode.ai/v2/docs/cli/keybinds)

Configure keybindings under `keybinds` in `cli.json`. The leader key is the
`keybinds.leader` entry; leader timing is configured separately under
`leader.timeout`. Bindings can use a string, an array of strings, or an object
when event behavior such as `preventDefault` is required. Disable a binding
with `"none"` or `false`.

Never guess a command ID, default binding, or accepted key syntax. Fetch the
full [keybind reference](https://opencode.ai/v2/docs/cli/keybinds), which lists
the current IDs and defaults, before answering or editing a binding.

## Lifecycle and installation

Memyr's native lifecycle is managed by the repository scripts, not by the
upstream `memyr upgrade` and `memyr uninstall` commands, which refuse to run in
a Memyr build:

```sh
./scripts/memyr/install
./scripts/memyr/update
./scripts/memyr/uninstall
```

Run them from the repository root. `install` and `update` build the current
checkout, including local changes; they do not pull, reset, or commit. The
command is installed as `~/.local/bin/memyr` unless `MEMYR_BIN_DIR` overrides
it. After `update`, restart the service to use the new build:

```sh
memyr service status
memyr service restart   # interrupts active work
```

The background service listens on `http://127.0.0.1:19394` by default and
registers itself in the Memyr state directory as `service-memyr.json`. Launching
a client can replace a version-mismatched Memyr service, but never the separate
upstream OpenCode service. `bun run dev:live` connects to the installed OpenCode
server, not to Memyr.

## [Memyr configuration](https://opencode.ai/v2/docs/config)

Memyr's server and project configuration uses JSON or JSONC. Include the
published schema so the user's editor can validate fields and provide
autocomplete:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
}
```

Global configuration lives at `~/.config/memyr/memyr.json(c)` and applies
to every project for that user. Project configuration can live in any directory
as `memyr.json(c)` or `.memyr/memyr.json(c)`, including nested packages
in a monorepo.

During ordinary project discovery, Memyr searches the current Location
directory and every ancestor through the filesystem root, including directories
above the detected project or repository root. It merges direct
`memyr.json(c)` files from the farthest ancestor to the current directory,
then does the same for `.memyr/memyr.json(c)` files. This means every
discovered `.memyr` config overrides every discovered direct config. Global
filesystem configuration has lower precedence than these discovered documents.

Common configuration fields include `model`, `default_agent`, `permissions`,
`agents`, `commands`, `plugins`, `providers`, `mcp`, `skills`, `instructions`,
`references`, `formatter`, and `lsp`.

This configuration is distinct from `cli.json`. Use the
[CLI settings reference](https://opencode.ai/v2/docs/cli/config) for terminal
preferences, especially themes and keybindings.

Config changes apply without a restart. Memyr watches config files and
reloads agents, commands, skills, MCP servers, and plugins after a save. The TUI
does the same for `cli.json`. To force a full reload, use `/reload`. Don't tell
the user to restart Memyr after editing config.

Do not guess field names or shapes. Fetch the V2 configuration guide and its
linked topic guide as the source of truth, and preserve unrelated settings when
editing an existing file. Keep the published `$schema` URL in configuration
examples, but do not fetch it to determine the V2 configuration shape.

See the [full configuration guide](https://opencode.ai/v2/docs/config) for
every field, examples, config locations, and links to dedicated feature guides.

## [MCP servers](https://opencode.ai/v2/docs/mcp-servers)

Configure MCP servers under `mcp.servers`. Prefer the CLI because it preserves
unrelated configuration. Use `--global` when the user asks to set up a service
for themselves without limiting it to the current project; omit it when they
explicitly want project-local configuration.

```sh
memyr mcp add <name> --global --url <remote-url>
memyr mcp list
```

Remote servers use OAuth by default. If `mcp list` reports that a server needs
authentication, tell the user to run `/mcps`, select the server, and sign in.
Do not run `memyr mcp auth` through the shell tool: it starts an interactive
flow whose authorization link can be hidden in background process output.
Use the user-facing MCP interface instead.

Report the server as configured but awaiting sign-in until its connection
status confirms it is connected.

OAuth credentials are stored outside the Memyr configuration. Do not ask for or
store an API key when the server supports OAuth. Use header-based credentials
only when OAuth is unavailable or the user explicitly requires them, and use an
environment substitution such as `{env:MCP_API_KEY}` instead of writing a
secret into configuration.

## [V1 to V2 migration](https://opencode.ai/v2/docs/migrate-v1)

For any request to migrate configuration, agents, commands, skills, plugins,
integrations, or other behavior from upstream OpenCode V1 to Memyr's V2
behavior, read the full
[migration guide](https://opencode.ai/v2/docs/migrate-v1) before acting. In
the repository, its source is `services/www/src/docs/content/migrate-v1.mdx`.

Memyr does not automatically read upstream V1 paths. Files named
`opencode.json(c)` and directories named `.opencode/` are not discovered just
because they exist. To reuse a V1 OpenCode setup, copy the relevant
configuration to `memyr.json(c)` or `.memyr/`, rename references, and then
apply the guide's V2 migrations. Native Memyr V2 configuration uses the same
shapes as OpenCode V2; conversion is optional. When the user requests
conversion, inspect the complete configuration, preserve behavior and unrelated
settings, and apply only the relevant migrations from the guide. For plugin
migrations, fetch and follow both the migration guide and the full
[plugins guide](https://opencode.ai/v2/docs/build/plugins); the plugin package
and API identifiers remain `@opencode/*`. If non-API V1 functionality fails in
Memyr V2 after a correct migration, use the `report` skill to file it as a
compatibility bug.

## [Plugins](https://opencode.ai/v2/docs/build/plugins)

For questions about creating, configuring, loading, publishing, or migrating
plugins, fetch the full [plugins guide](https://opencode.ai/v2/docs/build/plugins)
before answering. Refer to this guide when the user wants to build a plugin. It
covers hooks, transforms, tools, plugin context capabilities, and package
entrypoints. Plugins can also extend the TUI; for those, fetch the
[CLI plugin guide](https://opencode.ai/v2/docs/build/plugins/cli).
For custom methods and events shared with other plugins or clients, fetch the
[RPC guide](https://opencode.ai/v2/docs/build/plugins/rpc).

## [Service](https://opencode.ai/v2/docs/troubleshooting#check-the-background-service)

Memyr uses a client-server architecture. Interfaces such as the TUI connect
to a background Memyr service, which owns sessions, configuration, plugins,
permissions, and tool execution.

Memyr normally discovers or starts the shared background service
automatically. Restart it only if it is stuck or unhealthy, not to apply
configuration changes:

```sh
memyr service restart
```

Check its status after restarting:

```sh
memyr service status
```

## [API](https://opencode.ai/v2/docs/api)

Memyr exposes an HTTP API from its server. The API is described by an
OpenAPI document available from the running server at `/openapi.json`.

Use Memyr's built-in `api` command for local requests. It uses the same
discovery and authentication flow as the TUI and may start the background
service when no compatible healthy service is available. It accepts either an
HTTP method and path or an OpenAPI operation ID.

Call an endpoint with an HTTP method and path:

```sh
memyr api get /api/info
```

Pass a request body with `--data` or `-d`, and additional headers with
`--header` or `-H`:

```sh
memyr api post /api/example --data '{"key":"value"}'
memyr api get /api/example --header 'X-Example:value'
```

Request bodies default to `Content-Type: application/json`. When Memyr is
connected to an explicit server instead of its managed background service, use
the same configured server and authentication context rather than constructing
an unauthenticated request separately.

See the [full API reference](https://opencode.ai/v2/docs/api) for available
endpoints, parameters, request bodies, and response schemas. The
raw [OpenAPI specification](https://opencode.ai/v2/openapi.json) is also
available for code generation and other tooling.

## [Client](https://opencode.ai/v2/docs/build/client)

For questions about connecting an application to Memyr over the network,
fetch the full [client guide](https://opencode.ai/v2/docs/build/client) before
answering.

`@opencode/client` is the generated TypeScript client for the Memyr HTTP
API. Its methods and types come from the same contract as the API reference.
The default entrypoint exposes Promise-based resource clients and async
iterables for streaming endpoints. The `@opencode/client/effect` entrypoint
exposes typed Effects, Streams, and decoded Memyr schema values. Its
`Service` API can discover, start, stop, and authenticate with the local
background service from a Node application.

## [SDK](https://opencode.ai/v2/docs/build/sdk)

For questions about embedding Memyr directly in an application, fetch the
full [SDK guide](https://opencode.ai/v2/docs/build/sdk) before answering. The SDK
hosts Memyr in the application without opening an HTTP listener.

Use the [Effect SDK guide](https://opencode.ai/v2/docs/build/sdk/effect) for
Effect applications. For Cloudflare Durable Objects, use the
[Cloudflare SDK guide](https://opencode.ai/v2/docs/build/sdk/cloudflare).

## [Troubleshooting](https://opencode.ai/v2/docs/troubleshooting)

Memyr runs a client and a background server. Start by determining whether a
problem belongs to the client, the shared server, or one project.

- Check the service with `memyr service status` and verify the API with
  `memyr api get /api/info`.
- Compare with `memyr --standalone`, which runs the TUI with a private
  server, to isolate shared-service issues.
- Inspect `~/.local/share/memyr/log/opencode.log`. Filter `role=cli` for
  client startup and `role=server` for sessions, providers, plugins,
  permissions, and tools.
- Run one reproduction with `OPENCODE_LOG_LEVEL=DEBUG` when normal logs are not
  sufficient.
- Do not delete or edit the database, service registration, or service config
  while diagnosing a problem. Back up persistent data before inspecting it
  with external tools.
- Redact API keys, authorization headers, prompts, file contents, and other
  sensitive data before sharing diagnostics.

See the [full troubleshooting guide](https://opencode.ai/v2/docs/troubleshooting)
for service lifecycle commands, API inspection, log locations, explicit server
connections, issue-reporting details, and local development paths.
