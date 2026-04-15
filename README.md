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

- Core session routing with `/status`, `/new`, `/threads`, `/open`, and `/provider`
- File-backed JSON repositories for persistent bridge state
- WeChat platform skeleton for Hermes-compatible iLink config loading, QR account state reuse, inbound DM normalization, long-poll client/poller wiring, context-token persistence, text chunking, and outbound text/typing delivery
- Codex profile loader and initial Codex app-server client/plugin path for shared thread execution
- WeChat runtime wiring that feeds poll events into the shared bridge coordinator and sends responses back through the WeChat transport

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

Optional flags:

- `--base-url`
- `--state-dir`
- `--bot-type`
- `--timeout-sec`

The login command fetches a QR code, saves the QR image under `~/.codexbridge/weixin/login/`, prints the file path, and waits until the scan is confirmed. Credentials are then stored under `~/.codexbridge/weixin/accounts/`.
