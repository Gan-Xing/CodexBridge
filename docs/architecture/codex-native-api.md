# Codex Native API Architecture

## Goal

Codex Native API is the local API facade over the already logged-in Codex
app-server runtime.

Its job is to convert **local Codex subscription/login state** into a
localhost-callable API without changing the main CodexBridge WeChat flow.

This is not a replacement for the current bridge path.
It is an **additional isolated execution surface**.

Immutable workstream target:

> Keep the primary CodexBridge chat flow on the current Codex app-server path,
> while exposing a localhost Responses-first API over logged-in Codex for
> isolated side tasks and optional local consumers.

Longer-term product direction:

> The first implementation may live inside CodexBridge runtime, but the
> capability should eventually be extractable into a reusable package that can
> expose logged-in local Codex as a standalone localhost API without requiring
> the full CodexBridge bridge stack.

## Product Meaning

This workstream solves two related product problems:

1. `subscription -> local API`
   - reuse the host's existing Codex subscription/login state
   - expose it as a local API surface
2. `main thread cleanliness`
   - run lightweight side tasks off-thread
   - avoid polluting the active CodexBridge conversation history

This is best described as:

```text
localhost API facade over logged-in Codex
```

It should not be described as "minting a real OpenAI API key".

## Current Closure Policy

The current implementation already contains some provider-selectable localhost
API seams because it reused the existing CodexBridge provider-profile and
provider-plugin infrastructure.

That generalized shape is not the current closure target.

For the current closure phase, the intended product target should be read as:

```text
openai-default / logged-in Codex app-server -> localhost API
```

Meaning:

- current closure work should focus on the logged-in Codex subscription path
- current closure work should not keep expanding Qwen / MiniMax / DeepSeek
  specific localhost-native behavior
- existing generalized hooks may remain in the codebase temporarily, but they
  are frozen implementation seams, not the active product goal
- if a true provider-selectable local API is still wanted later, it should
  return as a separate explicit expansion step instead of silently redefining
  the meaning of "Codex Native API"

In short:

- do not delete the generalized seams yet
- do not keep expanding them during current closure
- finish Codex subscription -> localhost API first

## Minimal Operational Shape

For the current closure phase, the minimum supported localhost service shape is:

- host: `127.0.0.1`
- port: `43182` by default
- auth: optional bearer token via `CODEX_NATIVE_API_AUTH_TOKEN`
- default backend target: `openai-default` / logged-in Codex app-server

Recommended env block. The embedded `weixin serve` path enables this service by
default; keep `CODEX_NATIVE_API_ENABLE=1` in service env files for explicitness,
or set it to `0` to disable the embedded API surface.

```env
CODEX_NATIVE_API_ENABLE=1
CODEX_NATIVE_API_HOST=127.0.0.1
CODEX_NATIVE_API_PORT=43182
CODEX_NATIVE_API_AUTH_TOKEN=replace-with-a-long-random-secret
CODEX_NATIVE_API_DEFAULT_MODEL=gpt-5.4
```

Minimal startup commands:

```bash
pnpm exec tsx src/cli.ts codex native-api-serve
```

```bash
pnpm exec tsx src/cli.ts weixin serve
```

Minimal health checks:

```bash
curl -H "Authorization: Bearer $CODEX_NATIVE_API_AUTH_TOKEN" \
  http://127.0.0.1:43182/v1/health
```

```bash
curl -H "Authorization: Bearer $CODEX_NATIVE_API_AUTH_TOKEN" \
  http://127.0.0.1:43182/v1/models
```

## Packaging Direction

The target capability is independent enough that it should eventually be able
to stand on its own.

The recommended evolution is:

### Stage A: Internal runtime/module

First, implement the capability inside CodexBridge near the existing native
Codex runtime integration.

Reason:

- the runtime boundary is still being discovered
- continuation mapping and helper-thread reuse are still unstable
- extracting too early would freeze the wrong API

Current internal shape:

- `src/providers/codex/native_runtime.ts` owns active-account lookup, readiness
  probing, reconnect/refresh orchestration, isolated
  ephemeral-thread/session creation, and default read-only side-task turn
  settings
- current internal helper paths in `src/core/bridge_coordinator.ts` should call
  this substrate instead of re-implementing `startThread({ ephemeral: true })`
  + `startTurn()` ad hoc
- `src/providers/codex/native_api_continuation_registry.ts` owns the first
  in-process `response_id -> isolated native session` mapping, TTL bookkeeping,
  sticky provider/account affinity checks for `previous_response_id`
  continuations, and the explicit Phase 3 contract that default continuation
  state is process-local and does not survive a native-api service restart
- `src/providers/codex/native_api_side_task_router.ts` owns the first internal
  helper-facing routing policy for side-task classes; it prefers localhost
  `Responses` calls when bridge-local native-api routing is explicitly enabled,
  preserves helper-turn metadata across the API hop, and falls back to direct
  native isolated execution when the localhost facade is unavailable
- `src/providers/codex/native_api_server.ts` is the first in-process localhost
  shell over that substrate; it resolves provider/runtime context per request
  so reconnect/account-switch changes do not require a server restart
- `src/providers/codex/native_api_service.ts` owns standalone lifecycle,
  provider-profile selection, and auth-path binding for long-running localhost
  startup paths such as the native-api CLI service

### Stage B: Internal workspace package

Once the runtime, continuation registry, and localhost API contract are stable,
extract them into a dedicated workspace package, likely shaped as:

```text
packages/codex-native-api
```

Reason:

- CodexBridge can keep consuming the package
- the boundary becomes testable and reusable
- the feature no longer has to remain buried inside bridge-specific files

Current extraction decision:

- the first extraction should remain a **single**
  `packages/codex-native-api` package
- do **not** split runtime/server yet
- the first extraction has now started in-place:
  - `packages/codex-native-api/src/` holds the initial extracted module bodies
  - `src/providers/codex/native_*` acts as the current compatibility shim layer
    back into the package source

Why this is the current decision:

- `native_runtime`, `native_api_server`, `native_api_service`,
  `native_api_side_task_router`, and the continuation registry still share one
  localhost contract and one Codex-only closure target
- they also still share one lifecycle and one auth/config surface
- splitting too early would freeze an artificial boundary before a second real
  consumer proves that the runtime substrate is useful without the HTTP shell

Optional later split if needed:

```text
packages/codex-native-runtime
packages/codex-native-api
```

Only revisit that split if:

- another consumer needs the native runtime substrate directly without the
  localhost API shell, or
- package extraction shows a stable server-free runtime API that no longer
  depends on the current localhost contract assumptions

### Stage C: Standalone npm package / separate repository if justified

If the API surface proves stable and other consumers exist, the package should
be publishable independently so users can:

- install the native-api package without installing full CodexBridge bridge UX
- expose logged-in local Codex as localhost API for their own tools
- reuse the subscription-to-API capability outside WeChat/Telegram bridging

This is a direction, not a Phase 1 requirement.

## Final Goal Statement

Use this as the single stable sentence for the workstream goal:

> Codex Native API 的目标是把已登录本地 Codex app-server 的订阅能力封装成 localhost 可调用的标准 API，并优先承接 CodexBridge 的隔离型副任务，同时保持主聊天链路不变。

## Core Execution Model

The system should have three distinct execution lanes:

### Lane A: Main conversation lane

- current CodexBridge flow
- direct Codex app-server integration
- full thread continuity
- unchanged WeChat-facing behavior

### Lane B: Isolated side-task lane

- Codex Native API
- localhost-callable
- explicit side-task routing
- separate continuation IDs and runtime bookkeeping
- no contamination of the active bridge thread unless a caller intentionally
  merges results back

Important clarification:

- the native API is the **preferred interface**
- the underlying native execution primitive may still be an isolated ephemeral
  Codex thread
- the API should wrap that primitive, not replace it with an unrelated engine
- `previous_response_id` continuation must stay pinned to the original native
  provider/account identity; if that affinity breaks, the localhost API should
  fail loudly instead of silently rehoming the chain

### Lane C: External fallback lane

- `@codexbridge/codex-gateway`
- only used when:
  - native API is unavailable
  - native API is disabled
  - an explicit provider override is requested
  - cost/speed/capability policy says fallback is preferable

The key rule is:

- **main conversation stays on the direct app-server path**
- **isolated side tasks prefer Codex Native API**
- **external providers are fallback, not primary**

Recommended degraded route order:

1. `Codex Native API`
2. direct native isolated ephemeral-thread execution
3. external provider fallback via `@codexbridge/codex-gateway`

Current closure interpretation:

- for this workstream, `Codex Native API` should be read first as the
  `openai-default` / logged-in Codex path
- any generalized provider-selectable localhost routing that already exists is
  frozen and secondary until the Codex-only path is fully closed

## Current Internal Consumption Boundary

For the current closure phase, internal helper consumption should follow these
rules:

### Prefer localhost native API

Only when all of the following are true:

- bridge-local native API routing is enabled
- the task class is eligible
- the bound provider profile is `openai-native` / `openai-default`

First helper lanes already routed through that boundary:

- command-skill parsing
- review result localization
- agent result verification

User-facing provider selection stays unchanged:

- users keep `/pd openai-default`
- the localhost native API is an internal execution surface behind that
  provider, not a separate `/provider` option
- do not introduce a user-facing `/pd codex-native-local` style profile for
  the current closure phase

### Stay on direct native execution

When any of the following are true:

- localhost native API routing is disabled
- localhost native API is unreachable or unhealthy
- the task class is not enabled for localhost routing

### Stay off the current native localhost path

For the current closure phase:

- Qwen / MiniMax / DeepSeek and other non-native provider profiles should not
  start using the localhost native API path
- the main WeChat chat lane should remain on the existing direct app-server
  conversation path

## Non-Goals for Phase 1

First phases should **not** try to solve all of these at once:

- no public internet-exposed gateway by default
- no billing or payment platform
- no replacement of CodexBridge main chat orchestration
- no mandatory Chat Completions surface in Phase 1
- no bridge-side preview/final delivery changes
- no attempt to emulate a real cloud OpenAI API key
- no `codex-gateway` / external-provider responsibility mixing

## Why This Is Separate From Codex Gateway

`codex-gateway` and `codex-native-api` are related, but they are not the same
workstream.

### `@codexbridge/codex-gateway`

- adapts external model providers for Codex
- primarily solves `outside model -> Codex-compatible protocol`

### `codex-native-api`

- exposes Codex itself as a localhost API
- primarily solves `logged-in Codex runtime -> API surface`

One sentence split:

- `codex-gateway` brings outside models in
- `codex-native-api` exposes native Codex out

## Reference Interpretation

These references matter, but they should shape architecture, not dictate it.

### Sub2API

Use as the reference for:

- subscription-backed API product shape
- account/session separation
- service packaging and operational expectations
- stable mapping between upstream subscription state and downstream API clients

Do not copy:

- payment, top-up, marketplace, or heavy SaaS control-plane scope
- multi-tenant commercial product requirements

Upstream:

- <https://github.com/Wei-Shaw/sub2api>

### CLIProxyAPI

Use as the reference for:

- protocol compatibility breadth
- config-driven compatibility rules
- localhost/server deployment ergonomics
- routing/session affinity/fallback thinking
- clear separation between host-side auth state and downstream API surface

Do not copy:

- every protocol and provider at once in Phase 1
- full multi-provider control plane for the native-only starting scope

Upstream:

- <https://github.com/router-for-me/CLIProxyAPI>
- <https://help.router-for.me/>

## Reference Extraction Blueprint

The native-api workstream should not "vendor the whole project" from either
reference. It should selectively absorb the parts that match the CodexBridge
goal.

### What to absorb from Sub2API

Primary value:

- upstream subscription/account state separated from downstream API consumers
- stable account/session identity
- sticky account affinity for continuation chains
- operational thinking for "subscription as service capability"

Do not absorb:

- payment and recharge systems
- multi-tenant SaaS control plane
- heavy database-first platform assumptions for the localhost-first first phase

### What to absorb from CLIProxyAPI

Primary value:

- localhost-first API facade shape
- Responses-first and compatibility-first protocol surface
- config/default/filter/override style request adaptation
- session affinity and routing policy
- local API auth surface distinct from upstream logged-in auth state

Do not absorb:

- protocol sprawl in the first native-only phase
- provider matrix complexity that belongs to `codex-gateway`
- product/UI/operations scope unrelated to local Codex-native execution

## Ordered Implementation Sequence

The recommended implementation order is:

### 1. Stabilize the native subscription runtime layer

Borrow mainly from:

- Sub2API account/session separation
- CLIProxyAPI auth-state vs downstream-client split

Build:

- one internal native runtime service over the logged-in Codex app-server
- active account lookup
- account switch hooks
- "ensure native runtime ready" checks
- one isolated execution entrypoint for side-task runs

Outcome:

- CodexBridge gets one stable native execution substrate before any localhost
  API is exposed

### 2. Wrap the runtime with a localhost Responses API shell

Borrow mainly from:

- CLIProxyAPI localhost service shape
- CLIProxyAPI downstream local API credential pattern

Build:

- localhost-only HTTP server
- `GET /v1/models`
- `POST /v1/responses`
- keep `POST /v1/responses/compact` explicitly unsupported until later
  compatibility/hardening work
- minimal local secret/shared-key policy if needed

First shell constraints:

- bind `127.0.0.1` by default
- resolve provider profile / plugin / auth context per request
- reuse `CodexNativeRuntime.runIsolatedTurn()` for actual execution
- reject `previous_response_id` until the continuation registry exists instead
  of inventing a fake continuation path early
- allow streaming to remain explicitly unsupported until a later hardening pass
  adds SSE over the native runtime's `onTurnStarted` / `onProgress` contract
- keep long-running localhost startup independently launchable from WeChat or
  Telegram bridge runtime so the API shell can act as a standalone local
  service before any package extraction

Outcome:

- logged-in Codex becomes a localhost-callable Responses-first API without
  changing the main bridge flow

### 3. Add continuation registry and sticky execution mapping

Borrow mainly from:

- Sub2API sticky account/session affinity
- CLIProxyAPI session affinity and routing continuity

Build:

- `response_id -> native execution/thread identity`
- `previous_response_id -> continuation lookup`
- account/runtime affinity for isolated chains
- continuation expiry and bookkeeping rules
- explicit process-lifetime durability for the first registry, with persisted
  recovery deferred until later hardening work if justified

Outcome:

- API callers get stateless-looking requests with stable native continuation
  underneath during one running native-api service lifetime

### 4. Route isolated internal side tasks into the native API lane

Borrow mainly from:

- CLIProxyAPI routing/fallback policy
- existing CodexBridge helper-thread execution pattern

Build:

- internal task classes that opt into native API
- direct local native fallback when API facade is unavailable
- external-provider fallback only after native routes fail or are explicitly
  overridden

Outcome:

- slash-command judgments and similar helper tasks stop depending on external
  provider APIs by default

### 5. Add compatibility and hardening

Borrow mainly from:

- CLIProxyAPI compatibility/routing ergonomics
- Sub2API operational stability mindset

Build:

- request-scoped `GET /v1/health` over readiness/account/continuation-registry
  state for local debugging and liveness checks
- streaming hardening over the native runtime's `onTurnStarted` /
  `onProgress` contract instead of thread-history polling
- trace/debug/health endpoints or equivalents
- restart/recovery behavior
- optional `Chat Completions` compatibility
- controlled external fallback policy

Outcome:

- the native API becomes a reusable, debuggable, long-running local service
  rather than a one-off adapter

## Recommended First Architecture

The best first implementation is **not** a separate npm-style package like
`codex-gateway`.

Phase 1 should start as an **internal CodexBridge runtime/module** because it
must stay close to:

- the logged-in Codex app-server process
- native thread/turn continuation state
- existing `src/providers/codex/**` runtime wiring

Recommended dependency shape:

```text
WeChat / Telegram / internal helpers / local tools
  -> Codex Native API facade
  -> native isolated execution layer
  -> Codex app-server client/runtime
  -> logged-in Codex subscription
```

Recommended code-boundary direction:

```text
CodexBridge runtime
  -> native-api module
  -> src/providers/codex/app_client.ts
  -> codex app-server
```

Not:

```text
Codex Native API
  -> external provider gateway
  -> codex-gateway
```

unless Phase 3+ explicitly introduces fallback wiring.

This is a sequencing decision, not the final product boundary.
The long-term direction remains:

- first: internal runtime/module
- then: reusable workspace package
- later if justified: standalone npm package

## Runtime Components

Recommended first component split:

### 1. Native API server

Owns:

- localhost HTTP routing
- request parsing
- streaming response emission
- request-scoped health/debug response emission
- auth/binding policy for the local surface

### 2. Native API router/classifier

Owns:

- deciding whether a call is:
  - a fresh isolated run
  - a continuation
  - a fallback request
- explicit mapping from internal helper task type to native API eligibility
- one shared bridge-local opt-in point for localhost routing instead of ad hoc
  fetch logic at each helper call site

### 3. Native isolated execution layer

Owns:

- creating isolated native Codex runs without polluting the active bridge
  thread
- reusing the same underlying execution primitive already proven by current
  command-skill / helper-thread flows
- acting as the direct local fallback when the localhost API surface is
  unavailable but native Codex is still healthy

### 4. Continuation registry

Owns:

- `response_id`
- `previous_response_id`
- `codex_thread_id`
- optional `codex_turn_id`
- `active_account_id`
- `route_kind`
- `started_at` / `last_used_at`
- `expiry_at`
- model/provider/runtime metadata needed to resume or audit a side-task chain

Phase 3 durability decision:

- the first registry is intentionally in-memory and process-local
- restarting the localhost native-api service invalidates outstanding
  `previous_response_id` chains
- persisted recovery is a later hardening/extraction concern, not part of the
  first localhost shell contract

### 5. Codex app-server bridge

Owns:

- invoking the logged-in Codex runtime
- converting between API-facing request semantics and native thread/turn
  semantics
- staying aligned with real Codex capabilities instead of inventing fake cloud
  behavior

### 6. Optional compatibility layer

Later-only layer for:

- `POST /v1/chat/completions`
- possible future `/responses/compact`
- future tool-call compatibility normalization

This layer should sit **above** the native Responses-first surface, not replace
it.

## API Facade vs Native Primitive

Codex Native API should be implemented as a **façade over the existing native
isolated execution capability**, not as a brand-new reasoning engine.

In practice that means:

- today's direct helper-thread path is the short-term stability anchor
- tomorrow's localhost API should call into that same native isolated execution
  capability
- if the API server layer is temporarily unavailable, callers should be able to
  fall back to direct native isolated execution before reaching for an external
  provider

This keeps the system aligned with the most stable local primitive while still
gaining the benefits of a standard API surface.

## Recommended API Strategy

### Responses-first

The first real API surface should be:

- `GET /v1/models`
- `POST /v1/responses`
- optional `POST /v1/responses/compact`

Reason:

- Codex-native behavior already aligns more closely with `Responses`
- it avoids forcing a Chat-Completions-shaped abstraction too early
- it stays closer to current Codex app-server semantics and future tool surfaces

### Chat later

`POST /v1/chat/completions` should be treated as a compatibility layer added
after the Responses-first surface is stable.

First landed compatibility slice:

- it wraps the same native isolated execution substrate used by
  `POST /v1/responses`
- it supports single-choice text generation plus optional SSE streaming
- it renders prior `system` / `developer` / `user` / `assistant` / `tool`
  history into the native prompt instead of inventing a second continuation
  mechanism
- it intentionally keeps request-side tool declarations, parallel tool-calling,
  and non-text output modes out of scope until a later compatibility pass

## Continuation and State Model

External clients think in API request/response IDs.
Codex app-server thinks more naturally in thread/turn continuation.

So the native API needs an internal mapping layer:

```text
response_id
  -> native_api_run_id
  -> codex_thread_id
  -> optional codex_turn_id
  -> continuation metadata
```

Suggested logical record shape:

```text
native_api_run
  id
  response_id
  previous_response_id
  codex_thread_id
  codex_turn_id?
  route_kind
  model
  created_at
  updated_at
```

This mapping layer is the key to making isolated API calls feel stateless to
clients while still reusing Codex-native conversation continuity underneath.

## Internal Routing Policy

This workstream exists partly so CodexBridge itself can use the local API for
side work without dirtying the main thread.

Recommended task classes:

- `conversation_main`
  - always stay on direct app-server path
- `ephemeral_reasoning`
  - prefer native API
- `classification`
  - prefer native API
- `normalization`
  - prefer native API
- `verification`
  - prefer native API
- `provider_fallback`
  - use external provider only when native path is unavailable or explicitly
    overridden

This routing policy should be explicit in code later, not hidden in ad hoc
conditionals.

## Fallback Strategy

The fallback hierarchy should be:

### 1. Preferred path

- `Codex Native API`
- used by internal helpers and optional local clients

### 2. Local direct fallback

- direct native isolated execution without going through the localhost HTTP
  surface
- used when:
  - the API layer is down
  - the API layer is disabled
  - local native Codex is healthy and the caller can still use in-process
    routing

### 3. External provider fallback

- `@codexbridge/codex-gateway`
- used only when:
  - native Codex is unavailable
  - native Codex is unhealthy
  - an explicit provider override says to leave the native path

This is important because:

- the short-term most stable primitive is the existing native isolated thread
  capability
- the long-term most reusable interface is the localhost API surface
- external providers should remain secondary for these isolated subtask flows

## Security Model

Phase 1 should default to:

- bind `127.0.0.1`
- no remote exposure by default
- explicit opt-in for any non-local access

If local auth is needed, use a simple local secret or token layer.
Do not frame this as a cloud API key product.

Also note:

- native API calls and main bridge turns still share the same underlying Codex
  subscription pool
- the native API is about isolation and compatibility, not "free extra quota"

## Ownership

Codex Native API should own:

- local route handling
- continuation mapping
- native API request classification
- request/response/stream adaptation around the Codex app-server
- native-api-specific auth/binding policy

It should not own:

- WeChat transport
- session binding UX
- slash-command product behavior
- artifact delivery policy
- external provider compatibility rules already owned by `codex-gateway`

## Recommended Phase Order

### Phase 0: Architecture lock

- lock routing priority
- lock ownership/non-ownership
- lock internal-module-first implementation choice

### Phase 1: Minimal localhost Responses API

- `GET /v1/models`
- `POST /v1/responses`
- localhost-only binding
- optional local bearer/shared-secret auth
- reuse the existing isolated native execution primitive
- request-scoped runtime context resolution
- explicit non-support for streaming and `previous_response_id` until later
  phases

### Phase 2: Internal isolated-task routing

- explicit task-class routing
- helper/runtime call sites
- no main-thread contamination
- local direct fallback remains available when the API layer is unavailable

### Phase 3: Continuation and sticky execution mapping

- `response_id -> native thread/turn identity`
- `previous_response_id -> continuation lookup`
- runtime/account affinity
- expiry and bookkeeping

### Phase 4: Compatibility layer

- `POST /v1/chat/completions`
- selective compatibility support
- optional fallback hooks

### Phase 5: Hardening

- observability
- restart/reconnect behavior
- local auth hardening
- fixture/regression coverage
- optional external local-client consumers

Current response-level observability is now carried in a dedicated `native_api`
envelope on health, models, responses, and chat-completions payloads. The
current machine-readable fields are:

- `route_path`
- `request_target`
- `response_mapping`
- `continuation`

The current hardening baseline also covers:

- continuation mapping
- streaming event ordering
- localhost bearer auth / localhost-only assumptions
- runtime recovery after a temporary Codex app-server outage

## Current Persistence Decision

Persisted continuation recovery is **not** part of the current Codex-only
closure target.

The current service shape is intentionally process-local:

- the default continuation registry remains in-memory
- service restart may invalidate outstanding continuation chains
- callers receive `continuation_not_found` instead of silent re-homing or fake
  replay

That trade-off is still preferred for the current phase because:

- the target product is a localhost Codex-subscription facade, not a durable
  multi-consumer runtime
- restart semantics and failure visibility are now explicit and tested
- response-level observability already exposes enough routing/mapping metadata
  to debug broken continuation chains
- durable continuation storage would add schema/state migration work before the
  extraction boundary is stable

This decision should only be reopened if a second real consumer needs
restart-stable continuations, or if package extraction hardens into a reusable
multi-process runtime surface.

## Current Extraction Boundary Status

The native-api sublayer has now reduced its direct bridge-UX type coupling:

- `src/providers/codex/native_runtime.ts`
- `src/providers/codex/native_api_continuation_registry.ts`
- `src/providers/codex/native_api_side_task_router.ts`

use provider-local native-api types instead of importing `BridgeSession`,
`SessionSettings`, or `InboundTextEvent` directly from the bridge
core/platform modules.

The shared provider contract has now been moved onto provider-owned turn,
session, event, and artifact-delivery shapes as well, so
`src/types/provider.ts` no longer leaks bridge-owned `core/platform` types into
the native-api helper boundary.

That means the remaining extraction work is no longer about bridge-owned type
leakage. It is now about package topology and public API design:

- the first extraction should remain a single
  `packages/codex-native-api` package
- and the first public surface should stay intentionally small:
  - `CodexNativeRuntime`
  - `CodexNativeApiServer`
  - `CodexNativeApiService`
  - `InMemoryCodexNativeApiContinuationRegistry`
  - supporting native-api option/context/registry interfaces that do not pull
    bridge-owned runtime or WeChat types back across the boundary

The first extraction also now has package-level exports/tests in place:

- `packages/codex-native-api/src/index.ts`
- `packages/codex-native-api/package.json`
- `packages/codex-native-api/test/package_exports.test.ts`

The first package boundary guard is also in place:

- `scripts/check-codex-native-api-boundary.mjs`
- `pnpm codex-native-api:check-boundary`
