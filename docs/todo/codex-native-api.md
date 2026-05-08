# Codex Native API TODO

This document tracks the implementation backlog for the `track/codex-native-api`
workstream.

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

## Track Branch

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
- [ ] Support streaming Responses output
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

- [ ] Expose `POST /v1/chat/completions`
- [ ] Define how tool calling should map, if supported
- [ ] Decide which features intentionally stay Responses-only

### Phase 4: Hardening

- [ ] Add regression coverage for:
  - continuation mapping
  - streaming event ordering
  - local auth / localhost-only assumptions
  - restart/reconnect behavior when app-server is restarted
- [ ] Revisit whether persisted continuation recovery is worth the added state
  surface once restart semantics, observability, and extraction boundaries are
  otherwise stable
- [ ] Add observability for:
  - request routing target
  - response mapping
  - continuation/session linkage

### Phase 5: Package extraction readiness

- [ ] Confirm that the internal runtime/module boundary no longer depends on
  bridge-specific UX behavior
- [ ] Decide whether a single `packages/codex-native-api` package is enough or
  whether runtime/server should split
- [ ] Define the minimal public API surface for package consumers
- [x] Ensure localhost server startup can work without requiring WeChat/Telegram
  bridge runtime
  - landed early via `src/providers/codex/native_api_service.ts` plus the
    `codex native-api-serve` CLI entrypoint
- [ ] Add package-level tests and exports once extraction begins

## Suggested Phase 1 Deliverable

Phase 1 should be considered complete when all of the following are true:

- localhost `GET /v1/models` works against logged-in Codex runtime state
- localhost `POST /v1/responses` can create isolated runs
- streaming works for those isolated runs
- `previous_response_id` can resume through the continuation registry
- the API path reuses the same proven local isolated execution primitive rather
  than inventing a second execution engine
- the main WeChat chat flow remains on the current direct app-server path
- no external provider API key is required for this path

## Completion Criteria

- [ ] Codex Native API can expose logged-in Codex as a localhost Responses API
- [ ] Main WeChat chat flow remains unchanged
- [ ] Internal isolated tasks can prefer native API without polluting the main
  thread
- [ ] Direct local native fallback exists beneath the API layer before any
  external-provider fallback is used
- [ ] External provider fallback remains optional and clearly secondary
- [ ] The docs clearly distinguish native API from `codex-gateway`
- [ ] The design stays compatible with later extraction into a reusable
  workspace package and eventual standalone npm package if the boundary proves
  stable
