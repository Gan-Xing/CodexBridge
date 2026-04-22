# CodexBridge

CodexBridge is a Codex-centered gateway for connecting multiple chat platforms to one shared Codex engine, while switching backend provider profiles inside Codex when needed.

## Current Direction

- First delivery target: `WeChat + Codex`
- Future platforms: `Telegram`, additional chat transports
- Future Codex provider profiles: `MiniMax via CLIProxyAPI`, additional Codex-compatible backends
- Core rule: platforms are adapters, Codex stays the execution engine, and Codex thread state stays the source of truth

## Documents

- [Core architecture](./docs/architecture/codexbridge-core-architecture.md)
- [Roadmap TODO](./docs/todo/roadmap.md)
- [WeChat slash command reference](./docs/usage/weixin-slash-commands.md)

## Repository Layout

```text
src/
  core/
  platforms/
  providers/
  runtime/
  store/
test/
docs/
```

## Status

Project bootstrap is now focused on:

1. Landing the core session and binding model
2. Keeping platform and provider plugins independent
3. Making `WeChat + Codex` the first real implementation path

Current implemented bridge pieces:

- Core session routing with WeChat-friendly slash commands, including `/helps`, `/status`, `/usage`, `/login`, `/stop`, `/new`, `/uploads`, `/provider`, `/models`, `/model`, `/personality`, `/instructions`, `/fast`, `/threads`, `/search`, `/next`, `/prev`, `/open`, `/peek`, `/rename`, `/permissions`, `/allow`, `/deny`, `/reconnect`, `/retry`, `/restart`, and `/lang`
- File-backed JSON repositories for persistent bridge state
- WeChat platform skeleton for Hermes-compatible iLink config loading, QR account state reuse, inbound DM normalization, long-poll client/poller wiring, context-token persistence, text chunking, and outbound text/typing delivery
- Codex profile loader and initial Codex app-server client/plugin path for shared thread execution
- WeChat runtime wiring that feeds poll events into the shared bridge coordinator and sends responses back through the WeChat transport

## WeChat Slash Commands

The WeChat bridge now uses a text-first command surface designed for chat, not buttons.
Recommended entrypoints:

```text
/helps
/h
/st
/login
/lg
/login list
/helps threads
/stop
/sp
/provider
/pd
/models
/ms
/model
/m
/personality
/psn pragmatic
/instructions
/instructions edit
/fast
/fast off
/model gpt-5.4 xhigh
/model high
/threads
/th
/search bridge
/se bridge
/next
/nx
/prev
/pv
/open 2
/o 2
/peek 2
/pk 2
/rename 2 微信桥接排障
/rn 2 微信桥接排障
/model default
/models
/lang
/permissions
/perm
/allow
/al
/allow 1
/allow 2
/deny
/dn
/retry
/rt
```

### `/models` and `/ms`

List available models for the current provider profile.

Examples:

```text
/models
/ms
```

### `/model` and `/m`

Check or switch the model used for future turns.

Examples:

```text
/model
/m
/model default
/model high
/model gpt-5.4 xhigh
/model gpt-5.4
```

All slash commands support command-scoped help flags:

```text
/threads -h
/open --help
/permissions -helps
```

Best-practice rule:

- use `/helps` for command discovery
- use `/login` and `/login list` to manage the host Codex account pool before switching accounts with `/login <index>`
- use `/threads` and numeric indexes on WeChat instead of copying raw thread ids
- use `/personality` to control the response style for future turns in the current scope
- use `/instructions` to manage the active Codex `AGENTS.md` custom instructions file
- use `/lang zh-CN` or `/lang en` to switch reply language for the current scope
- use `/allow 1` or `/allow 2` to approve, and `/deny` to reject, when Codex asks for approval mid-turn
- use `/retry` after an interrupted turn; it refreshes the current Codex session first, then reruns the previous request in the same thread
- use `/helps <command>` when you need exact usage and examples

See the full command reference in [docs/usage/weixin-slash-commands.md](./docs/usage/weixin-slash-commands.md).

## Validation

```bash
npm run typecheck
npm test
```

## Media Tooling

Image normalization and video thumbnail generation now use project-managed `ffmpeg` / `ffprobe` binaries via `ffmpeg-static` and `ffprobe-static`.

Resolution order:

- `CODEXBRIDGE_FFMPEG_PATH` / `CODEXBRIDGE_FFPROBE_PATH`
- `FFMPEG_PATH` / `FFPROBE_PATH`
- bundled binaries from project dependencies
- system `PATH` fallback

This keeps image/video media handling portable across Linux, macOS, and Windows without requiring a manual global `ffmpeg` install in the common case.

## WeChat Login

```bash
npm run weixin:login
```

Run the WeChat bridge loop:

```bash
npm run weixin:serve
```

By default the bridge uses the directory where `weixin:serve` is launched as the shared working directory for new sessions. You can override it with `--cwd` or `CODEXBRIDGE_DEFAULT_CWD`, and you can still rebind a specific chat with `/new /absolute/path/to/project`.

## i18n

The bridge now uses one unified i18n layer for user-visible runtime text.

- Supported locales:
  - `zh-CN`
  - `en`
- Default locale: `zh-CN`
- Process-wide override:
  - `CODEXBRIDGE_LOCALE=zh-CN`
  - `CODEXBRIDGE_LOCALE=en`

Example:

```bash
CODEXBRIDGE_LOCALE=en npm run weixin:serve
```

The locale currently affects:

- slash-command replies
- WeChat runtime failure messages
- CLI login / serve prompts
- bridge restart completion notifications

## systemd User Service

Install and start the user service on Linux:

```bash
bash ./scripts/service/install-systemd-user.sh
```

Useful follow-up commands:

```bash
bash ./scripts/service/status-systemd-user.sh
bash ./scripts/service/restart-systemd-user.sh
bash ./scripts/service/logs-systemd-user.sh
bash ./scripts/service/logs-systemd-user.sh --follow
```

The installer writes a per-user environment file to:

```text
~/.config/codexbridge/weixin.service.env
```

That file is the stable place to adjust:

- `WEIXIN_ACCOUNT_ID`
- `CODEX_DEFAULT_PROVIDER_PROFILE_ID`
- optional proxy profile keys such as `CODEX_PROVIDER_*`
- `CODEXBRIDGE_DEBUG_WEIXIN`

Optional flags:

- `--base-url`
- `--cwd`
- `--state-dir`
- `--bot-type`
- `--timeout-sec`

The login command fetches a QR code, saves the QR image under `~/.codexbridge/weixin/login/`, prints the file path, and waits until the scan is confirmed. Credentials are then stored under `~/.codexbridge/weixin/accounts/`. Runtime scripts now execute `tsx src/cli.ts` and `tsx src/index.ts` directly.
