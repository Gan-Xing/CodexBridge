# CodexBridge Core Architecture

## Goal

`CodexBridge` is a `platform plugins + Codex engine adapter + bridge core` project.

Immutable product target:

> CodexBridge 的目标是通过微信稳定暴露 Codex 原生能力，并在桥接层扩展微信命令和个人助理工作流；`@codexbridge/codex-gateway` 的目标是让 Codex 稳定接入多模型来源。

This target should not change during implementation. The route, package layout,
and migration order may change as the code evolves, but changes should continue
to serve this target.

The first shipped path is:

- platform: `WeChat`
- engine: `Codex`
- default Codex provider profile: `openai-default`

The architecture must already be ready for:

- platform: `Telegram`
- Codex provider profiles: configuration-only OpenAI-compatible backends such as `MiniMax`, `DeepSeek`, `Qwen`, `OpenRouter`, `Kimi`, `Gemini`, and `iFlow`

## Non-goals for Phase 1

- No Hermes/OpenClaw runtime embedding
- No shared poller with another WeChat gateway
- No group chat support
- No rich card UI parity with Telegram
- No multi-provider mixing inside one real Codex thread

## Core Design Rules

1. Platform is not the source of truth for conversation state.
2. The Codex engine adapter is not allowed to leak platform-specific structures into the core.
3. A real Codex session is identified by:
   - `provider_profile_id`
   - `codex_thread_id`
4. Multiple platform scopes may point to the same bridge session.
5. Provider profile switching must create a new bridge session instead of reusing a previous provider thread.

## Canonical Session Model

For the first implementation, the core unit is `bridge_session`.

A `bridge_session` represents one Codex-backed thread under one provider profile:

- `provider_profile_id`
- `codex_thread_id`
- `cwd`
- `title`

Platform scopes do not own thread state. They only bind to a bridge session.

Examples:

- `weixin:user_123 -> session_openai_a`
- `telegram:-100xx::1417 -> session_openai_a`

If both bindings point to the same session, both platforms are operating the same Codex thread.

## Data Model

### `provider_profiles`

Stores configured Codex provider profiles.

Suggested fields:

- `id`
- `provider_kind`
- `display_name`
- `config`
- `created_at`
- `updated_at`

### `bridge_sessions`

Stores the canonical provider-thread mapping.

Suggested fields:

- `id`
- `provider_profile_id`
- `codex_thread_id`
- `cwd`
- `title`
- `created_at`
- `updated_at`

### `platform_bindings`

Maps a platform scope to a bridge session.

Suggested fields:

- `platform`
- `external_scope_id`
- `bridge_session_id`
- `updated_at`

### `session_settings`

Stores session-level settings instead of platform-level settings.

Suggested fields:

- `bridge_session_id`
- `model`
- `reasoning_effort`
- `service_tier`
- `locale`
- `metadata`
- `updated_at`

## Message Flow

### Existing binding

1. Platform adapter receives a message.
2. Core resolves `platform + external_scope_id`.
3. Binding returns `bridge_session_id`.
4. Session returns `provider_profile_id + codex_thread_id`.
5. The Codex engine adapter continues the Codex thread.
6. The output is projected back to the platform.

### First message without binding

1. Platform adapter receives a message.
2. No binding exists for this scope.
3. Core creates a new bridge session using the default provider profile.
4. The Codex engine adapter starts a new Codex thread.
5. Core saves the new session and the platform binding.
6. The response comes back through the same route.

### Provider profile switch

1. Platform requests a provider change.
2. Core does not mutate the existing bridge session.
3. Core creates a new session for the target provider profile.
4. The platform binding is moved to the new session.
5. The old session remains available for explicit reopening if needed.

## Plugin Contracts

### Platform plugin

Platform plugins must be replaceable and isolated.

Required responsibilities:

- normalize inbound events
- identify external scope
- send messages
- edit messages if supported
- emit typing state if supported
- download attachments if supported

They must not:

- decide provider profile routing
- store canonical thread state
- directly manipulate Codex runtime internals

### Codex engine adapter

The current code still uses the legacy `provider plugin` naming internally, but the runtime meaning is:

- one `codex` engine adapter
- many Codex provider profiles

The Codex engine adapter wraps the Codex app-server runtime.

Required responsibilities:

- list models
- start thread
- resume thread
- start turn
- interrupt turn
- list threads
- read thread

They must not:

- depend on Telegram/WeChat message shapes
- own platform binding state

## Phase 1 Boundary

The first real implementation is intentionally narrow:

- personal WeChat only
- single account
- single poller
- DM only
- Codex only
- default provider profile only
- text only
- text-first slash-style commands with help-driven discovery

This keeps the first bridge real and debuggable.

Current WeChat command design principle:

- no button dependency in core behavior
- `/helps` is the command catalog
- `/<command> -h` is the fast path to per-command help
- thread operations should prefer page indexes over copied raw thread ids

## Telegram Re-entry

Telegram should later be added as another platform plugin.

The target behavior is:

- Telegram scope can bind to the same bridge session as WeChat
- both platforms can continue the same Codex thread when the provider profile is the same
- no Telegram-specific state should be required in the core for that to work

## OpenAI-Compatible Provider Re-entry

Non-OpenAI providers should be added as provider profiles under one generic
`openai-compatible` provider plugin. DeepSeek, MiniMax, Qwen, OpenRouter, Kimi,
Gemini, iFlow, and future compatible providers differ by env config and
capability preset, not by new bridge provider classes.

The compatibility layer follows the same split as CLIProxyAPI:

- provider profiles only decide credentials, base URL, and default model
- model differences live in `openai_compatible` capability presets and catalog data
- thinking/reasoning differences are translated from model capabilities
- payload differences use CLIProxyAPI-style data rules instead of provider-specific branches
- external model catalogs can be imported from CLIProxyAPI `models.json`-shaped files and merged into runtime capabilities
- transient upstream retry is opt-in env configuration, not hidden provider behavior
- local translator repairs are generic and model-keyed, not provider-class keyed
- deployment details such as auth pools, OAuth refresh, proxy rotation, or custom
  provider headers stay outside the bridge provider abstraction

Important rule:

- it must not reuse the OpenAI profile's real Codex thread id
- switching to another provider profile creates a new bridge session
- the platform binding moves, but the provider boundary stays clean

## Codex Gateway Package Architecture

The Codex Gateway protocol layer should stay as an internal TypeScript package
first, then become a publishable npm package only after its API boundary is
stable. The package target is broader than CodexBridge: it should help Codex run
on OpenAI-compatible model providers.

Current Phase 5 decision:

- keep `@codexbridge/codex-gateway` internal-only (`private: true`) for now
- keep the package export surface minimal while live-provider coverage and CodexBridge integration contracts are still settling
- keep package-local build output under `packages/codex-gateway/dist` so `package.json` exports and files describe real artifacts
- allow an internal-only standalone launcher for the local `/v1/responses` adapter server, as long as it stays inside the package boundary and does not pull bridge runtime concerns back in
- only revisit publication after the protocol boundary is demonstrably stable

Target dependency direction:

```text
WeChat / Telegram
  -> CodexBridge platform runtime
  -> Bridge core sessions and provider profiles
  -> OpenAICompatibleProviderPlugin
  -> @codexbridge/codex-gateway
  -> upstream OpenAI-compatible Chat Completions provider
```

Runtime request map:

```text
Codex app-server / Codex CLI
  POST /v1/responses
    local adapter server
      responsesRequestToChatCompletions()
        upstream POST /v1/chat/completions
      chatCompletionsResponseToResponses()
  SSE /v1/responses
    local adapter server
      upstream Chat Completions SSE
      translateChatCompletionsSseToResponsesEvents()
  GET /v1/models
    model catalog + provider capability metadata
```

Suggested internal package layout:

```text
packages/codex-gateway/
  package.json
  tsconfig.json
  src/
    index.ts
    types/
      responses.ts
      chat.ts
      capability.ts
      stream.ts
    converters/
      responses_to_chat.ts
      chat_to_responses.ts
      tool_calls.ts
      multimodal.ts
      usage.ts
      errors.ts
    stream/
      sse_parser.ts
      chat_stream_to_responses.ts
      responses_event_builder.ts
    capabilities/
      catalog.ts
      presets.ts
      payload_rules.ts
      thinking_policy.ts
    server/
      responses_adapter_server.ts
```

The package owns only reusable protocol behavior:

- `/v1/responses` request conversion into upstream Chat Completions payloads
- upstream Chat Completions JSON response conversion into Responses objects
- upstream Chat Completions SSE conversion into Responses SSE events
- function/tool call conversion, including streaming argument deltas
- provider usage/token normalization
- provider error and stream failure normalization
- capability-driven downgrades for tools, reasoning, JSON/schema, multimodal input, and unsupported parameters
- local adapter server routes for `/v1/responses`, `/v1/responses/compact`, and `/v1/models`

Phase 0 freezes the current migration surface before files move. This is the
surface that current CodexBridge code and tests depend on, not the final npm
package API:

```ts
export function responsesRequestToChatCompletions(request, options): ChatRequest;
export function chatCompletionsResponseToResponses(response, options): ResponsesObject;
export function translateChatCompletionsSseToResponsesEvents(chunks, options): ResponsesEvent[];
export async function* translateChatCompletionsSseStreamToResponsesSse(stream, options): AsyncGenerator<string>;
export function responsesRequestToCompactionResponse(request, options): ResponsesObject;
export function getOpenAICompatibleProviderPreset(id): ProviderPreset;
export function buildOpenAICompatibleModelCatalog(options): ProviderModelInfo[];
export function buildOpenAICompatibleExternalModelCatalog(options): ProviderModelInfo[];
export function mergeOpenAICompatibleProviderCapabilities(...items): ProviderCapabilities;
export function resolveOpenAICompatibleProviderCapabilitiesForModel(capabilities, model): ProviderCapabilities;
export function resolveReasoningEffortForProvider(options): ReasoningEffort | null;
export function applyThinkingPolicyToOpenAIChatRequest(target, policy, effort): JsonRecord;
export class OpenAICompatibleResponsesAdapterServer {}
export function reserveLocalPort(): Promise<number>;
```

The WebSocket repair primitives are also part of the Phase 0 migration surface
because they are protocol-layer behavior, even though the current local adapter
server path avoids WebSocket mode by default:

```ts
export function normalizeResponsesWebSocketRequest(request, cache): ResponsesWebSocketNormalizeResult;
export function repairResponsesWebSocketToolCalls(request, cache): JsonRecord;
export function repairResponsesWebSocketToolCallInput(input, cache): JsonRecord;
export function recordResponsesWebSocketToolCallsFromEvent(event, cache): void;
export function shouldReplaceResponsesWebSocketTranscript(request): boolean;
```

The future stable npm API should be smaller than this migration surface.
Everything else should remain private until at least one external consumer needs
it. This prevents the future npm package from locking in internal helper shapes
too early.

Phase 0 validation baseline:

- `pnpm exec tsx --test test/providers/openai_compatible/responses_adapter.test.ts`
- `pnpm exec tsx --test test/providers/openai_compatible/responses_adapter_server.test.ts`
- `pnpm exec tsx --test test/providers/openai_compatible/responses_websocket_repair.test.ts`
- `pnpm exec tsx --test test/providers/openai_compatible/plugin.test.ts`

Phase 1A establishes the package boundary:

- package root: `packages/codex-gateway`
- source entry: `packages/codex-gateway/src/index.ts`
- package typecheck: `pnpm run codex-gateway:typecheck`
- package build: `pnpm run codex-gateway:build`
- package public-surface test: `pnpm run codex-gateway:test`
- boundary check: `pnpm run codex-gateway:check-boundary`

Phase 1B moves the first pure protocol/data slice into the package:

- `packages/codex-gateway/src/capabilities/thinking_policy.ts`
- `packages/codex-gateway/src/capabilities/cliproxy_model_catalog.ts`
- `packages/codex-gateway/src/capabilities/capability_presets.ts`

Phase 1C moves the converter and stream translator implementation into the
package:

- `packages/codex-gateway/src/converters/responses_adapter.ts`

Phase 3 moves the local adapter HTTP server into the package:

- `packages/codex-gateway/src/server/responses_adapter_server.ts`

Phase 4 freezes package-boundary behavior with a fixture-based contract suite:

- `packages/codex-gateway/test/contracts.test.ts`
- Responses request to Chat request conversion, including JSON/schema formatting
- Chat response to Responses object conversion
- Chat SSE to Responses SSE event conversion
- function/tool call conversion and tool-name restoration
- provider usage normalization, including Gemini-family `usageMetadata`
- provider error and stream read-failure normalization
- local compact fallback behavior
- capability-driven downgrades for unsupported tools, images, and files

The legacy CodexBridge paths are now re-export shims for those files. The
CodexBridge provider integration wrapper remains at
`src/providers/openai_compatible/plugin.ts` and is responsible for provider
profile/env wiring only.

Preset-backed compatible provider exposure should stay registration-driven:

- package preset metadata lives in `packages/codex-gateway/src/capabilities/capability_presets.ts`
- `OPENAI_COMPATIBLE_PROFILE_PRESET_REGISTRATIONS` is the source of truth for built-in compatible profile exposure
- `src/providers/codex/config.ts` should iterate that registration data instead of hardcoding one-off provider branches
- additional arbitrary compatible providers may be declared through `CODEX_COMPAT_PROFILES_JSON` or `CODEX_COMPAT_PROFILES_PATH` so provider onboarding can stay config-first even outside the built-in preset list
- custom compatible provider definitions may also merge `capabilityOverrides`, so many provider-specific quirks can stay in configuration instead of forcing new bridge-side branches
- custom compatible provider definitions may also embed `modelCatalog`, so provider-specific model metadata can stay in configuration without requiring a separate file

CodexBridge keeps all bridge/runtime behavior:

- WeChat and Telegram transports
- SendGate, message chunking, typing, and platform rate-limit behavior
- slash commands, i18n, help text, and user-facing interaction design
- bridge sessions, provider profile selection, thread binding, and recovery
- approvals, retries, reconnects, and interrupted-turn handling
- assistant records, automations, uploads, and artifact delivery policy
- native OpenAI Codex app-server account/session handling

The first extraction should preserve old import paths with re-export shims, so
existing provider code can migrate incrementally:

```text
src/providers/openai_compatible/responses_adapter.ts
  re-exports from packages/codex-gateway

src/providers/openai_compatible/responses_adapter_server.ts
  re-exports from packages/codex-gateway

src/providers/openai_compatible/capability_presets.ts
  re-exports from packages/codex-gateway

src/providers/shared/thinking_policy.ts
  re-exports from packages/codex-gateway
```

This keeps the current bridge stable while creating a clean package boundary for
future reuse by Telegram Bridge, Mission Control, or a standalone proxy.

Extraction dependency rules:

- package code must not import from `src/core`, `src/platforms`, `src/runtime`, `src/store`, or `src/i18n`
- package code may depend on Node built-ins and local package files only
- CodexBridge provider code may import package APIs, but package code must never import CodexBridge provider code
- boundary automation should also keep legacy bridge-side shim files as pure re-exports so protocol logic does not drift back out of `packages/codex-gateway`
- live-provider smoke tests stay in CodexBridge until the adapter package has a stable fixture-based contract suite
- live-provider smoke tests must load real CodexBridge provider profiles through `loadCodexProfilesFromEnv()` before starting the local adapter server; hand-written provider specs are not enough to validate bridge profile wiring
- live-provider smoke tests may use `CODEXBRIDGE_TEST_ENV_FILE` to load a service env file, but test output must never print API key values
- the package should not expose account, auth-pool, proxy-rotation, or OAuth concepts until those become a separate deployment package

Deferred architecture:

- a full IR layer is useful later, but the first extraction should remain Responses-to-Chat because that is the active production path
- a standalone HTTP proxy binary is useful later, but it should wrap the package after CodexBridge integration is stable
- Anthropic/Gemini native endpoints should wait until the package boundary is proven with OpenAI-compatible Chat providers

## Current Implementation Strategy

The first repository milestone is not a fake “WeChat connected” demo.

It is:

1. architecture documents in repo
2. core repositories and routing primitives
3. platform and Codex engine adapter contracts
4. zero-dependency in-memory implementations for testing the model
5. bootstrap code that future WeChat/Codex code can attach to without redesign
6. a text-first command surface that can later be rendered as richer UI on Telegram without changing core semantics
