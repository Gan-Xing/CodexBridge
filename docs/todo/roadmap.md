# CodexBridge Roadmap TODO

This document is the top-level roadmap for CodexBridge.

It should stay short and stable. Detailed implementation checklists belong in
feature-specific TODO files instead of being expanded here.

## Current Status

- `packages/codex-gateway`: paused
- `packages/mission-control`: paused
- `packages/codex-native-api`: retained for possible future work, but currently paused
- active package-level development is intentionally on hold until the bridge direction is narrowed again

## Immutable Target

CodexBridge 的目标是通过微信稳定暴露 Codex 原生能力，并在桥接层扩展微信命令和个人助理工作流。

This target is stable. The route, package layout, and branch strategy may
change, but every new task should be judged against whether it advances this
target.

## Historical Package Branch Model

These long-lived workstream branches remain as historical references for the
paused package work:

```text
main
  stable integration line

track/codex-gateway
  Codex Gateway protocol workstream

track/mission-control
  Mission Control orchestration workstream

track/codex-native-api
  Codex-native localhost API workstream
```

Rules:

- `main` should stay mergeable and reasonably stable
- `track/codex-gateway` is paused
- `track/mission-control` is paused
- `track/codex-native-api` is retained for possible future resumption, but it is also paused right now
- low-level checklist churn should stay out of this file
- avoid frequent concurrent edits to shared files such as:
  - `docs/todo/roadmap.md`
  - `README.md`
  - `package.json`

## Detailed Backlogs

Use these files for detailed implementation work:

- [Codex Native API TODO](./codex-native-api.md) - retained for later
- [Codex Gateway TODO](./codex-gateway.md) - paused
- [Mission Control TODO](./mission-control.md) - paused

Architecture references:

- [Core architecture](../architecture/codexbridge-core-architecture.md)
- [Codex Native API architecture](../architecture/codex-native-api.md)
- [Mission Control architecture](../architecture/mission-control.md) - historical reference

Reference sources currently tracked for later reuse:

- `reference/codex-gateway` for LiteLLM, codex-proxy, open-responses, and llm-rosetta
- `reference/symphony` as the orchestration reference mirror when available
- external upstream references:
  - `Wei-Shaw/sub2api`
  - `router-for-me/CLIProxyAPI`

## Current Snapshot

Already landed and no longer part of the active detailed backlog:

- `/review` for uncommitted changes and base-branch review
- `/plan` session-level native planning mode toggle
- `/skills`, `/apps`, `/plugins`, and `/mcp` visibility and control surfaces
- `/automation` draft-confirm flow and WeChat delivery-oriented scheduling
- Assistant records via `/as`, `/log`, `/todo`, `/remind`, and `/note`
- WeChat thread browsing with `/threads`, `/open`, `/search`, `/peek`, `/rename`
- Native-ish reconnect, retry, approval, and attachment delivery hardening
- `@codexbridge/codex-gateway` extracted as an internal package with package tests, boundary checks, and gated live-provider smoke flow
- `@codexbridge/mission-control` bootstrapped as an internal package skeleton

Important clarification:

- `/open <thread>` remains the practical “resume this old session” path, so a separate `/resume` command is not a current priority
- `/status` already exposes working-directory and session context well enough for now, so a separate `/cwd` command is not a current priority

## Cross-Cutting Priorities

These are the priorities that still belong in the shared roadmap because they
affect the product as a whole, not just one package.

### P0: WeChat runtime reliability

- [ ] Keep improving native approval, interrupted-turn, reconnect, and retry handling around long-running tasks
- [ ] Stabilize WeChat preview/final delivery around send-budget limits, `ret:-2`, and long-reply recovery
- [ ] Ensure plugin/auth/unavailable-capability failures always surface as clear chat-visible guidance instead of silent stalls
- [ ] Keep parser/helper/internal bridge threads hidden from normal thread browsing and automatically cleaned up
- [ ] Keep `/open`, `/threads`, and `/status` optimized for fast real-world session recovery instead of adding redundant resume-style commands

### P1: Native output and delivery quality

- [ ] Continue expanding provider-native artifact delivery instead of adding more bridge-only glue
- [ ] Support more Codex-native output kinds with consistent attachment metadata and delivery policy
- [ ] Keep refining file delivery defaults so generated artifacts feel like first-class Codex outputs
- [ ] Improve model / usage / thread introspection where Codex already exposes reliable primitives
- [ ] Read project-local `.codex` environment metadata so shared local environment setup can inform bridge runs

### P2: Assistant and desktop follow-through

- [ ] Keep improving assistant-record, reminder, and automation delivery quality on WeChat
- [ ] Add optional sync targets for assistant records, such as Notion, Google Drive, or Calendar, while keeping local records as source of truth
- [ ] Design a browser-preview workflow that approximates Codex app browser comments and browser-use results in chat
- [ ] Design a companion-based computer-use workflow for desktop GUI tasks with explicit approvals and app allowlists
- [ ] Decide whether these desktop-native abilities belong in CodexBridge itself or in a separate local companion service

### P2: Codex Gateway summary

Current status: paused.

- [x] Prove end-to-end profile switching across OpenAI-native, DeepSeek, MiniMax, Qwen, and OpenRouter without changing WeChat UX
- [ ] Revisit standalone launcher publication only if product direction changes; it is intentionally internal-only for now
- [ ] Keep deferred OpenRouter live validation clearly separated from completed package-local protocol work

Detailed checklist:

- [Codex Gateway TODO](./codex-gateway.md)

### P2: Codex Native API summary

Current status: retained for possible future work, but currently paused.

- [ ] Expose the logged-in local Codex runtime as a localhost Responses-first API without changing the main WeChat chat flow
- [ ] Route isolated side tasks to Codex Native API while keeping full conversation tasks on the current Codex app-server path
- [ ] Keep external provider APIs as fallback/optional paths rather than the primary route for isolated subtasks
- [ ] Keep the first implementation internal, but preserve a clean path toward later extraction as a reusable package and eventual standalone npm package if justified

Detailed checklist:

- [Codex Native API TODO](./codex-native-api.md)

### P2: Mission Control summary

Current status: paused.

- [x] Preserve Symphony's real core ideas: workflow-owned policy, single orchestrator authority, stable workspace identity, continuation retries after normal exit, and handoff/wait-user states
- [x] Add workflow loading, workpad persistence, workspace isolation, and bounded run/verify/repair loop
- [x] Keep WeChat as the control and notification entrypoint while Mission Control owns orchestration

Detailed checklist:

- [Mission Control TODO](./mission-control.md)

## Guardrails

- [ ] Do not prioritize new bridge-only slash commands ahead of high-value native Codex parity work unless the native layer is unavailable
- [ ] Do not add bridge-only aliases when existing commands already cover the user need well enough, such as `/open` for resume-style continuation or `/status` for cwd/session inspection
- [ ] Do not let this file become a second detailed implementation log for paused package workstreams

## Later Direction: Telegram Runtime

The bridge-side Telegram plugin contract exists, but the real transport stack is
still a later-phase item.

- [ ] Add a real Telegram inbound poller or webhook runtime
- [ ] Add real Telegram outbound transport for text, typing, media, and files
- [ ] Wire Telegram runtime into the same persisted bridge-session flow used by WeChat
- [ ] Verify the same bridge session can be continued across WeChat and Telegram end-to-end
