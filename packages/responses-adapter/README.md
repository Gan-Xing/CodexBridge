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

Phase 1A is intentionally only the package skeleton plus boundary checks. The
production adapter code still lives under `src/providers/openai_compatible/*`
until the migration phases move code behind re-export shims.
