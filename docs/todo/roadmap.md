# CodexBridge Roadmap TODO

This document tracks the current direction and the deferred backlog that is
still intentionally not finished.

## Current Priority: Expand Codex Native Capability

The next phase should favor native Codex capability parity over adding more
bridge-only command glue. The practical split is:

### P0: Native command surface parity

- [ ] Add `/review` for uncommitted changes, base-branch diff review, and last-turn review summaries
- [ ] Add `/plan` or `/plan-mode` so chat threads can explicitly enter native planning mode before execution
- [ ] Add `/mcp` status and management flows on top of native `codex mcp` primitives
- [ ] Add `/plugins` visibility and basic marketplace/status flows on top of native `codex plugin` primitives
- [ ] Add `/skills` visibility so the bridge can show which native skills are available in the current Codex runtime
- [ ] Add `/resume` and `/fork` style session controls where native Codex already exposes those session primitives
- [ ] Keep improving native approval, interrupted-turn, reconnect, and retry handling around long-running tasks
- [ ] Continue expanding provider-native artifact delivery instead of adding more bridge-only glue
- [ ] Support more Codex-native output kinds with consistent attachment metadata and delivery policy
- [ ] Improve model / usage / thread introspection where Codex already exposes reliable primitives

### P1: Native background and execution environment parity

- [ ] Add `codex cloud` task flows for submit/status/list/diff/apply so WeChat can act as a remote task inbox
- [ ] Introduce worktree-aware bridge session state instead of treating every thread as cwd-only
- [ ] Map native worktree handoff concepts into bridge UX without breaking the existing thread binding model
- [ ] Read project-local `.codex` environment metadata so shared local environment setup can inform bridge runs
- [ ] Expose native multi-agent or subagent controls once the bridge can present them clearly in chat
- [ ] Keep refining file delivery defaults so generated artifacts feel like first-class Codex outputs

### P2: Native desktop-only capability parity

- [ ] Design a browser-preview workflow that approximates Codex app browser comments and browser-use results in chat
- [ ] Design a companion-based computer-use workflow for desktop GUI tasks with explicit approvals and app allowlists
- [ ] Decide whether these desktop-native abilities belong in CodexBridge itself or in a separate local companion service

### Guardrail

- [ ] Do not prioritize new bridge-only slash commands ahead of high-value native Codex parity work unless the native layer is unavailable

## Later Direction: Telegram Runtime

The bridge-side Telegram plugin contract now exists, but the real transport
stack is still a later-phase item.

- [ ] Add a real Telegram inbound poller or webhook runtime
- [ ] Add real Telegram outbound transport for text, typing, media, and files
- [ ] Wire Telegram runtime into the same persisted bridge-session flow used by WeChat
- [ ] Verify the same bridge session can be continued across WeChat and Telegram end-to-end

## Later Direction: Additional Codex-Compatible Providers

The provider wrappers exist, but non-OpenAI backends still need actual runtime
integration.

- [ ] Implement the MiniMax via CLIProxyAPI runtime path
- [ ] Validate provider-specific model catalogs, defaults, and usage reporting
- [ ] Verify provider switching boundaries under real runtime conditions

## Engineering Hardening

These are quality improvements, not current product blockers.

- [ ] Reduce `any` in edge adapters and test scaffolding
- [ ] Tighten null handling where it adds real signal
- [ ] Remove remaining transitional typing workarounds when feature churn settles
- [ ] Incrementally strengthen compiler settings after behavior remains stable
