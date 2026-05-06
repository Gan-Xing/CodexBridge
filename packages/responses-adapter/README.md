# @codexbridge/responses-adapter

Internal package for the CodexBridge OpenAI-compatible protocol adapter.

Immutable target:

> `@codexbridge/responses-adapter` lets CodexBridge reliably connect Codex
> workflows to multiple model sources by translating protocol-layer behavior
> between OpenAI Responses and OpenAI-compatible Chat Completions providers.

This package owns only protocol behavior:

- Responses request conversion
- Chat Completions response conversion
- SSE and stream event conversion
- tool/function call conversion
- usage and error normalization
- multimodal and reasoning/thinking payload policy
- provider capability and payload rules
- a local `/v1/responses` adapter server

It must not own bridge behavior:

- WeChat or Telegram transports
- slash commands or i18n
- SendGate or platform rate limits
- bridge sessions, thread binding, approval, retry, or reconnect state
- assistant records, automations, uploads, or artifact delivery policy

Phase 1B moved the provider capability catalog, CLIProxyAPI-style model catalog,
and reasoning/thinking policy into this package. Phase 1C moved the pure
Responses/Chat converter and SSE translator implementation into this package.
Phase 3 moved the local `/v1/responses` adapter server into this package. The
old CodexBridge paths still exist as re-export shims during migration:

- `src/providers/openai_compatible/capability_presets.ts`
- `src/providers/openai_compatible/cliproxy_model_catalog.ts`
- `src/providers/openai_compatible/responses_adapter.ts`
- `src/providers/openai_compatible/responses_adapter_server.ts`
- `src/providers/shared/thinking_policy.ts`

CodexBridge now keeps only the OpenAI-compatible provider integration wrapper in
`src/providers/openai_compatible/plugin.ts`; package code still must not import
from CodexBridge core/platform/runtime/store/i18n.
