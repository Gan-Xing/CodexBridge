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

Fresh reruns now open a new mission generation instead of destructively
clearing prior attempt/event history, but completion semantics and typed
cycle-result protocol work are still pending inside Phase 7.

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

Phase 4-6 revalidation sync landed: package-level verification and bridge-side
integration tests were rerun against the current `track/mission-control` code so
that:

- the completed status of Phase 4, Phase 5, and Phase 6 remains backed by
  current code, not only by historical checklist state
- the top-level roadmap can mark Mission Control's workflow/workpad/workspace,
  verifier-authority, continuation, and CodexBridge control-surface integration
  summary items complete without drifting from the tested implementation
- the current validation baseline is explicit:
  - `pnpm mission-control:typecheck`
  - `pnpm mission-control:test`
  - `pnpm mission-control:build`
  - `pnpm mission-control:check-boundary`
  - `pnpm test --test-name-pattern "Mission Control|WORKFLOW\\.md|interrupted provider turn|normal partial provider exit|approval requests" test/core/bridge_coordinator.test.ts`
  - `pnpm test --test-name-pattern "AgentJobService retryJob preserves Mission Control runtime history when re-queueing waiting-human missions|AgentJobService retryJob still clears runtime history for fresh reruns" test/core/agent_job_service.test.ts`

Phase 6 is the current validated baseline, but several behaviors above are still
transitional:

- `AgentJob` still carries bridge-side compatibility state that should keep
  shrinking toward a pure projection/cache
- fresh rerun behavior still reflects the older reset-style baseline instead of
  the final generation/lineage model
- `/agent` reads still need to move further toward package-owned
  command/query/timeline contracts

## Phase 7: Checklist-First Domain Hardening

Phase 7a landed: the package now persists `WorkItem`, `ChecklistSnapshot`,
`ChecklistItem`, `PlanChangeRequest`, and `MissionGeneration` records, and
bridge-side fresh retries preserve prior runtime history by opening a new
generation instead of wiping attempts/events.

- [x] Add first-class `WorkItem` domain modeling distinct from host job/thread
  ids
- [x] Add first-class `Checklist`, `ChecklistSnapshot`, and `ChecklistItem`
  models
- [x] Add `PlanChangeRequest` so AI-proposed checklist changes become explicit
  versioned requests instead of implicit prompt drift
- [x] Add fixed `immutableGoal`, fixed `immutablePrompt`, and explicit
  `loopPolicy` fields to the authoritative mission model
- [ ] Add a typed `CycleResult` contract as the package-owned loop protocol
- [x] Add `MissionGeneration`/run lineage so fresh reruns no longer clear prior
  history
- [ ] Move completion semantics to:
  - all checklist items complete
  - final goal verified

Completion criteria:

- [ ] Mission truth no longer depends on legacy "one prompt, one job" mental
  models
- [ ] Item-level verifier outcomes can drive continuation, repair, waiting, or
  completion without host-local heuristics
- [x] Fresh reruns preserve prior mission history through generation/lineage
  instead of destructive reset

## Phase 8: Host-Neutral API and Projection Cleanup

- [ ] Define the canonical package-owned `commands / queries / streams`
  contract
- [ ] Keep direct in-process function calls as the first concrete
  implementation of that contract
- [ ] Add boundary metadata:
  - `requestId`
  - `correlationId`
  - `idempotencyKey`
- [ ] Add package-owned query shapes for:
  - mission summary/workpad
  - mission timeline/history
  - mission attempts
  - execution refs / host bindings / artifact refs
- [ ] Add explicit host adapter boundaries for session/thread/approval/artifact
  delivery/notification/auth context
- [ ] Move `/agent` reads and control actions further onto package-owned query
  and command contracts
- [ ] Keep stripping bridge-owned runtime truth out of `AgentJob` until it is a
  projection/cache only
- [x] Keep `/auto` entirely outside Mission Control ownership

Completion criteria:

- [ ] CodexBridge can render and control mission state without reconstructing
  truth from compatibility blobs
- [ ] `AgentJob` can be treated as a rebuildable host projection rather than an
  authoritative store
- [ ] host-specific command names remain outside the package contract

## Phase 9: Work Item Sources and Runtime Supervision

- [ ] Add `WorkItemSourceAdapter` as the source abstraction
- [ ] Support source-backed work items such as:
  - local todo/checklist
  - manual host-created work items
  - future issue/board integrations
- [ ] Keep external checklist/source truth separate from internal immutable
  `ChecklistSnapshot` runtime copies
- [ ] Add restricted provider/agent progress update paths for workpad/progress
  reporting without lifecycle-state mutation
- [ ] Add package-owned supervision semantics that absorb the useful parts of
  `loop.sh`:
  - status snapshots
  - stop markers / stop intents
  - bounded supervision loops
  - stale-run recovery
  - history retention
  - checkpoint/continuation semantics
- [ ] Reduce long-lived reliance on external `loop.sh` to an operational
  fallback once package supervision exists

Completion criteria:

- [ ] Mission Control can consume and track source-backed work items without
  assuming a chat-only origin
- [ ] The runtime can recover, continue, and report progress using package-owned
  supervision semantics
- [ ] External shell supervision is optional, not structurally required

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
- [ ] `WorkItem`/checklist/generation semantics are authoritative runtime
  models instead of host-local conventions
- [ ] `AgentJob` is only a rebuildable host projection/cache, not mission truth
- [ ] package-owned commands/queries/streams are enough for a host to observe
  and control missions
- [ ] a later Telegram, web, or other host surface can integrate without
  changing mission core behavior
- [x] `/auto` remains fully outside Mission Control ownership
