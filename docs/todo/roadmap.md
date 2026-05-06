# CodexBridge Roadmap TODO

This document tracks the backlog that is still intentionally unfinished.
Completed items are removed from the active checklist instead of being left as
stale TODOs.

## Immutable Target

CodexBridge 的目标是通过微信稳定暴露 Codex 原生能力，并在桥接层扩展微信命令和个人助理工作流；`@codexbridge/responses-adapter` 的目标是让 CodexBridge 能稳定接入多模型来源。

This target is stable. The roadmap may be edited as implementation details
change, but every new task should be judged against whether it advances this
target.

## Current Snapshot

Already landed and no longer part of the active backlog:

- `/review` for uncommitted changes and base-branch review
- `/agent` experimental Codex-first hybrid background jobs with draft-confirm, full-access Codex execution, verifier checks, and retry
- `/plan` session-level native planning mode toggle
- `/skills` visibility and on/off management
- `/apps` runtime connector browsing, auth hints, and enable/disable management
- `/plugins` visibility, aliasing, install/uninstall, and explicit plugin targeting
- `/mcp` status, auth, reload, and enable/disable management
- `/automation` draft-confirm flow and WeChat delivery-oriented scheduling
- Assistant records via `/as`, `/log`, `/todo`, `/remind`, and `/note`, including Codex-normalized natural-language record updates, `/up` attachment archival, and reminder claiming
- WeChat thread browsing with `/threads`, `/open`, `/search`, `/peek`, `/rename`
- Thread cleanup and organization flows such as archive/restore and pin/unpin
- Native-ish reconnect, retry, approval, and attachment delivery hardening

Architecture references now available:

- `reference/symphony` tracks OpenAI Symphony as the orchestration reference.
- `reference/responses-adapter` tracks LiteLLM, codex-proxy, open-responses,
  and llm-rosetta as protocol-adapter references. These sources are ignored by
  git and are for local architecture study only.
- `docs/architecture/codex-mission-control.md` defines how CodexBridge should
  adapt Symphony-style workflow, workspace, workpad, retry, and status concepts
  without replacing the chat-first WeChat control surface.

Important clarification:

- A separate `/resume` command is **not** a current priority because bridge UX
  already treats `/open <thread>` as the practical “resume this old session”
  path.
- A separate `/cwd` command is **not** a current priority because `/status`
  already exposes the current bound session and working-directory context well
  enough for now.

## Current Priority: Make WeChat a Stable Codex Terminal

The next phase should prioritize day-to-day runtime reliability and native
Codex output quality over adding more bridge-only command surface area.

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

### P2: Codex Mission Control

- [ ] Treat `/agent` as the Mission Control v0 surface instead of adding a new `/mission` command too early
- [ ] Add `.codexbridge/mission/WORKFLOW.md` loading with YAML front matter plus prompt body, using Symphony's workflow-contract pattern
- [ ] Add a persistent mission workpad to background jobs so `/agent show` can expose plan, acceptance criteria, validation, notes, blockers, and final handoff
- [ ] Add workspace isolation for code-changing long-running jobs under `~/.codexbridge/mission/workspaces/<missionId>/`
- [ ] Add a bounded runner loop for mission jobs: run, verify, repair/retry, block or complete
- [ ] Keep WeChat as the notification and control entrypoint while allowing future GitHub/Linear issue sources
- [ ] Keep Symphony as a reference implementation only; do not vendor its Elixir runtime into CodexBridge

### P2: Extract reusable Responses adapter package

Goal: split the OpenAI-compatible protocol conversion layer out of the
CodexBridge provider implementation so the same adapter can later be reused by
CodexBridge, Telegram Bridge, Mission Control, or a standalone npm package.

The package should be responsible for:

- [ ] Convert OpenAI Responses requests to Chat Completions requests
- [ ] Convert Chat Completions responses back to Responses objects
- [ ] Convert Chat Completions SSE chunks into Responses SSE events
- [ ] Convert tool/function calls in both non-streaming and streaming paths
- [ ] Map provider usage/token fields into Responses usage
- [ ] Map provider errors and stream read failures into stable Responses errors
- [ ] Apply provider capability rules for tools, reasoning/thinking, payload quirks, multimodal input, JSON/schema support, token caps, and unsupported feature downgrade
- [ ] Expose a small local adapter server that presents `/v1/responses`, `/v1/responses/compact`, and `/v1/models`

The package should **not** own:

- [ ] WeChat commands, SendGate, chunking, typing, or `ret:-2` behavior
- [ ] Bridge sessions, provider profile selection, thread binding, `/new`, `/open`, `/threads`, or `/status`
- [ ] `/allow`, `/deny`, `/retry`, `/reconnect`, approval state, or interrupted-turn recovery
- [ ] Assistant records, automations, uploads, attachment archival, or i18n
- [ ] Codex account/session management and native OpenAI app-server behavior

Migration plan:

- [x] Phase 0: freeze current behavior with existing adapter tests before moving files
- [x] Phase 0: record the current public surface that CodexBridge depends on: request conversion, response conversion, stream conversion, compact fallback, provider presets, capability merge, WebSocket repair primitives, and local adapter server
- [x] Phase 1A: create `packages/responses-adapter` as an internal TypeScript package with its own `src/index.ts`
- [x] Phase 1A: add package-level TypeScript config and test entrypoints before moving production logic
- [x] Phase 1A: add bootstrap public exports for package identity and ownership boundaries
- [x] Phase 1A: add an automated dependency-boundary check so package code cannot import CodexBridge core/platform/runtime/store/i18n modules
- [x] Phase 1B: export provider capability presets, CLIProxyAPI-style model catalog helpers, and thinking policy from the package boundary
- [x] Phase 1B: move provider capability types, thinking policy, payload rules, and CLIProxyAPI-style model catalog import into `packages/responses-adapter`
- [x] Phase 1B: keep legacy re-export shims for migrated capability files under `src/providers/openai_compatible/*` and `src/providers/shared/thinking_policy.ts`
- [x] Phase 1C: export migrated converter APIs from the package boundary and keep helper functions private
- [x] Phase 1C: move Responses/Chat converter option types and pure request/response converter implementation into the package
- [x] Phase 1C: keep legacy re-export shims for converter files under `src/providers/openai_compatible/*`
- [x] Phase 2: move pure converters: request conversion, response conversion, usage mapping, error mapping, multimodal conversion, and tool-name repair
- [x] Phase 2: move stream converters and SSE parser/builder while preserving the existing `response.created`, `response.output_item.added`, `response.output_text.delta`, `response.failed`, and `response.completed` behavior
- [x] Phase 2: add package-boundary converter tests and keep CodexBridge tests as integration coverage
- [x] Phase 3: move the local adapter HTTP server into the package; keep `src/providers/openai_compatible/plugin.ts` as the CodexBridge integration wrapper
- [x] Phase 3: make CodexBridge pass provider profile/env config into the adapter package through the legacy server shim instead of importing converter internals directly
- [ ] Phase 4: add contract tests at the package boundary for Responses request, Chat request, non-streaming output, streaming output, tool calls, usage, errors, compact fallback, and multimodal downgrades
- [ ] Phase 4: run live smoke tests through CodexBridge profiles only after package-level tests pass
- [ ] Phase 5: decide whether to publish as `@codexbridge/responses-adapter`; keep it private/internal until the API boundary is stable
- [ ] Phase 5: optionally add a standalone HTTP proxy binary only after the package is stable. The first product target remains CodexBridge integration, not a public gateway.

Phase 0 frozen migration surface:

- [x] Core converters: `responsesRequestToChatCompletions`, `chatCompletionsResponseToResponses`, `responsesRequestToCompactionResponse`
- [x] Stream converters: `translateChatCompletionsSseToResponsesEvents`, `translateChatCompletionsSseStreamToResponsesSse`
- [x] Local server: `OpenAICompatibleResponsesAdapterServer`, `reserveLocalPort`
- [x] Capability/model catalog: `getOpenAICompatibleProviderPreset`, `buildOpenAICompatibleModelCatalog`, `buildOpenAICompatibleExternalModelCatalog`, CLIProxyAPI catalog helpers
- [x] Thinking/payload policy: capability types, `mergeOpenAICompatibleProviderCapabilities`, `resolveOpenAICompatibleProviderCapabilitiesForModel`, `resolveReasoningEffortForProvider`, `applyThinkingPolicyToOpenAIChatRequest`
- [x] WebSocket repair: transcript replacement, synthetic call ID, tool-call input repair, and event recording primitives
- [x] Baseline tests run on 2026-05-06: adapter, adapter server, WebSocket repair, and OpenAI-compatible plugin tests

Phase 1A package bootstrap:

- [x] Package root: `packages/responses-adapter`
- [x] Package metadata: `packages/responses-adapter/package.json`
- [x] Package source entry: `packages/responses-adapter/src/index.ts`
- [x] Package README documents protocol-only ownership and bridge non-ownership
- [x] Root scripts: `responses-adapter:typecheck`, `responses-adapter:build`, `responses-adapter:test`, `responses-adapter:check-boundary`
- [x] Boundary script: `scripts/check-responses-adapter-boundary.mjs`
- [x] Root `tsconfig.json` includes `packages/**/*.ts` so full typecheck/build sees package code
- [x] Phase 1A verification run on 2026-05-06: `responses-adapter:typecheck`, `responses-adapter:test`, `responses-adapter:check-boundary`, `responses-adapter:build`, root `typecheck`, root `build`, and `git diff --check`

Phase 1B capability migration:

- [x] Moved `src/providers/shared/thinking_policy.ts` implementation to `packages/responses-adapter/src/capabilities/thinking_policy.ts`
- [x] Moved `src/providers/openai_compatible/cliproxy_model_catalog.ts` implementation to `packages/responses-adapter/src/capabilities/cliproxy_model_catalog.ts`
- [x] Moved `src/providers/openai_compatible/capability_presets.ts` implementation to `packages/responses-adapter/src/capabilities/capability_presets.ts`
- [x] Replaced the old CodexBridge paths with re-export shims so existing imports continue to work
- [x] Removed the package-side dependency on CodexBridge `ProviderModelInfo` by introducing a package-local structural `OpenAICompatibleModelInfo`
- [x] Added package-level capability tests for presets, external catalog import, reasoning effort resolution, and model capability overrides
- [x] Phase 1B verification run on 2026-05-06: `responses-adapter:typecheck`, `responses-adapter:test`, `responses-adapter:check-boundary`, `responses-adapter:build`, OpenAI-compatible adapter/config/plugin tests, root `typecheck`, root `build`, and `git diff --check`

Phase 1C/2 converter migration:

- [x] Moved `src/providers/openai_compatible/responses_adapter.ts` implementation to `packages/responses-adapter/src/converters/responses_adapter.ts`
- [x] Replaced the old `src/providers/openai_compatible/responses_adapter.ts` path with a re-export shim so adapter server and tests keep working
- [x] Exported request conversion, response conversion, compaction fallback, and SSE translator APIs from `packages/responses-adapter/src/index.ts`
- [x] Added package-level converter tests for request conversion, response conversion, and SSE conversion
- [x] Phase 1C/2 verification run on 2026-05-06: `responses-adapter:typecheck`, `responses-adapter:test`, `responses-adapter:check-boundary`, `responses-adapter:build`, OpenAI-compatible adapter/config/plugin tests, root `typecheck`, root `build`, and `git diff --check`

Phase 3 server migration:

- [x] Moved `src/providers/openai_compatible/responses_adapter_server.ts` implementation to `packages/responses-adapter/src/server/responses_adapter_server.ts`
- [x] Replaced the old `src/providers/openai_compatible/responses_adapter_server.ts` path with a re-export shim so `OpenAICompatibleProviderPlugin` and existing tests keep working
- [x] Exported `OpenAICompatibleResponsesAdapterServer`, server options, and `reserveLocalPort` from `packages/responses-adapter/src/index.ts`
- [x] Added package-level server tests for compact fallback, model metadata, and local port reservation
- [x] Phase 3 verification run on 2026-05-06: `responses-adapter:typecheck`, `responses-adapter:test`, `responses-adapter:check-boundary`, `responses-adapter:build`, OpenAI-compatible adapter/server/config/plugin/WebSocket repair tests, root `typecheck`, root `build`, and `git diff --check`

Reference usage:

- [ ] Use codex-proxy as the main reference for Codex Responses event handling, `previous_response_id`, function-call streams, and real protocol tests
- [ ] Use llm-rosetta as the reference for a future IR layer; do not add a full IR until Responses-to-Chat starts blocking Anthropic/Gemini-native support
- [ ] Use LiteLLM as the reference for provider catalogs, cost/usage metadata, retry/error taxonomy, and gateway-level operational concerns
- [ ] Treat open-responses as a Responses-first product reference, not as code to vendor into this adapter

Completion criteria:

- [ ] CodexBridge can switch OpenAI-native, DeepSeek, MiniMax, Qwen, and OpenRouter profiles without changing WeChat UX
- [x] The adapter package can be tested without starting WeChat or CodexBridge runtime
- [x] The adapter package has no imports from CodexBridge core, platform runtimes, stores, slash commands, or i18n
- [x] Legacy CodexBridge import paths still work through re-export shims during the migration window
- [ ] Adding a new OpenAI-compatible provider normally requires config/capability data, not a new provider plugin class
- [ ] Unsupported provider features produce clear downgrade/error behavior instead of silent stalls or malformed upstream payloads
- [x] Existing CodexBridge OpenAI-compatible tests pass through the new package boundary

### Guardrail

- [ ] Do not prioritize new bridge-only slash commands ahead of high-value native Codex parity work unless the native layer is unavailable
- [ ] Do not add bridge-only aliases when existing commands already cover the user need well enough, such as `/open` for resume-style continuation or `/status` for cwd/session inspection

## Later Direction: Telegram Runtime

The bridge-side Telegram plugin contract exists, but the real transport stack is
still a later-phase item.

- [ ] Add a real Telegram inbound poller or webhook runtime
- [ ] Add real Telegram outbound transport for text, typing, media, and files
- [ ] Wire Telegram runtime into the same persisted bridge-session flow used by WeChat
- [ ] Verify the same bridge session can be continued across WeChat and Telegram end-to-end

## Later Direction: Additional Codex-Compatible Providers

The generic OpenAI-compatible Responses adapter is now the preferred bridge
path for non-OpenAI providers that expose Chat Completions-shaped APIs. It
covers compact fallback, SSE tool-call repair, CLIProxyAPI-style WebSocket
transcript repair primitives, thinking policy, payload compatibility, error
mapping, CLIProxyAPI top-level stream error chunks, SSE framing, stream read
failure framing, configured transient retry, usage fallback including Gemini-family
`usageMetadata`, multimodal capability flags, CLIProxyAPI `models.json` catalog
import, and model capability metadata.

- [x] Add generic OpenAI-compatible Responses adapter primitives
- [x] Add configuration-only OpenAI-compatible provider profile loader
- [x] Move DeepSeek and MiniMax onto the generic `openai-compatible` provider path
- [x] Port CLIProxyAPI-style model capability catalog for Codex, DeepSeek, MiniMax, Qwen, iFlow, Kimi, OpenRouter, Gemini/AI Studio/Vertex, Claude, and Antigravity model families
- [x] Convert model differences into capability/payload/thinking rules instead of dedicated provider plugins
- [x] Add CLIProxyAPI-style payload raw/default/override/filter/root/protocol matching
- [x] Allow `*_MODEL_CATALOG_PATH` to import CLIProxyAPI `models.json`-shaped catalogs and merge model metadata into runtime capabilities
- [x] Map upstream stream read failures into Responses `response.failed` events instead of broken streams
- [x] Map CLIProxyAPI-style top-level stream error chunks into Responses `response.failed`
- [x] Map Gemini-family `usageMetadata` into Responses usage for non-streaming and streaming responses
- [x] Add explicit `*_REQUEST_RETRY` and `*_RETRY_STATUSES` transient upstream retry support
- [x] Add generic translator repairs for MiniMax consecutive tool calls, iFlow boolean thinking flags, and Kimi upstream model alias rewrite
- [x] Add gated live-provider smoke tests for DeepSeek, MiniMax, Qwen, and OpenRouter
- [x] Validate DeepSeek against the real upstream API through the local Responses adapter
- [x] Port CLIProxyAPI WebSocket transcript/tool-call repair into a tested local module
- [x] Validate MiniMax against the real upstream API through the local Responses adapter
- [ ] Validate Qwen and OpenRouter against real upstream APIs when credentials are available
- [ ] Validate provider-specific catalogs, defaults, and real usage reporting against live providers
- [ ] Verify provider switching boundaries under real runtime conditions
- [ ] Keep runtime WebSocket disabled until the adapter server has a real upgrade handler; the repair logic is now ready for that future path

## Engineering Hardening

These are quality improvements, not current product blockers.

- [ ] Reduce `any` in edge adapters and test scaffolding
- [ ] Tighten null handling where it adds real signal
- [ ] Remove remaining transitional typing workarounds when feature churn settles
- [ ] Incrementally strengthen compiler settings after behavior remains stable
