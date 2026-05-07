# Mission Control TODO

This document tracks the implementation backlog for
`@codexbridge/mission-control`.

It is the execution-oriented companion to:

- `docs/architecture/mission-control.md`
- `docs/architecture/mission-control-codexbridge-integration.md`
- `docs/architecture/mission-control-loop-prompt.md`
- `docs/todo/roadmap.md`

## Track Branch

Primary long-lived branch for this workstream:

```text
track/mission-control
```

Expected file ownership for this branch:

- `packages/mission-control/**`
- `docs/architecture/mission-control.md`
- `docs/architecture/mission-control-codexbridge-integration.md`
- `docs/architecture/mission-control-loop-prompt.md`
- `docs/todo/mission-control.md`
- mission-control-specific integration files when they are introduced

Avoid frequent edits here unless the change is truly cross-cutting:

- `docs/todo/roadmap.md`
- `README.md`
- `package.json`

## Scope

Mission Control should become the goal-driven runtime that keeps Codex working
until the requested outcome is actually finished, explicitly blocked, or
explicitly failed.

It should own:

- mission domain model
- mission state machine
- workflow loading
- workspace selection/isolation
- run / verify / repair / retry loop
- persisted attempts, events, workpad, and runner leases
- provider abstraction
- stop / retry / resume control actions
- pending-approval / handoff state modeling and future provider-neutral
  approval control hooks

It should **not** own:

- WeChat/Telegram message parsing
- SendGate delivery mechanics
- slash-command help text
- platform binding/session browsing UX
- assistant-record storage as a separate product concern
- provider-profile CLI management
- bridge i18n and command aliasing

## Locked End State

The architecture is now locked by:

- `docs/architecture/mission-control.md`
- `docs/architecture/mission-control-codexbridge-integration.md`

These are no longer open product questions for the current loop:

- [x] Mission Control is `WorkItem`-centered, not prompt-centered
- [x] `Mission` is anchored to a stable `workItemId`, not to a chat thread or
  host session id
- [x] `Mission` keeps fixed `immutableGoal`, fixed `immutablePrompt`, loop
  policy, and an active checklist version reference
- [x] checklist truth may live in an external source, but Mission Control keeps
  immutable `ChecklistSnapshot` versions for replay/recovery
- [x] `Checklist`, `ChecklistItem`, `ChecklistSnapshot`,
  `PlanChangeRequest`, `CycleResult`, and `MissionGeneration` are target
  first-class runtime models
- [x] package-owned `commands / queries / streams` are the canonical API
  boundary
- [x] direct in-process function calls come first; network service exposure is
  a later wrapper
- [x] `Connect RPC` is the preferred later network transport, not a current
  blocker
- [x] `AgentJob` is only a host-side compatibility projection during migration,
  not the authoritative mission store
- [x] `/auto` is scheduler-owned host functionality and is out of Mission
  Control scope
- [x] `loop.sh` is a migration-era external supervisor; its useful supervision
  semantics should converge into package-owned runtime behavior over time

## Current Baseline

Phases 0-6 established the package, Codex provider, verifier loop, workspace
identity, and `/agent` baseline integration.

Phase 7a then added the first authoritative Mission Control runtime records
that sit above host jobs and prompt turns:

- `WorkItem`
- `ChecklistSnapshot` / `ChecklistItem`
- `PlanChangeRequest`
- `MissionGeneration`

Phase 7b now adds the first typed package-owned loop protocol on top of those
records:

- `CycleResult`
- checklist-progress helpers that map verifier outcomes back onto the active
  `ChecklistSnapshot`
- runtime/appended event metadata that persist typed cycle results for
  continuation, retry, waiting, handoff, and done/failure outcomes

Fresh reruns now open a new mission generation instead of destructively
clearing prior attempt/event history, and runtime/API consumers can now read a
typed cycle protocol without reconstructing loop state from bridge-local text.

Phase 7c now completes the first checklist-authoritative completion semantics:

- attempt prompts and verifier inputs carry the active checklist item
- verifier feedback can advance one acceptance item at a time instead of
  treating the first `complete` as mission-wide success
- the runtime only enters `completed` after checklist progression reaches its
  final item and the final verifier pass succeeds

Phase 8a now adds the first package-owned in-process API contract above those
records:

- canonical `commands / queries / streams` request/response shapes
- boundary metadata: `requestId`, `correlationId`, `idempotencyKey`
- package-owned query views for summary/workpad, timeline/history, attempts,
  and execution refs/host bindings/artifact refs
- a direct in-process implementation used by CodexBridge for `/agent`
  `list/show/stop/retry`

Phase 8b now adds the first explicit host adapter contract beside that API:

- exported `MissionHostAdapter` / `MissionHostContext` boundary types
- a first CodexBridge host adapter that routes session/thread binding,
  progress, provider approvals, and artifact-publication hooks through that
  package-owned contract
- `/agent` artifact rendering now prefers package-owned execution artifact refs
  before falling back to legacy `AgentJob` compatibility blobs

Phase 8c now moves CodexBridge onto a package-owned authoritative mission
repository while keeping `AgentJob` as a rebuildable compatibility projection:

- runtime bootstrap now provisions a real Mission Control repository for both
  in-memory and file-backed bridge runtimes
- `/agent` creation, read/control queries, and `runAgentJobWithMissionControl`
  now seed/backfill and then share that same repository instead of treating
  `AgentJob.missionRuntimeState` as the only mission truth
- legacy compatibility blobs can still backfill the authoritative repository
  during migration, but bridge runtime state can now be reconstructed from the
  package repository after projection loss or restart
- host-side attachment/result caches still exist for compatibility, but they no
  longer have to be the authoritative mission store

That baseline is useful, but it is **not** the final target shape.
The remaining work is to converge the current implementation toward the
host-neutral architecture locked in the two architecture documents above.

## Reference Stack

Mission Control should be informed by these upstream projects:

- [ ] `openai/symphony`
  - use for: orchestrator/workspace/workpad/retry/status model
- [ ] `openai/openai-agents-js`
  - use for: future OpenAI-native provider adapter surface
- [ ] `langchain-ai/langgraphjs`
  - use for: explicit state graph and resumable execution ideas
- [ ] `inngest/inngest`
  - use for: durable queued step execution and retry semantics
- [ ] `dbos-inc/dbos-transact-ts`
  - use for: persistence-first workflow ownership and restart recovery
- [ ] `mastra-ai/mastra`
  - use for: TS runtime/package composition patterns
- [ ] `VoltAgent/voltagent`
  - use for: TS agent engineering/runtime layering patterns
- [ ] local `codex-mission-control` prototype copy
  - use for: bounded mission contract, lease ownership, tmux supervision,
    heartbeat recovery, checkpoint/workpad seed ideas

Rules for references:

- [ ] Record *why* each reference matters before copying any implementation idea
- [ ] Do not vendor external runtime code unless there is a clear local ownership reason
- [ ] Prefer adapting concepts into Mission Control abstractions over mirroring upstream APIs
- [ ] Keep the current product target primary: a Codex-first, provider-pluggable runtime
- [ ] Keep the final product/package name as `Mission Control`; treat
  `codex-mission-control` as a predecessor prototype, not the target identity
- [ ] Do not rely on a local `reference/symphony` copy existing; upstream spec is
  the source of truth unless a local mirror is explicitly synced

## Symphony Essence Checklist

Mission Control should preserve these Symphony ideas as explicit design
constraints, not just as vague inspiration:

- [x] Repository-owned workflow contract is the primary runtime policy source
- [x] Single-authority orchestrator owns dispatch, retries, cancellation, and
  reconciliation
- [x] Stable workspace identity survives retries and normal exits
- [x] Continuation after normal exit is supported; retries are not failure-only
- [x] Handoff or waiting-human outcomes are first-class mission states
- [x] Status surfaces observe and control the orchestrator but do not own run
  execution
- [x] Policy/config/coordination/execution/status layers remain separated

## Packaging Direction

The package should start as a package inside the CodexBridge repository:

```text
packages/mission-control/
```

Rules:

- `CodexBridge -> @codexbridge/mission-control`
- `@codexbridge/mission-control -X-> CodexBridge platform/runtime/command code`
- No workspace/monorepo conversion is required yet.
- Follow the same internal-package pattern already used by
  `packages/codex-gateway`.
- Treat CodexBridge as the first host, not the final product boundary.

Package bootstrap target:

- [x] Package root: `packages/mission-control`
- [x] Package metadata: `packages/mission-control/package.json`
- [x] Package source entry: `packages/mission-control/src/index.ts`
- [x] Package tsconfig: `packages/mission-control/tsconfig.json`
- [x] Package README documents ownership and non-ownership
- [x] Root scripts:
  - `mission-control:typecheck`
  - `mission-control:test`
  - `mission-control:build`
  - `mission-control:check-boundary`
- [x] Boundary script prevents imports from:
  - `src/platforms/**`
  - `src/runtime/**`
  - `src/i18n/**`
  - `src/cli.ts`
  - WeChat/Telegram command handlers

## Recommended Route

This backlog follows the route below:

- [x] Use Symphony to define the orchestrator/workspace/retry/state-machine shape
- [x] Preserve the Symphony idea that normal worker exit may still schedule a
  continuation retry
- [x] Preserve the Symphony idea that handoff/waiting states are legitimate
  mission outcomes, not only failures
- [x] Use current Codex app-server flow as the first real provider:
  `CodexMissionProvider`
- [ ] Add a future `OpenAIAgentsMissionProvider` on top of
  `openai-agents-js`, not as the default runtime
- [ ] Use LangGraph.js / Inngest / DBOS as durability and resumability
  references
- [ ] Reuse only the prototype pieces from local `codex-mission-control` that
  survive the provider-pluggable package boundary
- [x] Converge the result into one provider-pluggable package:
  `@codexbridge/mission-control`

## Phase 0: Baseline Current `/agent` Behavior

Before moving ownership into the package:

- [x] Record the current `/agent` public behavior that users already rely on
- [x] Lock current `/agent` migration-protection tests covering:
  - create / confirm / cancel
  - list / show / stop / retry / result
  - approval + interrupted-turn handling
  - artifact/result delivery
Phase 0 source-of-truth inventory:

- `/agent`
  - public command contract: `docs/command-skills/agent.md`
  - migration-protection tests: `test/core/bridge_coordinator.test.ts`
    - `/agent drafts, confirms, runs, verifies, and records a background job`
    - `/agent stores generated attachments and can resend them`
    - `/agent show, retry, rename, stop, and delete manage queued jobs`
    - `/agent runAgentJob retries after an interrupted provider turn and completes on the next attempt`
    - `/agent runAgentJob forwards provider approval requests to the supplied approval callback`

## Phase 1: Domain and Persistence

Create the core durable mission model.

- [x] Add `MissionStatus`, `MissionSource`, and `MissionPriority` types
- [x] Add `Mission`, `MissionAttempt`, `MissionEvent`, and `MissionWorkpad` types
- [x] Add explicit state transition helpers
- [x] Add a persistence port:
  - `MissionStore`
  - `MissionAttemptStore`
  - `MissionEventStore`
  - or one combined `MissionRepository`
- [x] Add a first local persistence implementation using the existing CodexBridge
  storage style
- [x] Persist enough state to recover after process restart:
  - mission
  - attempt
  - workpad
  - event log
  - lease/lock
  - pending approval/block reason
- [x] Add one authority for runtime state ownership instead of splitting active
  mission state across ad hoc background-job records

Completion criteria:

- [x] A mission can be created, listed, read, updated, and stopped without
  starting a provider run
- [x] State transitions are explicit and testable
- [x] Restart recovery can identify resumable missions

## Phase 2: Workflow and Workpad

- [x] Add `MissionWorkflowLoader` for `.codexbridge/mission/WORKFLOW.md`
- [x] Parse YAML front matter plus prompt body
- [x] Keep workflow config as the primary policy surface instead of embedding
  run behavior into slash-command handlers
- [x] Define a canonical mission-attempt prompt contract so prompt,
  orchestrator, and verifier responsibilities stay separated
- [x] Add safe built-in defaults when the file is missing
- [x] Reject mission execution when workflow config is invalid, but do not block
  normal bridge startup
- [x] Design the config layer so path/env/default resolution can evolve toward a
  typed workflow-policy contract
- [x] Add workpad rendering helpers for:
  - compact summary
  - latest blocker
  - attempt history
  - final result summary
- [x] Add `/agent show` integration so workpad becomes the main status view

Completion criteria:

- [x] Workflow source is visible in mission status
- [x] Workpad can survive restart and multiple attempts

Phase 2 source-of-truth tests:

- `test/core/bridge_coordinator.test.ts`
  - `/agent show, retry, rename, stop, and delete manage queued jobs`
  - `/agent runAgentJob retries after an interrupted provider turn and completes on the next attempt`
  - `/agent runAgentJob loads WORKFLOW.md and routes it into the mission-controlled execution prompt`
- `test/store/file_json_repositories.test.ts`
  - `file-backed repositories preserve agent jobs across repository reloads`

## Phase 3: Workspace and Lease Management

- [x] Add `MissionWorkspaceService`
- [x] Create default directory layout under `~/.codexbridge/mission/`
- [x] Add code-changing mission isolation under
  `~/.codexbridge/mission/workspaces/<missionId>/`
- [x] Make workspace identity deterministic per mission so retries and
  continuation reuse the same execution context safely
- [x] Allow safe reuse of bound cwd for read-only missions
- [x] Add runner lease records to prevent duplicate workers
- [x] Add stale-lease recovery

Completion criteria:

- [x] Concurrent mission limit is enforced
- [x] One mission cannot accidentally resume inside another mission workspace
- [x] Restarting the bridge does not create duplicate active runners

Phase 3 source-of-truth tests:

- `packages/mission-control/test/workspace_and_lease.test.ts`
  - `workspace service creates deterministic isolated mission workspaces and default layout`
  - `workspace service can reuse bound cwd for explicit read-only missions`
  - `lease coordinator enforces concurrent limits, conflict checks, and heartbeat updates`
  - `stale lease recovery re-queues running missions, preserves verifier states, and supports restart-safe reclaim`

## Phase 4: Codex Provider Adapter

The first real provider is current Codex app-server execution.

- [x] Add `MissionProvider` port
- [x] Add `CodexMissionProvider`
- [x] Reuse provider profile + Codex thread binding safely
- [x] Support:
  - start
  - continue
  - wait
  - interrupt
- [x] Persist provider run/thread ids at the attempt level
- [x] Map Codex-native interrupted/blocking/completed outcomes into mission
  status
- [x] Treat normal provider exit as eligible for continuation when the mission
  is still active and budget remains

Completion criteria:

- [x] Mission Control can drive a real Codex run without importing WeChat code
- [x] Stop/retry behavior remains chat-visible through CodexBridge integration

Phase 4 source-of-truth tests:

- `packages/mission-control/test/provider_and_codex_adapter.test.ts`
  - `provider helpers persist provider ids on attempts and map terminal outcomes into mission states`
  - `continuation scheduling only applies to active missions with remaining budget`
  - `CodexMissionProvider reuses provider profile, thread binding, and workspace assignment safely`
- `packages/mission-control/test/runtime_loop.test.ts`
  - `mission runtime stopMission interrupts the active provider run and marks the attempt stopped`
- `test/core/bridge_coordinator.test.ts`
  - `/agent runAgentJob retries after an interrupted provider turn and completes on the next attempt`
  - `/agent runAgentJob continues the same attempt after a normal partial provider exit`
  - `/agent runAgentJob forwards provider approval requests to the supplied approval callback`

## Phase 5: Verification Loop

This phase is the core difference between a background chat wrapper and a real
mission runtime.

- [x] Add `MissionVerifier`
- [x] Normalize verifier verdicts:
  - `complete`
  - `repair`
  - `blocked`
  - `waiting_user`
  - `needs_human`
  - `handoff`
  - `failed`
- [x] Persist verifier summaries and missing acceptance criteria
- [x] Add repair prompt generation / reuse
- [x] Enforce:
  - max attempts
  - max turns
  - max runtime
  - artifact count/size budget
- [x] Make `waiting_user` / `needs_human` / `handoff` explicit verifier- or
  provider-driven outcomes instead of generic failure buckets

Phase 5 runtime loop landed in-package: Mission Control now consumes verifier
budgets, uses verifier verdicts as the completion authority, continues the same
attempt after normal partial exits, retries with repair prompts when budget
permits, and fails visibly when budget is exhausted.

Completion criteria:

- [x] "Completed" means acceptance criteria passed
- [x] Missions do not silently stop after one provider response
- [x] Repair/retry is bounded and observable

Phase 5 source-of-truth tests:

- `packages/mission-control/test/verifier_foundations.test.ts`
  - `verifier helpers normalize waiting-user and repair verdicts into explicit mission states`
  - `verifier helpers persist summaries and missing acceptance criteria onto attempts and missions`
  - `verifier budget helpers resolve workflow limits and report exhausted budgets`
- `packages/mission-control/test/runtime_loop.test.ts`
  - `mission runtime keeps verifier repair loops bounded and only completes after acceptance criteria pass`
  - `mission runtime continues the same attempt after a normal partial exit and counts provider turns separately from attempts`
  - `mission runtime converts verifier repair verdicts into budget-exhausted failure when no retry budget remains`

## Phase 6: CodexBridge Integration

- [x] Make `/agent` call Mission Control instead of owning the runner directly
- [x] Reuse the same mission state for:
  - list
  - show
  - stop
  - retry
  - result
- [x] Keep CodexBridge WeChat as the first-class notification/control surface
- [x] Preserve current user-facing behavior as much as possible during migration

Phase 6a landed: `/agent runAgentJob` now delegates execution into Mission
Control through a bridge-side adapter that:

- persists mission/attempt/event snapshot state on the `AgentJob` compatibility
  record
- reuses existing CodexBridge turn recovery, approval, interrupt, and WeChat
  progress delivery paths as the first host/control surface
- preserves Mission Control verifier authority and continuation-after-normal-exit
  behavior on the real `/agent` execution path without introducing a new
  `/mission` command yet

Phase 6c landed: bridge-side `/agent` read/control commands now project a
single Mission Control-backed state view so that:

- list/show/result prefer `missionRuntimeState` over stale compatibility fields
- stop updates the persisted mission snapshot instead of only toggling legacy
  `AgentJob` status fields
- retry re-queues a fresh queued mission snapshot under the same mission/job id
  instead of dropping back to ad hoc compatibility-only state
- existing `/agent result` fallback still backfills the compatibility record
  when only a preview copy was cached locally

Phase 6d landed: package-owned retry snapshot helpers now back `/agent retry`
so that:

- queued retry state is derived from `@codexbridge/mission-control` instead of
  bridge-local reset logic
- retry keeps stable mission/workspace/thread identity while clearing stale
  attempts, events, verifier summaries, and result state before requeueing
- provider-native in-turn approval replies remain a host concern until the
  package grows a provider-neutral approval reply control port

Completion criteria:

- [x] `/agent` remains the Mission v0 surface
- [x] No new `/mission` command is required yet
- [x] Existing users do not need to learn a new mental model

Phase 6 source-of-truth tests:

- `packages/mission-control/test/control_actions.test.ts`
  - `createMissionRetrySnapshot clears runtime history but preserves stable mission context`
  - `createMissionResumeSnapshot re-queues waiting missions without discarding accumulated context`
  - `shouldMissionRetryReuseAccumulatedContext only preserves waiting-human continuation states`
  - `json repository resetMission replaces the mission snapshot and clears attempts and events for that mission`
- `test/core/bridge_coordinator.test.ts`
  - `/agent drafts, confirms, runs, verifies, and records a background job`
  - `/agent stores generated attachments and can resend them`
  - `/agent show, retry, rename, stop, and delete manage queued jobs`
  - `/agent list, show, result, stop, and retry prefer Mission Control runtime state over stale compatibility fields`
  - `/agent runAgentJob retries after an interrupted provider turn and completes on the next attempt`
  - `/agent runAgentJob continues the same attempt after a normal partial provider exit`
  - `/agent runAgentJob loads WORKFLOW.md and routes it into the mission-controlled execution prompt`
  - `/agent runAgentJob forwards provider approval requests to the supplied approval callback`
- `test/core/agent_job_service.test.ts`
  - `AgentJobService retryJob preserves Mission Control runtime history when re-queueing waiting-human missions`
  - `AgentJobService retryJob preserves prior runtime history for fresh reruns via a new mission generation`

Phase 6e landed: public package metadata and checklist status now track the
verified CodexBridge integration state so that:

- `@codexbridge/mission-control` publishes a validated package phase marker
  instead of a stale earlier-phase label
- package README and public-surface tests reflect that `/agent` delegates into
  Mission Control without introducing a separate `/mission` surface
- checklist items backed by Mission Control package tests, bridge integration
  tests, and the package boundary check are marked complete

Phase 6f landed: waiting-human continuation retries now reuse package-owned
resume semantics so that:

- `/agent retry` preserves attempts, events, and workpad context for
  `waiting_user`, `needs_human`, `handoff`, and `blocked` missions instead of
  clearing them like a fresh rerun
- the existing `/agent retry` surface continues to serve as Mission v0 requeue
  control without introducing a separate `/agent resume` command yet
- completed or failed reruns still reset through package retry snapshots, so a
  deliberate fresh rerun keeps bounded clean-state behavior

Phase 4-7 revalidation sync landed: package-level verification and bridge-side
integration tests were rerun against the current `track/mission-control` code so
that:

- the completed status of Phase 4, Phase 5, Phase 6, and Phase 7 remains
  backed by
  current code, not only by historical checklist state
- the top-level roadmap can mark Mission Control's workflow/workpad/workspace,
  verifier-authority, checklist-aware continuation, and CodexBridge
  control-surface integration summary items complete without drifting from the
  tested implementation
- the current validation baseline is explicit:
  - `pnpm mission-control:typecheck`
  - `pnpm mission-control:test`
  - `pnpm mission-control:build`
  - `pnpm mission-control:check-boundary`
  - `pnpm test --test-name-pattern "Mission Control|WORKFLOW\\.md|interrupted provider turn|normal partial provider exit|approval requests|show, retry, rename, stop, and delete manage queued jobs|list, show, result, stop, and retry prefer Mission Control runtime state" test/core/bridge_coordinator.test.ts`
  - `pnpm test --test-name-pattern "AgentJobService retryJob preserves Mission Control runtime history when re-queueing waiting-human missions|AgentJobService retryJob preserves prior runtime history for fresh reruns via a new mission generation" test/core/agent_job_service.test.ts`

Phase 9d landed: package-owned stop control now persists authoritative
`stopRequest` mission records, exposes them through package query views, and
lets runtime/supervision consume them at safe checkpoints so `/agent stop`
does not need to synthesize terminal mission truth inside the bridge
projection first. Stale-lease recovery no longer prevents the package from
marking the latest non-terminal attempt as `stopped` when a stop request is
already persisted.

Phase 9e landed: CodexBridge now exposes a first real local todo
`WorkItemSourceAdapter` on top of assistant-record todos while keeping that
store fully host-owned. The adapter normalizes those records into
`source=local-todo` work items, preserves structured
goal/output/acceptance/plan payloads plus source metadata, derives a stable
`sourceRevision` from local record state, and falls back to the live todo
content whenever host-side edits invalidate the structured payload digest.

Phase 9f landed: Mission Control now exposes a package-owned
`syncMissionSource` command for pristine `draft`/`queued` missions so a
source-backed work item can refresh the authoritative
`WorkItem + Mission + MissionGeneration + ChecklistSnapshot` aggregate before
the first attempt starts. CodexBridge queued `/agent rename` now uses that
path when possible instead of rewriting authoritative mission/work-item state
directly through bridge-local repository access.

Phase 9h landed: Mission Control query read models now surface authoritative
workflow load state, checklist progression, and workpad/attempt status views.
CodexBridge `/agent show` now prefers those package-owned views instead of
loading `WORKFLOW.md` or reconstructing attempt/workpad state in the bridge,
and `/agent result` now prefers authoritative mission `resultText` before
falling back to thread/session recovery.

Phase 9i landed: pristine package-owned source sync now preserves
append-oriented authoritative history for pre-attempt refreshes instead of
rewriting it destructively. `syncMissionSource` now supersedes prior
`ChecklistSnapshot` versions, keeps the active generation identity stable, and
appends `mission.source_synced` audit events so repeated queued `/agent rename`
or other pristine source refreshes retain replayable lineage inside Mission
Control.

Phase 9j landed: package-owned command/query and host-adapter boundaries now
prefer generic `hostSessionId` / `providerThreadId` fields while preserving
`bridgeSessionId` / `codexThreadId` as compatibility aliases for the current
CodexBridge `/agent` migration. Direct Mission Control API create/retry paths
now accept that host-neutral surface without bridge-specific field names, and
package/core adapter tests prove the same contract can be consumed outside a
CodexBridge-only naming scheme.

Phase 9k landed: a package-only host-neutral integration proof now creates,
runs, queries, and streams a CLI-shaped mission through the generic
`hostSessionId` / `providerThreadId` contract plus `MissionHostAdapter`
without importing CodexBridge runtime code. Later hosts can therefore validate
the same mission core behavior through package-owned APIs instead of requiring
bridge-specific naming or runner logic.

Phase 9l landed: Mission Control now exposes a package-owned `startMission`
command plus concrete `awaiting_checklist_confirm` /
`awaiting_prompt_confirm` lifecycle states for the first autonomous run.
CodexBridge `/agent confirm` now creates a drafted authoritative mission,
walks the user through checklist confirmation and immutable-prompt
confirmation before queueing the mission, and `/agent show` surfaces those
package-backed start gates directly from mission detail state.

Phase 9m landed: Mission Control now exposes package-owned loop snapshot read
and stream surfaces on top of the existing supervision foundation, and
CodexBridge `/agent show` now renders those package-backed cycle/stage/progress
fields directly from mission detail state. Summary/detail/execution views now
carry a normalized `loopSnapshot`, the package exports
`getMissionLoopSnapshot` plus `streamMissionSnapshots`, and the first host can
inspect current cycle, stage, checklist item, overall completion, next step,
blocker, and verifier summary without depending on raw shell log output.

Phase 9n landed: CodexBridge now exposes a first package-backed paused-state
continuation UX on top of those loop snapshots. `/agent show` now surfaces the
latest required user action plus an explicit `/agent confirm` continue hint for
`waiting_user` / `needs_human` / `handoff` / `blocked` missions, and
`/agent confirm` now routes those paused missions through package-owned
`resumeMission` instead of forcing users onto `/agent retry` or raw shell-log
inspection for simple continuation.

Phase 9n is the current validated baseline, but several behaviors above are
still transitional:

- `AgentJob` still carries bridge-side compatibility state that should keep
  shrinking toward a pure projection/cache
- artifact/result export delivery still keeps bridge-side compatibility
  fallbacks for older jobs and missing package-backed files
- source-backed mission sync now reaches the initial manual create path, a
  pristine pre-attempt refresh path with authoritative lineage retention, and a
  first assistant-record-backed `local-todo` adapter, but broader source
  sync/reconciliation still belongs to the unfinished backlog
- package/runtime support for `PlanChangeRequest`, `waiting_user`, and
  `needs_human` exists, and the first host now has a package-backed simple
  paused-state continue path, but plan-change resolution plus richer paused
  input/approval flows still need to be productized before Mission Control can
  be treated as a complete looping experience
- the formal Mission Control spec now expects explicit
  `awaiting_checklist_confirm`, `awaiting_prompt_confirm`,
  `scope_change_pending`, and `max_loops_reached` lifecycle semantics plus
  package-owned `startMission` / approval / plan-change / snapshot-stream
  control surfaces, but the concrete package boundary has not fully converged
  on that formal contract yet

## Phase 7: Checklist-First Domain Hardening

Phase 7a landed: the package now persists `WorkItem`, `ChecklistSnapshot`,
`ChecklistItem`, `PlanChangeRequest`, and `MissionGeneration` records, and
bridge-side fresh retries preserve prior runtime history by opening a new
generation instead of wiping attempts/events.

Phase 7b landed: Mission Control now emits a typed `CycleResult` after each
meaningful runtime loop decision, persists that protocol on mission events, and
updates checklist progress from verifier feedback so hosts can observe repair /
continue / waiting / done outcomes without reconstructing them from raw bridge
status strings.

Phase 7c landed: Mission Control attempt prompts and verifier inputs now carry
the active checklist item, verifier feedback can advance one acceptance item at
a time instead of treating the first `complete` as mission-wide completion, and
the runtime only enters `completed` after the checklist progression reaches its
final item and the final verifier pass succeeds.

- [x] Add first-class `WorkItem` domain modeling distinct from host job/thread
  ids
- [x] Add first-class `Checklist`, `ChecklistSnapshot`, and `ChecklistItem`
  models
- [x] Add `PlanChangeRequest` so AI-proposed checklist changes become explicit
  versioned requests instead of implicit prompt drift
- [x] Add fixed `immutableGoal`, fixed `immutablePrompt`, and explicit
  `loopPolicy` fields to the authoritative mission model
- [x] Add a typed `CycleResult` contract as the package-owned loop protocol
- [x] Add `MissionGeneration`/run lineage so fresh reruns no longer clear prior
  history
- [x] Move completion semantics to:
  - all checklist items complete
  - final goal verified

Completion criteria:

- [x] Mission truth no longer depends on legacy "one prompt, one job" mental
  models
- [x] Item-level verifier outcomes can drive continuation, repair, waiting, or
  completion without host-local heuristics
- [x] Fresh reruns preserve prior mission history through generation/lineage
  instead of destructive reset

## Phase 8: Host-Neutral API and Projection Cleanup

- [x] Define the canonical package-owned `commands / queries / streams`
  contract
- [x] Keep direct in-process function calls as the first concrete
  implementation of that contract
- [x] Add boundary metadata:
  - `requestId`
  - `correlationId`
  - `idempotencyKey`
- [x] Add package-owned query shapes for:
  - mission summary/workpad
  - mission timeline/history
  - mission attempts
  - execution refs / host bindings / artifact refs
- [x] Add explicit host adapter boundaries for session/thread/approval/artifact
  delivery/notification/auth context
- [x] Expose generic `hostSessionId` / `providerThreadId` boundary fields
  while keeping transitional CodexBridge compatibility aliases
- [x] Move `/agent` reads and control actions further onto package-owned query
  and command contracts
- [x] Keep stripping bridge-owned runtime truth out of `AgentJob` until it is a
  projection/cache only
- [x] Keep `/auto` entirely outside Mission Control ownership

Completion criteria:

- [x] CodexBridge can render and control mission state without reconstructing
  truth from compatibility blobs
- [x] `AgentJob` can be treated as a rebuildable host projection rather than an
  authoritative store
- [x] host-specific command names remain outside the package contract

## Phase 9: Work Item Sources and Runtime Supervision

Phase 9a landed: Mission Control now exports a first `WorkItemSourceAdapter`
contract plus normalized manual source summaries, persists checklist snapshot
source revisions + hashes, and exposes a repository-backed progress sink that
updates workpad/timeline state without letting providers or hosts mutate
authoritative lifecycle status directly. The current `/agent` run path now uses
that sink for provider/verifier progress persistence while supervision and
source-backed mission creation remain unfinished.

Phase 9b landed: Mission Control now exposes a package-owned `createMission`
command that consumes a normalized `WorkItemSourceSummary`, persists
authoritative `WorkItem + Mission + MissionGeneration + ChecklistSnapshot`
records from that source-backed input, and keeps host bindings separate from
work-item provenance. CodexBridge `/agent` creation now seeds the authoritative
mission repository through that command with `source=manual` while preserving
`platform=weixin|telegram` as host-surface binding metadata.

Phase 9c landed: Mission Control now exports a first `MissionSupervisor`
foundation that works directly from the authoritative repository, recovers
stale leases before dispatch, derives structured status snapshots/checkpoints
from persisted mission state, and runs supervisable missions until idle through
the package runtime. Waiting-human states remain explicit host-controlled
resumptions, so package supervision can now own recovery/continuation for
`queued` / `planning` / `running` / `verifying` / `repairing` missions without
pulling `/auto` or bridge-local shell truth back into Mission Control.

Phase 9d landed: Mission Control now persists explicit mission `stopRequest`
control records, keeps them visible on package-owned execution/query views, and
lets runtime/supervision materialize the final `stopped` state from that
authoritative request instead of requiring bridge-local fake terminal writes
first. Stopped attempts can now still be derived after stale-lease recovery
clears `activeAttemptId`, so supervision owns stop reconciliation end-to-end.

Phase 9e landed: CodexBridge now contributes a first real local todo source
adapter on top of assistant-record todos without pulling assistant-record
storage into the package. That adapter emits normalized `source=local-todo`
work items plus source revisions, preserves structured goal/output/checklist
payloads in the host-owned local source, and falls back to the live todo
content when host-side edits invalidate that structured payload digest.

Phase 9f landed: Mission Control now adds a package-owned pristine source sync
command that can refresh an untouched source-backed mission aggregate before
the first attempt starts, while preserving mission identity and host bindings.
CodexBridge queued `/agent rename` now uses that command when possible so the
authoritative mission/work-item path stays inside the package boundary.

Phase 9g landed: CodexBridge host runtimes now use package-owned mission
supervision for stale recovery and resumable `/agent` dispatch discovery
instead of resetting host projections and only re-claiming `queued` bridge
jobs. `MissionSupervisor` recovery/listing no longer requires a full runtime
instance, stale `running` missions can be re-queued from authoritative mission
truth, stale `verifying` / `repairing` missions remain discoverable for resume,
and local host scheduling keeps `loop.sh` as an operational fallback instead
of a structural source of run ownership.

Phase 9h landed: package-owned mission read models now expose authoritative
workflow/checklist/workpad status views so hosts can render `/agent` state
without loading `WORKFLOW.md` or reconstructing attempt/checklist progress
from bridge-local compatibility fields. CodexBridge `/agent show` now consumes
those package views directly, and `/agent result` prefers authoritative mission
`resultText` before bridge/session fallbacks.

Phase 9i landed: package-owned pristine source sync now keeps append-oriented
history instead of resetting authoritative records. Repeated pre-attempt source
refreshes supersede older `ChecklistSnapshot` versions, preserve the active
generation identity, and append `mission.source_synced` events so CodexBridge
queued `/agent rename` no longer rewrites away prior source-sync audit
history.

Phase 9n landed: CodexBridge now exposes a first package-backed paused-state
continuation flow on top of those mission detail and loop snapshot views.
`/agent show` surfaces the latest required user action plus an explicit
`/agent confirm` continue hint for `waiting_user` / `needs_human` /
`handoff` / `blocked` missions, and `/agent confirm` now routes those paused
missions through package-owned `resumeMission` instead of requiring `/agent
retry` or shell-log inspection for simple continuation.

- [x] Add `WorkItemSourceAdapter` as the source abstraction
- [x] Support manual host-created source-backed work items through the
  package-owned create command
- [x] Support local todo/checklist source adapters
- [x] Support package-owned pristine source sync/reconciliation before the
  first attempt starts
- [x] Add package-owned workflow/checklist/workpad read models so hosts can
  render authoritative mission state without bridge-local reconstruction
- [x] Reconcile the concrete package status machine with the formal spec around
  explicit:
  - `awaiting_checklist_confirm`
  - `awaiting_prompt_confirm`
- [ ] Reconcile the concrete package status machine with the formal spec around
  explicit:
  - `scope_change_pending`
  - `max_loops_reached`
- [x] Add package-owned command coverage for:
  - `startMission`
- [ ] Add package-owned command coverage for:
  - approval resolution
  - plan-change resolution
- [x] Add package-owned mission snapshot subscription/read surfaces that map
  cleanly onto the formal `streamMissionSnapshots` / loop-status model
- [x] Expose first-host start gates for `awaiting_checklist_confirm` and
  `awaiting_prompt_confirm` before the first autonomous cycle begins
- [x] Require the first host to persist and explicitly confirm the
  `immutablePrompt` plus initial checklist snapshot instead of treating
  `/agent confirm` as a generic background-job launch
- [x] Add package-backed mission snapshot views to the first host so users can
  observe loop status through:
  - current cycle
  - current stage / checklist item
  - overall completion
  - next step
  - latest blocker / verifier summary
- [x] Add first-host resume/continue flows for `waiting_user`,
  `needs_human`, `handoff`, and `blocked` missions without requiring raw
  shell/loop log inspection
- [ ] Add first-host resolution flows for `PlanChangeRequest` and richer
  paused-state approval/input cases that need more than a simple resume signal
- [ ] Let the first host start and continue a checklist-backed looping mission
  without external `loop.sh` as the primary user-facing control surface
- [ ] Support future issue/board integrations
- [x] Keep external checklist/source truth separate from internal immutable
  `ChecklistSnapshot` runtime copies
- [x] Add restricted provider/agent progress update paths for workpad/progress
  reporting without lifecycle-state mutation
- [x] Add package-owned supervision semantics that absorb the useful parts of
  `loop.sh`:
  - [x] status snapshots
  - [x] stop markers / stop intents
  - [x] bounded supervision loops
  - [x] stale-run recovery
  - [x] history retention
  - [x] checkpoint/continuation semantics
- [x] Reduce long-lived reliance on external `loop.sh` to an operational
  fallback once package supervision exists

Completion criteria:

- [x] Mission Control can consume and track source-backed work items without
  assuming a chat-only origin
- [x] The runtime can recover, continue, and report progress using package-owned
  supervision semantics
- [x] External shell supervision is optional, not structurally required
- [ ] The concrete package commands/status model converges with the formal spec
  for confirmation, paused-state, and loop-budget lifecycle control
- [x] A first host can require explicit `immutablePrompt` plus initial
  checklist confirmation before the first autonomous cycle starts
- [ ] A first host can inspect package-owned cycle/stage/completion snapshots
  and resolve plan changes or richer paused states without reading shell logs
- [ ] A user can run a checklist-backed looping mission from the first host
  surface without external `loop.sh` as the primary UX

## Phase 10: Service Exposure and Additional Hosts

- [ ] Wrap the same package-owned contract in a later service layer
- [ ] Prefer `Connect RPC` for network command/query/stream exposure
- [ ] Keep one canonical request/response schema across function calls and
  service exposure
- [ ] Map mission event/snapshot subscriptions to streaming transport
- [ ] Let later Telegram/web/CLI/API hosts consume the same mission core
  without changing package behavior

Guardrails:

- [ ] Service exposure must not fork the package API into a second runtime
  contract
- [ ] A future web UI must not become the source of truth for mission state

## Later Providers and Sources

Provider expansion:

- [ ] `OpenAIAgentsMissionProvider`
- [ ] future provider-pluggable long-task executors if they can support durable
  run semantics

Source expansion:

- [ ] GitHub issues
- [ ] Linear issues
- [ ] assistant-record promotion
- [ ] desktop/browser companion work

## Completion Criteria

Mission Control is ready for broader extraction when:

- [x] A user can give one goal and the system keeps working until it completes,
  blocks, fails, or is stopped
- [x] Restart recovery works for queued/running/verifying missions
- [x] `/agent` uses the mission runtime without host-owned runner logic
- [x] The package has no imports from platform/runtime/i18n command code
- [x] `WorkItem`/checklist/generation semantics are authoritative runtime
  models instead of host-local conventions
- [x] `AgentJob` is only a rebuildable host projection/cache, not mission truth
- [x] package-owned commands/queries/streams are enough for a host to observe
  and control missions
- [x] a later Telegram, web, or other host surface can integrate without
  changing mission core behavior
- [x] `/auto` remains fully outside Mission Control ownership
- [ ] the concrete package API/state machine matches the formal spec for
  `startMission`, approval / plan-change resolution, snapshot streaming, and
  confirmation/budget states
- [x] the first host can persist and confirm an immutable prompt plus initial
  checklist before autonomous looping begins
- [ ] the first host can render package-owned loop snapshots and resolve
  `PlanChangeRequest` / `waiting_user` / `needs_human` without shell-log
  inspection
- [ ] the first host can drive a checklist-backed looping mission as product
  UX without depending on external `loop.sh`
