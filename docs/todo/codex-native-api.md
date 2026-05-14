# Codex Native API TODO

This document tracks the implementation backlog for the `track/codex-native-api`
workstream.

## Status

This workstream is retained as the only package-level backend candidate still
kept for possible future development, but it is currently paused.

Keep this document as a preserved backlog and reference point. It should not be
treated as an active implementation queue right now.

It is the execution-oriented companion to:

- `docs/architecture/codexbridge-core-architecture.md`
- `docs/architecture/codex-native-api.md`
- `docs/todo/roadmap.md`

## Scope

Codex Native API should expose the already logged-in local Codex app-server as a
localhost-callable API surface.

Its first product purpose is **not** to replace the main CodexBridge chat flow.
Its main purpose is to provide an isolated execution surface for:

- classification
- intent detection
- normalization
- short verification
- lightweight side reasoning
- external local clients that need a standard API surface

without polluting the active CodexBridge conversation thread.

It should own:

- localhost API exposure over the logged-in Codex app-server
- Responses-first request/response routing
- `response_id` / continuation mapping needed to emulate stateless API calls
- optional Chat Completions compatibility later
- package- or module-local routing policy for isolated subtasks
- local auth / binding / safety rules for the native API surface

It should **not** own:

- WeChat or Telegram transport behavior
- bridge session binding UX
- SendGate, preview/final chunking, or `ret:-2`
- external provider adaptation already covered by `@codexbridge/codex-gateway`
- user-facing slash-command policy unless a command is explicitly added later
- commercial billing, top-up, or payment workflows

## Historical Track Branch

Primary long-lived branch for this workstream:

```text
track/codex-native-api
```

Expected file ownership for this branch:

- `docs/todo/codex-native-api.md`
- `docs/architecture/codex-native-api.md`
- `docs/architecture/codexbridge-core-architecture.md`
- future native-api runtime files once implementation starts

Avoid frequent edits here unless the change is truly cross-cutting:

- `docs/todo/roadmap.md`
- `README.md`
- `package.json`

## Immutable Workstream Goal

Expose the logged-in local Codex capability as a localhost-callable API so
CodexBridge can run isolated side tasks without polluting the main Codex thread,
while keeping the primary WeChat chat flow unchanged.

In short:

- main conversation flow stays on the current Codex app-server integration
- isolated side tasks prefer Codex Native API
- external provider APIs remain fallback / optional, not the primary path

Canonical one-sentence goal:

> Codex Native API 的目标是把已登录本地 Codex app-server 的订阅能力封装成 localhost 可调用的标准 API，并优先承接 CodexBridge 的隔离型副任务，同时保持主聊天链路不变。

Evolution direction:

- first implementation: internal CodexBridge runtime/module
- next: reusable workspace package
- later if justified: standalone npm package that others can install without
  depending on full CodexBridge bridge UX

## Current Closure Policy

The current implementation already contains some provider-selectable localhost
API seams because it reused the existing CodexBridge provider-profile and
provider-plugin infrastructure.

For the current closure phase:

- do not delete those generalized seams yet
- do not keep expanding them either
- prioritize the `openai-default` / logged-in Codex path until the Codex
  subscription-to-API shape is fully closed
- treat any existing Qwen / MiniMax / DeepSeek localhost-native hooks as frozen
  implementation seams, not as the active workstream target

If provider-selectable localhost routing still matters later, it should return
as an explicit follow-up expansion step after Codex-only closure is done.

## Current Active Focus

- [x] Lock the routing model:
  - main chat flow stays unchanged
  - isolated side tasks prefer native API
  - external providers are fallback
- [x] Lock the fallback hierarchy:
  - preferred: native API
  - local degradation: direct native isolated execution
  - final fallback: external provider path
- [x] Lock ownership and non-ownership at the document level
- [x] Lock the recommended first implementation shape:
  - start as an internal CodexBridge runtime/module, not a new standalone npm
    package
- [x] Lock the API-facade principle:
  - native API should wrap the existing isolated native execution capability,
    not replace it with a separate engine
- [x] Lock the packaging direction:
  - first internal runtime/module
  - then reusable workspace package
  - later standalone npm package if the boundary proves stable
- [x] Phase 1 planning:
  - define the first localhost Responses surface
  - define continuation registry expectations
  - define internal helper call sites that should later route into native API
- [x] Start implementation in the ordered sequence below instead of jumping
  between unrelated phases:
  - extracted `src/providers/codex/native_runtime.ts` as the first internal
    native runtime substrate
  - routed current isolated command-skill/helper turns through that substrate
    instead of duplicating ephemeral-thread bootstrap logic in-place
- [x] Freeze the current provider-selectable localhost API seams in place
  without deleting them, and stop expanding them until the Codex-only native
  subscription path is fully closed
- [x] Re-scope the remaining closure work around the `openai-default` /
  logged-in Codex path first, while keeping the main WeChat chat flow
  unchanged

## Current Closure Priorities

The current closure effort should not continue broad provider-localhost
generalization work.

It should focus on finishing the Codex subscription-to-API product shape first,
while leaving the existing generalized seams frozen in place.

### P1: Required before calling this workstream "closed enough"

1. Runtime shape and startup closure
   - [x] keep standalone startup via `codex native-api-serve`
   - [x] add the bridge-integrated startup path so `weixin serve` can
     optionally start the localhost native API service in the same process
     lifecycle
     - landed via default-enabled embedded native API startup plus explicit
       `CODEX_NATIVE_API_ENABLE=0` opt-out
       `CodexNativeApiService` startup inside `src/cli.ts runWeixinServe()`
   - [x] keep stop/restart behavior symmetrical so the bridge and native-api
     service can shut down together cleanly

2. Local service configuration closure
   - [x] standardize the minimum runtime config for the Codex-only path:
     - `CODEX_NATIVE_API_HOST`
     - `CODEX_NATIVE_API_PORT`
     - `CODEX_NATIVE_API_AUTH_TOKEN`
     - `CODEX_NATIVE_API_DEFAULT_MODEL`
   - [x] add example configuration for the native-api service
     - landed in `config/examples/weixin.service.env.example`
   - [x] document the minimal startup and health-check commands for localhost
     use
     - landed in `docs/architecture/codex-native-api.md`

3. Internal consumption closure
   - [x] keep the current localhost native-api route Codex-only for helper
     tasks
     - landed by gating localhost native-api routing to `openai-native`
       provider requests in `src/providers/codex/native_api_side_task_router.ts`
   - [x] define which internal CodexBridge side-task lanes should prefer the
     Codex-only native API path
     - command-skill parsing
     - review result localization
     - agent result verification
   - [x] define which lanes should remain on direct native execution
     - when localhost routing is disabled
     - when localhost native API is unreachable or unhealthy
     - when the bound provider profile is not `openai-native`
   - [x] keep the main WeChat chat lane unchanged

### P2: Required to harden the Codex-only path after P1 closes

1. Expand regression coverage for:
   - continuation mapping
   - streaming event ordering
   - local auth / localhost-only assumptions
   - restart/reconnect behavior when app-server is restarted

2. Add observability for:
   - request routing target
   - response mapping
   - continuation/session linkage

3. Revisit whether persisted continuation recovery is worth the added state
   surface only after restart semantics, observability, and closure boundaries
   are otherwise stable

### P3: Do only after the Codex-only path is genuinely stable

1. Confirm that the internal runtime/module boundary no longer depends on
   bridge-specific UX behavior
2. Decide whether a single `packages/codex-native-api` package is enough or
   whether runtime/server should split
3. Define the minimal public API surface for package consumers
4. Add package-level tests and exports once extraction begins

## Reference Projects

These projects are references only. They should inform design choices, not be
vendored blindly.

### `Wei-Shaw/sub2api`

Role:

- subscription-to-API product reference

Use for:

- how a subscription-backed service can be surfaced as a standard API
- operational split between upstream account state and downstream API clients
- sticky account/session thinking
- self-hosted service shape and management expectations

Do **not** copy directly:

- payment/top-up/billing product scope
- commercial multi-tenant account marketplace concerns
- large control-plane scope that is not needed for the first Codex-native path

Upstream:

- <https://github.com/Wei-Shaw/sub2api>

### `router-for-me/CLIProxyAPI`

Role:

- compatibility/router reference

Use for:

- protocol breadth (`Responses`, `Chat Completions`, Gemini, Claude, Codex)
- config-first compatibility switches
- payload filter/override/default rules
- local service shape, localhost-first deployment, and management separation
- session affinity and retry/fallback design ideas

Do **not** copy directly:

- multi-provider gateway sprawl into the native-only first phase
- all provider-specific management/UI scope
- remote-exposed management assumptions for an initial localhost-only server

Upstream:

- <https://github.com/router-for-me/CLIProxyAPI>
- <https://help.router-for.me/>

## Design Rules

1. Main CodexBridge chat turns must keep using the current Codex app-server path.
2. Codex Native API is for isolated, side-effect-contained calls first.
3. Responses-first is the primary API surface.
4. Chat Completions compatibility is a later compatibility layer, not Phase 1.
5. Native API should bind to `127.0.0.1` by default.
6. Native API should reuse existing Codex login/subscription state; it should
   not require a normal OpenAI API key.
7. Native API should not pretend to mint a real cloud OpenAI key; it is a local
   facade over a logged-in Codex runtime.
8. Native API and main chat flow share the same underlying Codex subscription
   pool, so routing must stay intentional.
9. Isolated native side-task turns should be created through one runtime module
   that owns ephemeral thread/session bootstrap and the default read-only
   session settings for helper turns.
10. The localhost API shell should resolve provider profile / plugin / auth
    context per request instead of snapshotting one startup session, so
    reconnect and account-switch changes become visible without restarting the
    server.
11. Long-running localhost service startup should have a standalone lifecycle
    entrypoint that does not require WeChat/Telegram runtime startup; bridge
    runtime may host it later, but the first service shell must be independently
    startable.
12. The first continuation registry may stay in-process, but it must make TTL /
    expiry behavior explicit instead of silently collapsing expired chains into
    a generic retry path.
13. `previous_response_id` continuation must stay sticky to the original
    provider profile and active native account; if that affinity breaks, fail
    fast instead of continuing on a different native identity.
14. Phase 3 continuation durability stays explicitly process-local:
    restarting the native-api service clears the default in-memory registry and
    callers must treat old `previous_response_id` chains as invalid until a
    later hardening/extraction phase intentionally adds persisted recovery.
15. Internal helper callers may declare a side-task class, but they must route
    through one module-local native-api side-task router instead of issuing ad
    hoc localhost fetches at each call site; that router owns task-class
    eligibility, localhost auth/binding, and direct-native fallback.
16. Localhost health/debug routes must reuse the same request-scoped provider /
    auth resolution and optional bearer-auth policy as other `/v1/*` routes, so
    readiness output reflects current reconnect/account-switch state instead of
    a startup snapshot.
17. Native-api streaming must flow through the native runtime's
    `onTurnStarted` + `onProgress` hooks and emit SSE from that contract,
    instead of polling thread history or inventing a second streaming
    transport beside the logged-in Codex app-server path.
18. Current closure work must prioritize the `openai-default` / logged-in
    Codex path even if temporary provider-selectable localhost seams remain in
    the implementation.
19. Existing generalized provider-selectable localhost hooks may remain
    temporarily for future expansion, but they are frozen and should not expand
    the scope of the current Codex subscription-to-API closure effort.

## Ordered Executable Sequence

Follow this order. Do not jump ahead unless the earlier item is blocked and the
block is clearly documented.

### 1. Native subscription runtime extraction

Reference focus:

- Sub2API: account/session separation, sticky account identity
- CLIProxyAPI: host-side auth state separated from downstream API usage

Build:

- one internal native runtime service over the logged-in Codex app-server
- active-account lookup and account-switch integration
- readiness checks
- one isolated execution entrypoint for side-task runs

Completion target:

- all later native API work calls the same native runtime substrate instead of
  inventing a second execution path

Implementation checklist:

- [x] Extract an internal native runtime module:
  - `src/providers/codex/native_runtime.ts`
  - owns active-account lookup, readiness probing, isolated session bootstrap,
    and isolated turn execution defaults
- [x] Route current internal helper/command-skill isolated turns through that
  module:
  - assistant record command skill flows
  - automation command skill flows
  - thread command skill flows
  - instructions command skill flows
  - review command skill + review localizer
  - agent command skill + agent verifier
- [x] Fold account-switch/reconnect behavior behind the same runtime-facing
  surface so localhost API consumers do not need to understand bridge-only
  login wiring
  - `src/providers/codex/native_runtime.ts` now owns
    `reconnectProfile()` / `reconnectProfiles()` and returns readiness snapshots
    after reconnect
  - `src/core/bridge_coordinator.ts` auth-switch refresh, `/reconnect`, current
    retry reconnect, and instruction reload refresh now call the runtime
    surface instead of invoking provider reconnect hooks directly
- [x] Add explicit runtime readiness/health call sites that later localhost API
  handlers can reuse directly
  - runtime reconnect helpers now run `checkReadiness()` after refresh so later
    localhost handlers can reuse the same post-reconnect health probe contract

### 2. Localhost Responses API shell

Reference focus:

- CLIProxyAPI localhost deployment shape and downstream local auth model

Build:

- localhost-only server
- `GET /v1/models`
- `POST /v1/responses`
- optional `POST /v1/responses/compact`
- minimal local auth/shared-secret policy if needed

Completion target:

- logged-in Codex can be called through a stable local Responses-first API

Implementation checklist:

- [x] Add an internal localhost server shell module:
  - `src/providers/codex/native_api_server.ts`
  - binds to `127.0.0.1` by default
  - resolves provider/runtime context per request so reconnect and account
    switches do not require a process restart
- [x] Expose `GET /v1/models`
  - returns model catalog plus native-runtime readiness/account metadata for
    local debugging
- [x] Expose non-streaming `POST /v1/responses`
  - reuses `CodexNativeRuntime.runIsolatedTurn()`
  - keeps isolated execution on the existing ephemeral-thread primitive
  - rejects `previous_response_id` until stage 3 lands instead of faking a
    continuation path early
- [x] Add optional local bearer auth for localhost consumers that want a shared
  secret
- [x] Cover the shell with focused tests
  - model listing
  - isolated response execution
  - continuation rejection
  - optional bearer auth
- [x] Decide whether Phase 2 should expose `POST /v1/responses/compact` or keep
  it explicitly unsupported until compatibility/hardening
  - current decision: keep it explicitly unsupported in the first native shell
  - `src/providers/codex/native_api_server.ts` returns `501 not_implemented`
    for `POST /v1/responses/compact` instead of inventing a second response
    shape before continuation/compatibility work lands
- [x] Add startup/lifecycle integration for a long-running localhost service
  outside unit tests
  - `src/providers/codex/native_api_service.ts` now owns standalone provider
    profile selection, auth-path binding, and lifecycle wiring over the
    in-process native API server
  - `src/cli.ts codex native-api-serve` starts the localhost service without
    requiring WeChat/Telegram runtime startup, while preserving the unchanged
    main bridge chat path

### 3. Continuation registry and sticky execution mapping

Reference focus:

- Sub2API sticky session/account affinity
- CLIProxyAPI session continuity and routing affinity

Build:

- `response_id -> native execution identity`
- `previous_response_id -> continuation lookup`
- account/runtime affinity for continuation chains
- continuation expiry and bookkeeping

Completion target:

- API callers get stateless-looking continuation while the native runtime keeps
  the actual chain alive

Implementation checklist:

- [x] Introduce a module-local continuation registry:
  - `src/providers/codex/native_api_continuation_registry.ts`
  - stores `response_id`, `previous_response_id`, isolated `bridgeSession`,
    native thread/turn ids, provider profile, active account id, model, route
    kind, and expiry timestamps
- [x] Support non-streaming `POST /v1/responses` continuation through
  `previous_response_id`
  - `src/providers/codex/native_api_server.ts` now reuses
    `CodexNativeRuntime.continueIsolatedTurn()` instead of creating a new
    ephemeral thread when the previous response is still live
- [x] Enforce sticky provider/account affinity for continuation chains
  - provider-profile mismatch and active-account drift now fail fast instead of
    silently rehoming the chain onto a different native identity
- [x] Cover lookup, expiry, continuation success, and account-mismatch behavior
  with focused tests
- [x] Decide whether continuation mappings must survive native-api service
  restarts in Phase 3, or remain explicitly in-process until Phase 5
  - decision: remain explicitly in-process through Phase 3 and current
    localhost-service startup shape
  - consequence: a native-api service restart drops default continuation state,
    and callers receive `continuation_not_found` rather than silent rehoming or
    fake recovery
  - follow-up: revisit persisted continuation recovery only during later
    hardening/package-extraction work if a second real consumer justifies it

### 4. Internal side-task routing and direct local fallback

Reference focus:

- CLIProxyAPI routing/fallback policy
- current CodexBridge helper-thread execution model

Build:

- opt-in routing for isolated helper task classes
- direct native fallback when the localhost API facade is unavailable
- external-provider fallback only after native routes fail or are explicitly
  overridden

Completion target:

- internal slash-command judgments and similar helper tasks default to native
  execution instead of external-provider APIs

Implementation checklist:

- [x] Introduce one module-local side-task router:
  - `src/providers/codex/native_api_side_task_router.ts`
  - owns task-class eligibility, localhost API request shaping, optional local
    auth header injection, and direct-native fallback
- [x] Define the first native-api-eligible helper task classes in code:
  - `intent_classification`
  - `normalization`
  - `small_verification`
  - `side_reasoning`
- [x] Route the first internal helper lanes through the router instead of
  calling `CodexNativeRuntime.runIsolatedTurn()` ad hoc:
  - command-skill parsing via `src/core/bridge_coordinator.ts invokeCommandSkillTurn()`
  - review result localization
  - agent result verification
- [x] Keep localhost routing explicitly opt-in for bridge runtime integration
  instead of silently probing localhost in every process
  - `BridgeCoordinator` now resolves optional
    `CODEXBRIDGE_INTERNAL_NATIVE_API_*` config into the shared side-task router
  - when bridge-local localhost routing is not configured, helper tasks stay on
    the existing direct-native isolated path
- [x] Preserve helper-turn developer metadata when crossing the localhost API
  shell
  - `src/providers/codex/native_api_server.ts` now forwards internal
    `metadata.codexbridge.eventMetadata` into the isolated native turn event
  - internal `threadMetadata` and `taskClass` are merged into isolated thread
    bootstrap metadata for debugging/routing visibility
- [x] Cover native-api route success, task-class gating, and direct-native
  fallback with focused tests
  - `test/providers/codex/native_api_side_task_router.test.ts`
  - `test/providers/codex/native_api_server.test.ts`
  - `test/core/bridge_coordinator.test.ts`

### 5. Compatibility and hardening

Reference focus:

- CLIProxyAPI compatibility ergonomics
- Sub2API operational stability mindset

Build:

- streaming hardening
- trace/debug/health visibility
- restart/recovery behavior
- optional `Chat Completions` compatibility
- controlled external fallback policy

Completion target:

- Codex Native API becomes a reusable and debuggable long-running local service
  rather than a one-off adapter

Implementation checklist:

- [x] Add a request-scoped localhost health/debug endpoint:
  - `GET /v1/health`
  - reuses `CodexNativeRuntime.checkReadiness()` instead of duplicating probes
  - surfaces continuation-registry durability metadata and current route
    capability flags for local debugging
  - stays behind the same optional bearer-auth policy as other `/v1/*` routes
- [x] Add streaming Responses output once the native runtime exposes a stable
  server-facing stream contract instead of forcing the current
  final-result-only `startTurn()` boundary to pretend it can stream
  - `src/providers/codex/native_runtime.ts` now forwards isolated-turn
    `onTurnStarted` + `onProgress` hooks as the first server-facing streaming
    contract over the existing native execution primitive
  - `src/providers/codex/native_api_server.ts` now serves SSE for
    `POST /v1/responses` when `stream: true`, while keeping
    `POST /v1/responses/compact` unsupported
- [x] Decide the first compatibility slice beyond Responses-first:
  - landed slice: `POST /v1/chat/completions`
  - scope: single-choice text generation, prompt-history rendering, and
    optional SSE streaming over the same native isolated runtime substrate
  - keep `POST /v1/responses/compact` explicitly unsupported until a later
    compatibility/hardening pass justifies a second response shape

## Routing Priority

Target routing priority:

1. Main conversation / main thread tasks
   - direct current Codex app-server path
2. Isolated side tasks
   - Codex Native API
3. Local direct fallback
   - direct native isolated execution when the API layer is unavailable but
     native Codex is still healthy
4. External provider fallback
   - `@codexbridge/codex-gateway` / compatible providers only when native API is
     unavailable, native Codex is unhealthy, or an explicit override requires
     it

## Initial Internal Helper Call Sites

These are the first internal helper lanes that should later be able to route
into Codex Native API once the runtime and API shell exist:

- assistant record natural-language handling:
  - `/as`
  - `/log`
  - `/todo`
  - `/remind`
  - `/note`
- `/auto` natural-language planning and edit flows
- `/threads` and `/search` command-skill parsing
- `/instructions` normalization
- `/review` helper classification
- `/agent` draft/planning-side helper calls

These are side-task candidates, not evidence that the main chat lane should be
re-routed.

## Continuation Registry Expectations

The first continuation registry should explicitly track at least:

- `response_id`
- `previous_response_id`
- `native_thread_id`
- optional `native_turn_id`
- `active_account_id`
- `model`
- `route_kind`
- `started_at`
- `last_used_at`
- `expiry_at`

Phase 3 decision:

- the default registry is process-local in-memory state
- service restart is allowed to invalidate all outstanding continuation chains
- persisted continuation recovery is deferred until later hardening/package
  extraction work

## Recommended Implementation Boundary

The first implementation should live inside CodexBridge as a native runtime
module close to the existing Codex app-server integration, not as a separate
package like `codex-gateway`.

Reason:

- it depends on logged-in native Codex runtime state
- it depends on thread/turn continuation mapping
- it should not pretend to be a generic external-provider adapter

Recommended early ownership candidates:

- future native-api runtime/module files
- `src/providers/codex/**` adjacent integration glue
- native-api-specific docs and tests

Do **not** start by extracting a generic package boundary unless a second real
consumer appears.

## Packaging Evolution Plan

### Stage A: Internal runtime/module

Current chosen direction.

- implement next to existing native Codex runtime wiring
- prove runtime/API/continuation behavior first
- avoid freezing the wrong package API too early

### Stage B: Internal workspace package

Target once runtime and API surface stabilize:

```text
packages/codex-native-api
```

Potential later split if justified:

```text
packages/codex-native-runtime
packages/codex-native-api
```

### Stage C: Standalone npm package

Only after:

- API contract is stable
- continuation behavior is well-tested
- CodexBridge is no longer the only real consumer
- the package can stand on its own without bridge-specific UX assumptions

## Phase Plan

### Phase 0: Architecture lock

- [x] Confirm the immutable routing model:
  - main chat flow stays unchanged
  - side tasks prefer native API
  - external providers are fallback
- [x] Define native API ownership and non-ownership clearly in docs
- [x] Decide that the first implementation lives inside CodexBridge runtime
  or behind a dedicated internal package/module boundary
  - chosen direction: internal CodexBridge runtime/module first, not a new
    package

### Phase 1: Minimal localhost Responses API

- [x] Expose `GET /v1/models`
- [x] Expose `POST /v1/responses`
- [x] Map Codex-native continuation/thread semantics to `response_id` /
  `previous_response_id`
- [x] Bind localhost only by default
- [x] Add minimal local auth or shared-secret policy if needed
- [x] Reuse the same native isolated execution primitive already proven by
  current helper-thread / command-skill flows
- [x] Extract or wrap a stable native runtime service instead of directly
  calling scattered provider primitives
- [x] Resolve provider/runtime context per request so reconnect/account-switch
  changes remain visible to localhost callers without a restart
- [x] Keep `POST /v1/responses/compact` explicitly unsupported until later
  compatibility/hardening work instead of adding a premature second response
  shape
- [x] Add a standalone localhost service lifecycle entrypoint so native API
  startup does not depend on WeChat/Telegram runtime startup

### Phase 2: Internal isolated-task routing

- [x] Define task classes suitable for native API routing:
  - intent classification
  - normalization
  - small verification
  - side reasoning
- [x] Define how internal callers opt into native API without changing the main
  user-visible thread flow
- [x] Ensure native API calls do not pollute the active bridge session history
- [x] Define the in-process direct-native fallback path when the localhost API
  surface is unavailable
- [x] Prove that helper-task routing can use native API without polluting the
  active bridge session history

### Phase 3: Chat compatibility

- [x] Expose `POST /v1/chat/completions`
  - `src/providers/codex/native_api_server.ts` now exposes a compatibility
    wrapper over the same native isolated execution substrate used by
    `POST /v1/responses`
  - the first slice supports non-streaming and `stream: true` SSE output
- [x] Define how tool calling should map, if supported
  - decision: keep request-side tool declarations unsupported in the first
    compatibility slice instead of inventing partial tool-execution semantics
  - request bodies with `tools`, `tool_choice` (except `none`), or
    `parallel_tool_calls` now fail fast with
    `unsupported_chat_completions_feature`
  - prior assistant `tool_calls` and `tool` / `function` messages may still be
    rendered into the native prompt as compatibility history
- [x] Decide which features intentionally stay Responses-only
  - first compatibility slice is intentionally `n=1`, text-only, and
    single-response
  - structured output modes via `response_format` remain Responses-only for now
  - continuation registry semantics remain a Responses-first concern; chat
    clients continue by resending message history instead of reusing
    `previous_response_id`

### Phase 4: Hardening

- [x] Add a request-scoped localhost health/debug endpoint:
  - `GET /v1/health`
  - returns current native-runtime readiness, account identity, continuation
    registry durability, and route capability flags without requiring a server
    restart after reconnect/account switches
- [x] Add streaming Responses output once the native runtime exposes a stable
  server-facing stream contract for localhost callers
  - landed via native-runtime `onTurnStarted` / `onProgress` forwarding plus
    SSE `stream: true` support in `src/providers/codex/native_api_server.ts`
- [x] Keep expanding regression coverage for:
  - continuation mapping
  - streaming event ordering
  - local auth / localhost-only assumptions
  - restart/reconnect behavior when app-server is restarted
  - current focused coverage lives in:
    - `test/providers/codex/native_api_server.test.ts`
    - `test/providers/codex/native_api_service.test.ts`
    - `test/providers/codex/native_api_continuation_registry.test.ts`
  - the current restart/reconnect slice proves that the same localhost
    service can move from `native_runtime_unavailable` back to healthy request
    execution once the underlying Codex runtime becomes reachable again
- [x] Revisit whether persisted continuation recovery is worth the added state
  surface once restart semantics, observability, and extraction boundaries are
  otherwise stable
  - decision: **do not add persisted continuation recovery in the current
    Codex-only closure**
  - rationale:
    - the current product target is a localhost Codex-subscription facade, not
      a multi-consumer durable orchestration layer
    - restart semantics are now explicit and tested:
      service restart drops in-process continuation state and callers receive
      `continuation_not_found`
    - observability now exposes enough routing/mapping data to debug broken
      continuation chains without inventing a second persistence surface
    - package-extraction boundaries are not stable enough yet to justify
      durable continuation storage, schema migration, or cross-process replay
  - reopen only if:
    - a second real consumer requires restart-stable continuation chains, or
    - package extraction hardens into a reusable multi-process runtime
- [x] Add observability for:
  - request routing target
  - response mapping
  - continuation/session linkage
  - landed via `native_api` metadata returned from `src/providers/codex/native_api_server.ts`
    across `/v1/health`, `/v1/models`, `/v1/responses`, and `/v1/chat/completions`
  - current envelope exposes:
    - `route_path`
    - `request_target`
    - `response_mapping`
    - `continuation`

### Phase 5: Package extraction readiness

- [x] Confirm that the internal runtime/module boundary no longer depends on
  bridge-specific UX behavior
  - landed by moving the native-api helper sublayer onto provider-local types in:
    - `src/providers/codex/native_runtime.ts`
    - `src/providers/codex/native_api_continuation_registry.ts`
    - `src/providers/codex/native_api_side_task_router.ts`
  - and by updating `src/types/provider.ts` so `ProviderPluginContract` no
    longer uses `BridgeSession` / `SessionSettings` / `InboundTextEvent` or
    bridge-owned artifact-delivery type shapes directly
  - remaining Phase 5 work is now package topology and public API definition,
    not bridge-owned type leakage in the native-api sublayer
- [x] Decide whether a single `packages/codex-native-api` package is enough or
  whether runtime/server should split
  - current decision:
    - start extraction as a single `packages/codex-native-api` package
    - keep `runtime/server/router/continuation-registry` together during the
      first extraction because they still share one lifecycle, one auth surface,
      one localhost contract, and one Codex-only closure target
    - revisit a runtime/server split only if a later consumer needs the native
      runtime substrate without the localhost HTTP shell
- [x] Define the minimal public API surface for package consumers
  - current first-extraction target surface:
    - `CodexNativeRuntime`
    - `CodexNativeApiServer`
    - `CodexNativeApiService`
    - `InMemoryCodexNativeApiContinuationRegistry`
    - native-api option/context/registry interfaces needed to host the service
      without bridge-specific imports
  - explicitly keep out of the first public surface:
    - bridge command routing
    - WeChat delivery/runtime types
    - provider profile loading helpers that are only meaningful inside the
      CodexBridge monorepo bootstrap path
- [x] Ensure localhost server startup can work without requiring WeChat/Telegram
  bridge runtime
  - landed early via `src/providers/codex/native_api_service.ts` plus the
    `codex native-api-serve` CLI entrypoint
- [x] Add package-level tests and exports once extraction begins
  - extraction has now started with:
    - `packages/codex-native-api/package.json`
    - `packages/codex-native-api/tsconfig.json`
    - `packages/codex-native-api/src/index.ts`
    - `packages/codex-native-api/test/package_exports.test.ts`
  - root native-api entry files under `src/providers/codex/native_*` now act as
    re-export shims into the package source during the first extraction phase
  - the package boundary is now guarded by:
    - `scripts/check-codex-native-api-boundary.mjs`
    - `pnpm codex-native-api:check-boundary`

## Suggested Phase 1 Deliverable

Phase 1 should be considered complete when all of the following are true:

- localhost `GET /v1/models` works against logged-in Codex runtime state
- localhost `POST /v1/responses` can create isolated runs
- `previous_response_id` can resume through the continuation registry
- the API path reuses the same proven local isolated execution primitive rather
  than inventing a second execution engine
- the main WeChat chat flow remains on the current direct app-server path
- no external provider API key is required for this path
- streaming may remain unsupported in the minimal Phase 1 shell, but any later
  support must sit on a stable native-runtime stream contract rather than ad
  hoc polling or a second execution engine

## Completion Criteria

- [x] Codex Native API can expose logged-in Codex as a localhost Responses API
- [x] Main WeChat chat flow remains unchanged
- [x] Internal isolated tasks can prefer native API without polluting the main
  thread
- [x] Direct local native fallback exists beneath the API layer before any
  external-provider fallback is used
- [x] External provider fallback remains optional and clearly secondary
- [x] The docs clearly distinguish native API from `codex-gateway`
- [x] The design stays compatible with later extraction into a reusable
  workspace package and eventual standalone npm package if the boundary proves
  stable
