# CodexBridge

CodexBridge is a Codex-centered gateway for connecting multiple chat platforms to one shared Codex engine, while switching backend provider profiles inside Codex when needed.

## Current Direction

- First delivery target: `WeChat + Codex`
- Future platforms: `Telegram`, additional chat transports
- Future Codex provider profiles: `MiniMax via CLIProxyAPI`, additional Codex-compatible backends
- Core rule: platforms are adapters, Codex stays the execution engine, and Codex thread state stays the source of truth

## Documents

- [Core architecture](./docs/architecture/codexbridge-core-architecture.md)
- [WeChat + Codex Phase 1 TODO](./docs/todo/wechat-openai-phase1.md)
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

- Core session routing with WeChat-friendly slash commands, including `/helps`, `/status`, `/new`, `/provider`, `/threads`, `/search`, `/next`, `/prev`, `/open`, `/peek`, `/rename`, `/permissions`, `/reconnect`, and `/restart`
- File-backed JSON repositories for persistent bridge state
- WeChat platform skeleton for Hermes-compatible iLink config loading, QR account state reuse, inbound DM normalization, long-poll client/poller wiring, context-token persistence, text chunking, and outbound text/typing delivery
- Codex profile loader and initial Codex app-server client/plugin path for shared thread execution
- WeChat runtime wiring that feeds poll events into the shared bridge coordinator and sends responses back through the WeChat transport

## WeChat Slash Commands

The WeChat bridge now uses a text-first command surface designed for chat, not buttons.
Recommended entrypoints:

```text
/helps
/helps threads
/threads
/search bridge
/open 2
/peek 2
/rename 2 微信桥接排障
/permissions
```

All slash commands support command-scoped help flags:

```text
/threads -h
/open --help
/permissions -helps
```

Best-practice rule:

- use `/helps` for command discovery
- use `/threads` and numeric indexes on WeChat instead of copying raw thread ids
- use `/helps <command>` when you need exact usage and examples

See the full command reference in [docs/usage/weixin-slash-commands.md](./docs/usage/weixin-slash-commands.md).

## Validation

```bash
npm test
```

## WeChat Login

```bash
npm run weixin:login
```

Run the WeChat bridge loop:

```bash
npm run weixin:serve
```

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
- `--state-dir`
- `--bot-type`
- `--timeout-sec`

The login command fetches a QR code, saves the QR image under `~/.codexbridge/weixin/login/`, prints the file path, and waits until the scan is confirmed. Credentials are then stored under `~/.codexbridge/weixin/accounts/`.
