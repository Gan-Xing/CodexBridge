# CodexBridge TypeScript Migration TODO

This document tracks a gradual migration plan from JavaScript to TypeScript for `CodexBridge`.

## Current Snapshot

As of `2026-04-18`, the migration is complete:

- `0` source and test files use `.js`
- `52` source and test files use `.ts` or `.tsx`
- `tsconfig.json` and `tsconfig.checkjs.json` are in place
- runtime scripts execute TypeScript entrypoints directly with `tsx`
- `npm run typecheck`, `npm run typecheck:js`, and `npm test` all pass

The repository is now TypeScript-first.

## Migration Goal

Move `CodexBridge` to a TypeScript-first codebase without a risky full rewrite.

Target end state:

- new code is written in TypeScript by default
- core contracts and state objects are explicitly typed
- provider and platform capability boundaries are checked by the compiler
- the runtime still stays operational during the migration

## Non-Goals

- do not rewrite the whole repository in one pass
- do not block WeChat bridge fixes or operational work on a large refactor branch
- do not add a heavy bundler unless TypeScript compilation alone stops being enough

## Why TS Is Worth It Here

The highest-risk parts of `CodexBridge` are shape-heavy integration boundaries:

- platform inbound and outbound event payloads
- provider plugin contracts and optional capabilities
- bridge session, thread, and active-turn state
- command parsing results and `response.meta`
- repository persistence records

These are exactly the places where TypeScript pays off.

## Recommended Strategy

Use a staged migration instead of a full conversion.

1. Add TypeScript tooling first.
2. Turn on type-checking for existing JavaScript.
3. Define core shared types and contracts.
4. Migrate high-value core files first.
5. Migrate runtime and provider boundaries next.
6. Migrate platform and storage layers last.

## Type Placement Strategy

Do not put every type in one giant shared folder.

Recommended structure:

- keep a small `src/types/` directory for cross-module shared types only
- keep domain-specific types next to the domain that owns them
- keep file-local helper types inside the file that uses them

Recommended layout:

```text
src/
  types/
    core.ts
    platform.ts
    provider.ts
    repository.ts
    command.ts
  core/
    contracts.ts
  platforms/
    weixin/
      types.ts
  providers/
    codex/
      types.ts
```

Rules:

- `src/types/` should contain only types reused across directories
- `src/platforms/*/types.ts` should contain platform-specific payload and transport types
- `src/providers/*/types.ts` should contain provider-specific client and result types
- if a type is used by only one file, keep it in that file instead of extracting it

Why this is the best fit for `CodexBridge`:

- the repository is a bridge with multiple boundaries, not one monolithic domain model
- `core`, `runtime`, `platforms`, `providers`, and `store` each own different shapes
- forcing all types into one folder would make discovery worse and increase cross-module coupling

Concrete ownership plan:

- `src/types/core.ts`
  - `PlatformScopeRef`
  - `BridgeSession`
  - `SessionSettings`
  - `ThreadMetadata`
- `src/types/platform.ts`
  - `InboundTextEvent`
  - outbound delivery request types
  - platform plugin interfaces
- `src/types/provider.ts`
  - `ProviderProfile`
  - `ProviderThreadSummary`
  - `ProviderThreadTurn`
  - provider plugin interfaces
- `src/types/repository.ts`
  - repository contract shapes
  - persisted record interfaces
- `src/types/command.ts`
  - slash command parse result
  - command help spec
  - thread browser state
- `src/platforms/weixin/types.ts`
  - raw iLink payload shapes
  - Weixin delivery request payloads
- `src/providers/codex/types.ts`
  - Codex app client response payloads
  - model list items
  - turn start/read/list RPC result shapes

Migration rule:

- start by moving shared JSDoc contracts out of `src/core/contracts.js` into typed exports
- do not create a giant `src/types/index.ts`
- prefer narrow imports from specific type files

## Phase 1: Tooling Baseline

- [x] Add `typescript` and `tsx` as dev dependencies
- [x] Add `@types/node`
- [x] Add `tsconfig.json`
- [x] Add `npm run build`
- [x] Add `npm run typecheck`
- [x] Keep `npm test` working unchanged during this phase

Acceptance:

- [x] `npm run typecheck` executes successfully
- [x] `npm run weixin:serve` still works after the tooling is added

## Phase 2: JS Type Checking

- [x] Enable `allowJs`
- [x] Enable `checkJs` for the first shared-core wave via `tsconfig.checkjs.json`
- [x] Start with pragmatic strictness, not maximum strictness on day one
- [x] Add JSDoc typedefs only where they unlock real signal
- [x] Fix the first wave of contract mismatches surfaced by the compiler

Current first-wave scope:

- [x] `src/core/contracts.js`
- [x] `src/core/command_parser.js`
- [x] `src/core/errors.js`
- [x] `src/core/active_turn_registry.js`
- [x] `src/core/session_router.js`
- [x] `src/core/bridge_session_service.js`
- [x] `src/core/bridge_coordinator.js`
- [x] `src/runtime/plugin_registry.js`
- [x] `src/runtime/bootstrap.js`
- [x] `src/runtime/weixin_bridge_runtime.js`
- [x] `src/providers/codex/plugin.js`
- [x] `src/providers/codex/app_client.js`
- [x] `src/platforms/weixin/config.js`
- [x] `src/platforms/weixin/client.js`
- [x] `src/platforms/weixin/plugin.js`
- [x] `src/platforms/weixin/account_store.js`
- [x] `src/platforms/weixin/formatting.js`
- [x] `src/platforms/weixin/poller.js`
- [x] `src/platforms/telegram/plugin.js`
- [x] `src/providers/codex/config.js`
- [x] `src/providers/minimax/plugin.js`
- [x] `src/providers/openai_native/plugin.js`
- [x] `src/store/file_json/*`
- [x] `src/store/in_memory/*`
- [x] expand `checkJs` coverage to test files and their mock contracts

Recommended compiler posture for the first pass:

- `allowJs: true`
- `checkJs: false` in Phase 1, then switch to `true` in Phase 2
- `noEmit: true` for the typecheck command
- conservative strict flags can be enabled later in phases

Acceptance:

- [x] A first wave of existing JS files is included in TS analysis
- [x] Core command, runtime, and provider flows type-check cleanly enough to be useful

## Phase 3: Type Boundary Design

Before mass renaming files, define shared types for the main boundaries.

- [x] Extract platform event and reply types
- [x] Extract provider profile, provider capability, and provider plugin interfaces
- [x] Extract bridge session, session settings, and active-turn state types
- [x] Extract thread browser item and page-state types
- [x] Extract persistent repository record shapes

Initial shared type files created:

- [x] `src/types/core.ts`
- [x] `src/types/platform.ts`
- [x] `src/types/provider.ts`
- [x] `src/types/repository.ts`
- [x] `src/types/command.ts`

Priority files to stabilize first:

- [x] `src/core/contracts.ts`
- [x] `src/core/command_parser.ts`
- [x] `src/core/errors.ts`
- [x] `src/core/active_turn_registry.ts`
- [x] `src/core/bridge_session_service.ts`
- [x] `src/core/bridge_coordinator.ts`
- [x] `src/providers/codex/plugin.ts`
- [x] `src/providers/codex/app_client.ts`
- [x] `src/runtime/bootstrap.ts`
- [x] `src/runtime/plugin_registry.ts`
- [x] `src/runtime/weixin_bridge_runtime.ts`

Acceptance:

- [x] Shared boundary types exist and are reused across modules
- [x] Optional provider capabilities such as `interruptTurn` and `reconnectProfile` are typed consistently

## Phase 4: New Code Policy

- [x] Add transitional TS entrypoints so runtime scripts no longer depend on `node src/*.js`
- [x] All new files are added as `.ts` by default
- [x] Avoid introducing new `.js` files unless there is an operational reason
- [x] Keep migrations incremental and file-scoped

Acceptance:

- [x] Package scripts can execute TS entrypoints through `tsx`
- [x] New features stop increasing the JavaScript surface area

## Phase 5: Core Module Migration

Migrate the highest-value logic first.

- [x] Rename `src/core/contracts.js` to `src/core/contracts.ts`
- [x] Rename `src/core/command_parser.js` to `src/core/command_parser.ts`
- [x] Rename `src/core/active_turn_registry.js` to `src/core/active_turn_registry.ts`
- [x] Rename `src/core/bridge_session_service.js` to `src/core/bridge_session_service.ts`
- [x] Rename `src/core/bridge_coordinator.js` to `src/core/bridge_coordinator.ts`
- [x] Rename `src/core/errors.js` to `src/core/errors.ts`

Acceptance:

- [x] Core command handling and session routing compile under TypeScript
- [x] Existing core tests continue to pass

## Phase 6: Provider and Runtime Migration

- [x] Rename `src/providers/codex/app_client.js` to `src/providers/codex/app_client.ts`
- [x] Rename `src/providers/codex/plugin.js` to `src/providers/codex/plugin.ts`
- [x] Rename `src/providers/codex/config.js` to `src/providers/codex/config.ts`
- [x] Rename `src/providers/minimax/plugin.js` to `src/providers/minimax/plugin.ts`
- [x] Rename `src/providers/openai_native/plugin.js` to `src/providers/openai_native/plugin.ts`
- [x] Rename `src/runtime/bootstrap.js` to `src/runtime/bootstrap.ts`
- [x] Rename `src/runtime/plugin_registry.js` to `src/runtime/plugin_registry.ts`
- [x] Rename `src/runtime/weixin_bridge_runtime.js` to `src/runtime/weixin_bridge_runtime.ts`
- [x] Rename `src/cli.js` to `src/cli.ts`
- [x] Rename `src/index.js` to `src/index.ts`

Acceptance:

- [x] Runtime startup path is TypeScript-based
- [x] provider capability checks are compiler-validated

## Phase 7: Platform and Store Migration

- [x] Migrate `src/platforms/weixin/`
- [x] Migrate `src/platforms/telegram/`
- [x] Migrate `src/store/file_json/`
- [x] Migrate `src/store/in_memory/`

Acceptance:

- [x] platform adapters compile with explicit event and transport types
- [x] repository implementations compile against typed contracts

## Phase 8: Test Migration

- [x] Add TS-compatible test execution if needed
- [x] Migrate core tests first
- [x] Migrate provider tests next
- [x] Migrate platform tests last

Recommended early targets:

- [x] `test/core/bridge_coordinator.test.ts`
- [x] `test/core/bridge_session_service.test.ts`
- [x] `test/providers/codex/app_client.test.ts`
- [x] `test/runtime/weixin_bridge_runtime.test.ts`

Acceptance:

- [x] CI runs tests in the new TS-aware workflow

## Phase 9: Post-Migration Hardening

The migration itself is complete. These are optional follow-up improvements, not blockers for the TS cutover:

- [ ] Enable stricter null handling where practical
- [ ] Reduce `any` in test scaffolding and edge adapters
- [ ] Remove transitional JSDoc workarounds that are still useful during ongoing feature work
- [ ] Tighten compiler options incrementally once the bridge behavior remains stable for a while

Acceptance:

- [x] TypeScript prevents real integration mistakes instead of just being present

## Suggested Execution Order

If the migration starts now, this is the recommended order:

1. Add TS tooling and `checkJs`
2. Type the shared contracts and state shapes
3. Migrate `src/core/`
4. Migrate `src/providers/codex/`
5. Migrate `src/runtime/`
6. Migrate `src/platforms/weixin/`
7. Migrate stores and tests

## Result

Completed result:

- the repository now runs on TypeScript entrypoints directly
- source, platform, provider, runtime, store, and test files have been migrated off `.js`
- compiler and test workflows are green
- remaining work is hardening, not migration
