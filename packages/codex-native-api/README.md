# codex-native-api

`codex-native-api` exposes the logged-in Codex runtime on the current machine as
an HTTP API. It is local-first by default, and it can also install itself as a
long-running background service on macOS, Linux, and Windows.

## Status

This package is retained as the only package-level backend candidate still kept
in the repository, but it is not under active development right now.

Treat the current README and package surface as a preserved reference point for
possible future work, not as an actively advancing roadmap.

This package is for one machine running its own Codex session. It is not a
hosted multi-tenant gateway.

## What you need

Before this package can work on a machine, that machine needs:

- Node.js `>= 24`
- a working local `codex` CLI on `PATH`, or `CODEX_REAL_BIN` set explicitly
- a valid local Codex login at `CODEX_HOME/auth.json` or `~/.codex/auth.json`

If those are missing, the API server can start, but real requests will not be
usable.

## What it does

- starts a local HTTP API over the logged-in Codex runtime
- defaults to `127.0.0.1`
- can be explicitly exposed on `0.0.0.0`
- auto-detects local Codex auth and local `codex` CLI
- supports `/v1/responses` builtin `web_search` requests
- preserves recovered Codex tool transcript items in `response.output` when available
- can install a background daemon using the host service manager
  - macOS: `launchd`
  - Linux: `systemd --user`
  - Windows: Scheduled Task

## What it does not do

- it does not bundle WeChat or Telegram transport
- it does not provide slash-command UX
- it does not turn one login into a shared hosted cloud service automatically
- it does not expose OpenAI-style function tools yet
- `/v1/chat/completions` still does not support tool declarations

## Install

```bash
npm install codex-native-api
```

You can also run it without a project install after publish:

```bash
npx codex-native-api --port 4242
```

## Quick start

Start a local API on `127.0.0.1:4242`:

```bash
npx codex-native-api --port 4242
```

Equivalent explicit form:

```bash
npx codex-native-api serve --port 4242
```

The process prints the bound URL, resolved auth path, and access scope on
startup.

## Verify it works

Health check:

```bash
curl http://127.0.0.1:4242/v1/health
```

Model list:

```bash
curl http://127.0.0.1:4242/v1/models
```

Minimal Responses API request:

```bash
curl http://127.0.0.1:4242/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.5",
    "input": "Say hello from codex-native-api."
  }'
```

Builtin `web_search` request:

```bash
curl http://127.0.0.1:4242/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.5",
    "input": "What changed in the latest Codex release?",
    "tools": [
      { "type": "web_search" }
    ],
    "tool_choice": "web_search"
  }'
```

Minimal Chat Completions request:

```bash
curl http://127.0.0.1:4242/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.5",
    "messages": [
      { "role": "user", "content": "Say hello from codex-native-api." }
    ]
  }'
```

## Tool behavior

Current tool surface is intentionally narrow:

- `/v1/responses` supports the built-in `web_search` tool
- legacy aliases such as `web_search_preview` are normalized automatically
- `tool_choice` supports `auto`, `none`, `required`, explicit `web_search`, and
  `allowed_tools` containing only `web_search`
- terminal `response.output` can include recovered `function_call`,
  `function_call_output`, and final assistant message items from the Codex turn
- function tools and custom external tools are rejected for now

When a request declares only `web_search`, the runtime is instructed to use
that builtin capability and not fall back to shell commands, file edits, MCP
tools, plugins, or image generation as substitutes.

This means the request-side builtin tool surface is narrow, but the response
side transcript is richer than plain text-only output.

## Public bind

Default mode is loopback only. Public exposure must be explicit:

```bash
npx codex-native-api --port 4242 --public --auth-token your-token
```

You can also use `--host 0.0.0.0`, but `--public` is the intended shortcut.

If you expose the API publicly, understand the security model:

- requests are executed through the logged-in Codex account on that machine
- anyone who can reach the port can use that account unless you set
  `--auth-token`
- this is a machine-level trust boundary, not an account-isolated SaaS boundary

When `--auth-token` is set, send it as:

```bash
Authorization: Bearer your-token
```

## CLI reference

### Foreground server

```bash
npx codex-native-api [serve] [options]
```

Serve options:

- `--port <number>`: bind port
- `--host <host>`: explicit bind host
- `--public`: shorthand for public bind when `--host` is not set
- `--auth-path <path>`: explicit auth file path
- `--auth-token <token>`: bearer token required for `/v1/*`
- `--cwd <path>`: default working directory for turns
- `--provider-profile <id>`: explicit provider profile id
- `--default-model <model>`: default model id

### Background daemon

```bash
npx codex-native-api daemon <subcommand> [options]
```

Daemon subcommands:

- `install`: install and start the service for the current user
- `start`: start the installed service
- `stop`: stop the installed service
- `restart`: restart the installed service
- `status`: show service-manager status
- `logs`: print service logs
- `uninstall`: remove the installed service

Useful daemon flags:

- `--port <number>`
- `--host <host>`
- `--public`
- `--auth-token <token>`
- `--auth-path <path>`
- `--cwd <path>`
- `--provider-profile <id>`
- `--default-model <model>`
- `--restart-sec <seconds>`: supervisor restart delay
- `--codex-home <path>`: override `CODEX_HOME`
- `--codex-bin <path>`: override `CODEX_REAL_BIN`
- `--launch-cmd <command>`: launcher used when provider autolaunch is enabled
- `--autolaunch`
- `--no-autolaunch`
- `--dry-run`: only for `daemon install`, prints the generated service files
- `--follow`: for `daemon logs`
- `--lines <n>`: for `daemon logs`

## Recommended daemon flows

Local-only long-running service:

```bash
npx codex-native-api daemon install --port 4242
```

Public long-running service:

```bash
npx codex-native-api daemon install --port 4242 --public --auth-token your-token
```

Inspect generated files before changing the machine:

```bash
npx codex-native-api daemon install --port 4242 --dry-run
```

Read logs:

```bash
npx codex-native-api daemon logs --follow
```

## Platform behavior

### macOS

- uses `launchd`
- installs a plist at
  `~/Library/LaunchAgents/com.codexbridge.codex-native-api.plist`
- starts on user login and restarts after crashes

### Linux

- uses `systemd --user`
- installs a unit at `~/.config/systemd/user/codex-native-api.service`
- uses `Restart=always`
- attempts `loginctl enable-linger "$USER"` so the service can remain available
  after logout when the host allows it

### Windows

- uses a per-user Scheduled Task
- writes configuration under `%APPDATA%\codex-native-api\`
- writes logs under `%USERPROFILE%\.codex-native-api\logs\`
- starts after user logon, not as a machine-wide system service by default

## Generated files

After `daemon install`, the stable edit points are:

- macOS/Linux env file: `~/.config/codex-native-api/service.env`
- Windows env file: `%APPDATA%\codex-native-api\service.env`
- macOS/Linux logs: `~/.codex-native-api/logs/`
- Windows logs: `%USERPROFILE%\.codex-native-api\logs\`

The env file is where you adjust bind address, port, auth token, default cwd,
and Codex path settings after installation. Restart the daemon after editing it.

## Programmatic usage

```ts
import { CodexNativeApiService } from 'codex-native-api';

const service = new CodexNativeApiService({
  port: 4242,
});

await service.start();
console.log(service.baseUrl);
```

Default programmatic behavior:

- one built-in `openai-native` provider profile is created automatically
- local Codex auth is resolved automatically
- local `codex` CLI is resolved automatically

## Troubleshooting

If `/v1/health` is `503` or requests fail:

1. Verify the machine has a valid Codex login:
   `ls ~/.codex/auth.json`
2. Verify `codex` is available:
   `which codex`
3. Check daemon logs:
   `npx codex-native-api daemon logs --follow`
4. If running publicly, verify the bearer token you are sending matches the one
   in the service env file.

If Linux daemon install succeeds but the service disappears after logout, check:

```bash
loginctl show-user "$USER" -p Linger
```

If Windows daemon exists but does not start before login, that is expected for
the default per-user Scheduled Task model.

## Current package shape

- public core preview
- single package, no runtime/server split yet
- zero runtime dependencies outside Node builtins

## Public surface

- `CodexNativeRuntime`
- `CodexNativeApiServer`
- `CodexNativeApiService`
- `InMemoryCodexNativeApiContinuationRegistry`
- auth helpers and provider-facing native API contract types
