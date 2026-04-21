# CodexBridge Roadmap TODO

This document tracks the current direction and the deferred backlog that is
still intentionally not finished.

## Current Priority: Expand Codex Native Capability

These are the areas that should keep moving first:

- [ ] Continue expanding provider-native artifact delivery instead of adding more bridge-only glue
- [ ] Support more Codex-native output kinds with consistent attachment metadata and delivery policy
- [ ] Improve native turn recovery, approval handling, and session continuity around long-running tasks
- [ ] Keep refining file delivery defaults so generated artifacts feel like first-class Codex outputs
- [ ] Improve model / usage / thread introspection where Codex already exposes reliable primitives

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
