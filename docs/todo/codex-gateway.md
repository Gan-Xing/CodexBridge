# Codex Gateway TODO

This document tracks the implementation backlog for
`@codexbridge/codex-gateway`.

## Status

This workstream is currently paused.

Keep this document as a historical backlog and reference. It should not be
treated as an active implementation queue unless the product direction changes
again.

It is the execution-oriented companion to:

- `docs/architecture/codexbridge-core-architecture.md`
- `docs/todo/roadmap.md`

## Scope

Codex Gateway should become the protocol layer that lets Codex run on
OpenAI-compatible model providers without changing bridge-side WeChat UX.

It should own:

- Responses request to Chat Completions request conversion
- Chat Completions response to Responses object conversion
- SSE and stream-event conversion
- function/tool call conversion and repair
- provider capability catalog and payload rules
- reasoning/thinking policy normalization
- usage and error normalization
- local `/v1/responses` adapter server

It should **not** own:

- WeChat/Telegram transports
- SendGate delivery policy or `ret:-2` handling
- slash commands, i18n, and user-facing chat UX
- bridge sessions, thread binding, or provider profile selection UX
- approvals, retry/reconnect, or interrupted-turn recovery state
- assistant records, automations, uploads, or artifact delivery policy
- Codex native account/session management

## Track Branch

Primary long-lived branch for this workstream:

```text
track/codex-gateway
```

Expected file ownership for this branch:

- `packages/codex-gateway/**`
- `src/providers/codex/config.ts`
- `src/providers/openai_compatible/**`
- `src/providers/shared/thinking_policy.ts`
- `test/providers/codex/config.test.ts`
- `test/providers/openai_compatible/**`
- `reference/codex-gateway/**`
- `docs/architecture/codexbridge-core-architecture.md`
- `docs/todo/codex-gateway.md`

Avoid frequent edits here unless the change is truly cross-cutting:

- `docs/todo/roadmap.md`
- `README.md`
- `package.json`

## Last Active Focus

- [x] Stop treating OpenRouter live smoke as an active Phase 4 blocker; defer it until credentials are available again
- [x] Keep new provider onboarding config-first and capability-driven instead of adding one-off provider classes
- [x] Keep package ownership strictly at protocol/gateway level
- [x] Decide whether Phase 5 should remain internal-only or move toward publishable package form

Latest progress:

- [x] Preset-backed provider profile exposure now iterates `OPENAI_COMPATIBLE_PROFILE_PRESET_REGISTRATIONS` instead of hardcoded per-provider `pushProfile(...)` calls in `src/providers/codex/config.ts`
- [x] Qwen/DashScope env alias handling is covered by dedicated config tests so compatible-provider onboarding stays registration-driven
- [x] `CODEX_COMPAT_PROFILES_JSON` can now declare multiple custom OpenAI-compatible provider profiles without adding new provider/plugin classes
- [x] `CODEX_COMPAT_PROFILES_PATH` now supports file-based custom compatible provider lists, with inline JSON taking precedence for duplicate IDs
- [x] Custom compatible provider definitions can now merge `capabilityOverrides`, so provider-specific tool/multimodal/thinking/retry quirks can often stay in config instead of code
- [x] Custom compatible provider definitions can now embed `modelCatalog` directly, so provider onboarding can stay config-first even without a separate catalog file
- [x] Custom compatible profile JSON ignores invalid entries while preserving existing built-in preset, single-profile, and legacy config paths
- [x] `scripts/check-codex-gateway-boundary.mjs` now enforces that legacy bridge-side shim files stay pure re-exports into `packages/codex-gateway`
- [x] Package public-surface tests now lock `@codexbridge/codex-gateway` to an internal-only release channel (`private: true` + minimal exports/files) until the API boundary and live-provider matrix are stable
- [x] Package `tsconfig` now emits into `packages/codex-gateway/dist`, and public-surface tests lock that build layout to the `package.json` exports/files contract
- [x] OpenRouter live smoke is no longer treated as a current phase blocker; it is deferred until credentials are available again
- [x] `codex-gateway` now ships an internal-only standalone server launcher that can boot the local `/v1/responses` adapter directly from env, without pulling in CodexBridge runtime code
- [x] The standalone launcher now supports dotenv-style env-file loading (`CODEX_GATEWAY_ENV_FILE` / `--env-file`) so it can run without manual shell exports
- [x] `codex-proxy`-inspired regression tests now lock `previous_response_id` preservation and Codex-style stream event ordering at the package server boundary
- [x] LiteLLM-inspired upstream error normalization now preserves `retry_after_ms` plus selected request/rate-limit headers at the package server boundary
- [x] LiteLLM-style model catalog pricing and context-window metadata are now normalized and preserved through package `/v1/models` output
- [x] LiteLLM-style usage aliases such as cache, reasoning, audio, and prediction token fields are now normalized into Responses usage details at the package boundary
- [x] LiteLLM-inspired usage normalization now associates response usage with normalized model pricing metadata to expose estimated input, output, and total cost at the package boundary
- [x] Package `/v1/models` output now includes a normalized `protocol` view that merges provider defaults with model overrides for tools, multimodal input, reasoning, compact support, structured output, and output-token limits
- [x] Package model catalogs and `/v1/models` output now include a normalized `capabilityCatalog` summary for tool calling, file/PDF input, reasoning, compact support, and provider/model-specific quirks
- [x] Package `/v1/models` output now also exposes top-level adapter `meta` plus per-model routing and reasoning-transport metadata, so upstream model alias rewrites and provider-specific thinking toggles are visible without replaying a live request
- [x] Model-level retry overrides now apply to live upstream retry decisions, and `/v1/models` exposes normalized retry metadata at both top-level adapter `meta` and per-model `protocol` views
- [x] Package trace mode now emits machine-readable `request.adjusted` events for filtered fields, dropped tools, capped output-token requests, and unsupported image/file input downgrades
- [x] Package-local trace mode now exposes optional request/response/retry/stream trace hooks, and the internal standalone launcher can emit those trace events as NDJSON to stderr
- [x] Upstream error normalization now exposes stable categories and retry hints for authentication, rate-limit, transient, unsupported-feature, invalid-request, and malformed-upstream cases
- [x] Package contract coverage now includes provider-shaped golden fixtures for streaming tool-call deltas, Gemini-style usage payloads, and top-level rate-limit error events
- [x] `open-responses`-inspired package server coverage now locks `/models`, `/responses`, and `/responses/compact` as the primary Responses-first routes, while keeping `/v1/*` aliases for SDK compatibility
- [x] `llm-rosetta`-inspired protocol-boundary rules now explicitly lock `openai-chat-compatible` to the current direct adapter path and defer Anthropic/Gemini-native targets behind a future IR gate

## Packaging Direction

The package should stay as an internal package inside the CodexBridge
repository first:

```text
packages/codex-gateway/
```

Rules:

- `CodexBridge -> @codexbridge/codex-gateway`
- `@codexbridge/codex-gateway -X-> CodexBridge core/platform/runtime/store/i18n`
- No workspace/monorepo conversion is required yet
- Legacy CodexBridge provider paths may remain re-export shims during migration
- Phase 5 decision on 2026-05-06: keep the package internal-only for now; do not widen npm/public surface until live-provider coverage and integration contracts are stable
- Keep package-local build output aligned with `package.json` exports/files so the internal package can still be consumed exactly as declared
- Standalone server launch is allowed as an internal validation/tooling aid, but it is still not positioned as a public gateway product
- The standalone launcher may load dotenv-style env files for internal operation, but explicit process env must continue to win over file defaults

## Migration Plan

The package should be responsible for:

- [x] Convert OpenAI Responses requests to Chat Completions requests
- [x] Convert Chat Completions responses back to Responses objects
- [x] Convert Chat Completions SSE chunks into Responses SSE events
- [x] Convert tool/function calls in both non-streaming and streaming paths
- [x] Map provider usage/token fields into Responses usage
- [x] Map provider errors and stream read failures into stable Responses errors
- [x] Apply provider capability rules for tools, reasoning/thinking, payload quirks, multimodal input, JSON/schema support, token caps, and unsupported feature downgrade
- [x] Expose a small local adapter server that presents `/v1/responses`, `/v1/responses/compact`, and `/v1/models`

The package must continue **not** to own:

- WeChat commands, SendGate, chunking, typing, or `ret:-2` behavior
- Bridge sessions, provider profile selection, thread binding, `/new`, `/open`, `/threads`, or `/status`
- `/allow`, `/deny`, `/retry`, `/reconnect`, approval state, or interrupted-turn recovery
- Assistant records, automations, uploads, attachment archival, or i18n
- Codex account/session management and native OpenAI app-server behavior

### Phase 0

- [x] Freeze current behavior with existing adapter tests before moving files
- [x] Record the public surface that CodexBridge depends on: request conversion, response conversion, stream conversion, compact fallback, provider presets, capability merge, WebSocket repair primitives, and local adapter server

Frozen migration surface:

- [x] Core converters: `responsesRequestToChatCompletions`, `chatCompletionsResponseToResponses`, `responsesRequestToCompactionResponse`
- [x] Stream converters: `translateChatCompletionsSseToResponsesEvents`, `translateChatCompletionsSseStreamToResponsesSse`
- [x] Local server: `OpenAICompatibleResponsesAdapterServer`, `reserveLocalPort`
- [x] Capability/model catalog: `getOpenAICompatibleProviderPreset`, `buildOpenAICompatibleModelCatalog`, `buildOpenAICompatibleExternalModelCatalog`, CLIProxyAPI catalog helpers
- [x] Thinking/payload policy: capability types, `mergeOpenAICompatibleProviderCapabilities`, `resolveOpenAICompatibleProviderCapabilitiesForModel`, `resolveReasoningEffortForProvider`, `applyThinkingPolicyToOpenAIChatRequest`
- [x] WebSocket repair: transcript replacement, synthetic call ID, tool-call input repair, and event recording primitives
- [x] Baseline tests run on 2026-05-06: adapter, adapter server, WebSocket repair, and OpenAI-compatible plugin tests

### Phase 1A: Package bootstrap

- [x] Package root: `packages/codex-gateway`
- [x] Package metadata: `packages/codex-gateway/package.json`
- [x] Package source entry: `packages/codex-gateway/src/index.ts`
- [x] Package README documents protocol-only ownership and bridge non-ownership
- [x] Root scripts: `codex-gateway:typecheck`, `codex-gateway:build`, `codex-gateway:test`, `codex-gateway:check-boundary`
- [x] Boundary script: `scripts/check-codex-gateway-boundary.mjs`
- [x] Root `tsconfig.json` includes `packages/**/*.ts` so full typecheck/build sees package code
- [x] Verification run on 2026-05-06: `codex-gateway:typecheck`, `codex-gateway:test`, `codex-gateway:check-boundary`, `codex-gateway:build`, root `typecheck`, root `build`, and `git diff --check`

### Phase 1B: Capability migration

- [x] Moved `src/providers/shared/thinking_policy.ts` implementation to `packages/codex-gateway/src/capabilities/thinking_policy.ts`
- [x] Moved `src/providers/openai_compatible/cliproxy_model_catalog.ts` implementation to `packages/codex-gateway/src/capabilities/cliproxy_model_catalog.ts`
- [x] Moved `src/providers/openai_compatible/capability_presets.ts` implementation to `packages/codex-gateway/src/capabilities/capability_presets.ts`
- [x] Replaced the old CodexBridge paths with re-export shims so existing imports continue to work
- [x] Removed the package-side dependency on CodexBridge `ProviderModelInfo` by introducing a package-local structural `OpenAICompatibleModelInfo`
- [x] Added package-level capability tests for presets, external catalog import, reasoning effort resolution, and model capability overrides
- [x] Verification run on 2026-05-06: `codex-gateway:typecheck`, `codex-gateway:test`, `codex-gateway:check-boundary`, `codex-gateway:build`, OpenAI-compatible adapter/config/plugin tests, root `typecheck`, root `build`, and `git diff --check`

### Phase 1C / Phase 2: Converter migration

- [x] Moved `src/providers/openai_compatible/responses_adapter.ts` implementation to `packages/codex-gateway/src/converters/responses_adapter.ts`
- [x] Replaced the old `src/providers/openai_compatible/responses_adapter.ts` path with a re-export shim so adapter server and tests keep working
- [x] Exported request conversion, response conversion, compaction fallback, and SSE translator APIs from `packages/codex-gateway/src/index.ts`
- [x] Added package-level converter tests for request conversion, response conversion, and SSE conversion
- [x] Verification run on 2026-05-06: `codex-gateway:typecheck`, `codex-gateway:test`, `codex-gateway:check-boundary`, `codex-gateway:build`, OpenAI-compatible adapter/config/plugin tests, root `typecheck`, root `build`, and `git diff --check`

### Phase 3: Server migration

- [x] Moved `src/providers/openai_compatible/responses_adapter_server.ts` implementation to `packages/codex-gateway/src/server/responses_adapter_server.ts`
- [x] Replaced the old `src/providers/openai_compatible/responses_adapter_server.ts` path with a re-export shim so `OpenAICompatibleProviderPlugin` and existing tests keep working
- [x] Exported `OpenAICompatibleResponsesAdapterServer`, server options, and `reserveLocalPort` from `packages/codex-gateway/src/index.ts`
- [x] Added package-level server tests for compact fallback, model metadata, and local port reservation
- [x] Verification run on 2026-05-06: `codex-gateway:typecheck`, `codex-gateway:test`, `codex-gateway:check-boundary`, `codex-gateway:build`, OpenAI-compatible adapter/server/config/plugin/WebSocket repair tests, root `typecheck`, root `build`, and `git diff --check`

### Phase 4: Contract suite and live smoke

- [x] Added `packages/codex-gateway/test/contracts.test.ts` as the package-boundary contract suite
- [x] Covered Responses request to Chat request conversion without bridge-owned fields
- [x] Covered non-streaming Chat response to completed Responses object conversion
- [x] Covered function tool request conversion, tool-name shortening, and response-side name restoration
- [x] Covered model-level tool disabling and transcript downgrade behavior
- [x] Covered streaming text and tool-call deltas into Responses SSE events
- [x] Covered OpenAI usage, Gemini-family `usageMetadata`, and estimated usage fallback
- [x] Covered upstream stream errors and upstream read failures as `response.failed`
- [x] Covered local compact fallback output
- [x] Covered multimodal downgrade for unsupported image and file input
- [x] Full verification run on 2026-05-06: `codex-gateway:check-boundary`, `codex-gateway:typecheck`, `codex-gateway:test`, `codex-gateway:build`, OpenAI-compatible adapter/server/config/plugin/WebSocket repair tests, root `typecheck`, root `build`, and `git diff --check`
- [x] Refactored live-provider smoke tests to load the real CodexBridge provider profiles via `loadCodexProfilesFromEnv()` before starting the local Responses adapter server
- [x] Added `pnpm run test:live-openai-compatible` as the explicit gated live smoke entrypoint
- [x] Profile-based live smoke harness verification run on 2026-05-06: default test path skips safely; gated path also skips when current shell has no DeepSeek, MiniMax, Qwen/DashScope, or OpenRouter profile env
- [x] Added `CODEXBRIDGE_TEST_ENV_FILE` support to the test runner so gated live tests can load a service env file without printing secrets
- [x] Live profile smoke run on 2026-05-06 with `/home/ubuntu/.config/codexbridge/weixin.service.env`: DeepSeek, MiniMax, and Qwen passed through real CodexBridge profiles
- [x] OpenRouter live smoke is explicitly deferred because credentials will not be provided in the near term; Phase 4 now closes with DeepSeek, MiniMax, and Qwen verified

### Phase 5: Publish decision

- [x] Decide whether to publish as `@codexbridge/codex-gateway`; keep it private/internal until the API boundary is stable
- [x] Keep package metadata and package-local build output aligned so `exports` and `files` point at real artifacts
- [x] Add an internal-only standalone launcher for the local `/v1/responses` adapter server without widening the package into a public gateway product
- [x] Let the internal standalone launcher load dotenv-style env files without depending on CodexBridge runtime env loaders
- [x] Keep publication/promotion of the standalone launcher explicitly out of the active package backlog until product direction changes

## Reference Usage

- [x] Use codex-proxy as the main reference for Codex Responses event handling, `previous_response_id`, function-call streams, and real protocol tests
- [x] Use llm-rosetta as the reference for a future IR layer; do not add a full IR until Responses-to-Chat starts blocking Anthropic/Gemini-native support
- [x] Use LiteLLM as the reference for provider catalogs, cost/usage metadata, retry/error taxonomy, and gateway-level operational concerns
- [x] Treat open-responses as a Responses-first product reference, not as code to vendor into this adapter

## Completion Criteria

- [x] Codex Gateway package extraction, reference-driven hardening, and internal-only standalone tooling are no longer blocked on package-local protocol work
- [x] The gateway package can be tested without starting WeChat or CodexBridge runtime
- [x] The gateway package has no imports from CodexBridge core, platform runtimes, stores, slash commands, or i18n
- [x] Legacy CodexBridge import paths still work through re-export shims during the migration window
- [x] Adding a new OpenAI-compatible provider normally requires config/capability data, not a new provider plugin class
- [x] Unsupported provider features produce clear downgrade/error behavior instead of silent stalls or malformed upstream payloads
- [x] Existing CodexBridge OpenAI-compatible tests pass through the new package boundary

## Optional Package Enhancement Backlog

These items are still valid `codex-gateway` work, but they are **not**
required to consider the current package extraction complete.

They stay here because they are still package-local protocol improvements,
not bridge-side WeChat product work.

- [x] Expand the package-local provider capability catalog beyond the current presets and pricing metadata
  The package now exposes a normalized `capabilityCatalog` summary for tool
  calling, image/file/PDF input, JSON/schema support, reasoning support,
  compact support, limits, and provider/model-specific quirks where the
  metadata is reliable enough to drive downgrade or debug behavior.
- [x] Strengthen provider error taxonomy and retry hints beyond the current normalized upstream error surface
  The package now distinguishes authentication failures, rate limits,
  transient upstream failures, unsupported-feature responses, invalid
  requests, and malformed provider payloads with stable machine-readable
  categories and retry guidance.
- [x] Add package-local golden fixtures for real provider responses and stream events
  The package now keeps representative provider-shaped fixture files for
  streaming tool-call events, Gemini-style usage payloads, and top-level
  rate-limit error events so future adapter changes can be checked against
  stable protocol samples instead of only synthetic unit inputs.
- [x] Extend package `/v1/models` output with richer protocol-facing metadata
  The package now exposes a normalized `protocol` block alongside raw model
  capability data so bridge/UI introspection can rely on effective adapter
  behavior instead of reconstructing provider defaults elsewhere.
- [x] Expose normalized adapter routing and reasoning-transport metadata in `/models`
  The package now returns top-level adapter `meta` plus per-model routing and
  reasoning-transport details so provider/model alias rewrites and thinking
  toggles can be inspected directly from `/models` instead of inferred from
  payload rules or live trace output.
- [x] Expose normalized retry policy metadata and honor model-level retry overrides
  The package now applies model-specific `retry` capability overrides during
  live upstream retries and exposes the effective retry profile through
  `/v1/models` top-level `meta.retry` plus per-model `protocol.retry`
  metadata for easier debugging and regression checks.
- [x] Add a package-local debug or trace mode for adapter transforms
  The package now exposes optional request/response/retry/stream trace hooks,
  including machine-readable `request.adjusted` events for downgrade/filter
  decisions. The internal standalone launcher can emit trace events directly
  to stderr as NDJSON without relying on CodexBridge runtime logging or
  WeChat transport reproduction.

## Deferred / External Follow-up

- [ ] If publication ever becomes a goal later, decide whether to promote the standalone launcher into a supported standalone HTTP proxy binary
  This is a future product-direction decision, not an active protocol-package blocker.
- [x] CodexBridge can switch OpenAI-native, DeepSeek, MiniMax, Qwen, and OpenRouter profiles without changing WeChat UX
  Bridge/runtime regression coverage now proves stable WeChat-facing `/provider`, `/status`, and `/models` UX across those profile ids. Deferred OpenRouter live smoke remains tracked separately as upstream-provider validation, not as a remaining bridge UX gap.
