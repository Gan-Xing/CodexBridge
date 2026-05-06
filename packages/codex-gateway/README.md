# @codexbridge/codex-gateway

Internal package for the Codex Gateway protocol layer.

Current release policy:

- keep this package `private: true`
- keep the export surface minimal while the API boundary stabilizes
- keep package-local build output in `packages/codex-gateway/dist` so `package.json` export paths describe real artifacts
- only revisit npm publication after live-provider coverage and CodexBridge integration contracts are stable

## Internal standalone server

This package now includes an internal-only launcher for the local Responses
adapter server. Build the package, then run:

```bash
pnpm --dir packages/codex-gateway run serve
```

or:

```bash
node packages/codex-gateway/dist/cli.js
```

Supported env knobs:

- `CODEX_GATEWAY_CAPABILITY_PRESET`
- `CODEX_GATEWAY_API_KEY`
- `CODEX_GATEWAY_BASE_URL`
- `CODEX_GATEWAY_MODEL`
- `CODEX_GATEWAY_HOST`
- `CODEX_GATEWAY_PORT`
- `CODEX_GATEWAY_PROVIDER_NAME`
- `CODEX_GATEWAY_PROVIDER_KIND`
- `CODEX_GATEWAY_OWNED_BY`
- `CODEX_GATEWAY_UPSTREAM_CHAT_PATH`
- `CODEX_GATEWAY_CAPABILITY_OVERRIDES_JSON`
- `CODEX_GATEWAY_MODEL_CATALOG_JSON`
- `CODEX_GATEWAY_MODEL_CATALOG_PATH`

Preset-native envs such as `OPENROUTER_*`, `DEEPSEEK_*`, `MINIMAX_*`, `QWEN_*`,
and the Qwen/DashScope aliases are also accepted as fallbacks for API key/base
URL/model resolution.

Immutable target:

> `@codexbridge/codex-gateway` lets Codex run on non-OpenAI and
> OpenAI-compatible model providers by translating Codex-native Responses API
> traffic into provider-specific APIs.

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

## Validation

Package-level checks:

```bash
pnpm run codex-gateway:check-boundary
pnpm run codex-gateway:typecheck
pnpm run codex-gateway:test
pnpm run codex-gateway:build
```

Live OpenAI-compatible provider smoke tests are gated and must run through the
CodexBridge provider profile loader:

```bash
pnpm run test:live-openai-compatible
CODEXBRIDGE_TEST_ENV_FILE=/path/to/codexbridge.env pnpm run test:live-openai-compatible
```

The live test runner does not print API key values. It skips providers whose
profile env is missing, and verifies available provider profiles through the
local `/v1/responses` adapter server.
