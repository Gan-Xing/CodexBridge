# Mission Control CodexBridge Integration

This document complements
[`mission-control.md`](./mission-control.md).

The formal Mission Control spec defines the runtime's host-neutral domain,
state machine, interfaces, workflow contract, persistence rules, and runner
loop.

This integration document is narrower. It records how CodexBridge currently
embeds Mission Control for mission-style work, which user-visible contracts are
migration-protected, and how the bridge should keep thinning into a host
adapter instead of remaining the runtime owner.

## Integration Target

CodexBridge is the first consumer and control surface for Mission Control, not
the long-term product boundary of the runtime.

Integration direction:

- `packages/mission-control` owns mission truth, workflow policy, verifier
  authority, and retry/resume semantics
- CodexBridge owns host-facing commands, delivery wording, session UX, and
  approval UX
- host-created mission prompts should resolve into `WorkItem` + `Mission`
  semantics instead of remaining one-off background-job records
- host status/control surfaces should consume Mission Control command/query
  interfaces instead of reconstructing runtime truth from compatibility fields
- `AgentJob` is the bridge-side compatibility projection during migration, not
  the final authoritative mission store
- host-specific command names and navigation stay outside the Mission Control
  formal spec

## Current CodexBridge Mapping

Current code already has a real Mission Control package/runtime boundary:

- `/agent`: manual background job creation, confirmation, full-access run,
  verification, retry, stop, rename, delete, export, and send
- `/review`: native Codex review as a focused work run
- `/threads`, `/open`, `/status`, `/retry`, `/reconnect`: session recovery and
  runtime diagnosis
- `TurnArtifactDeliveryState`: provider-native and bridge-declared artifact
  handoff
- `packages/mission-control`: durable mission domain, workflow loader, workpad,
  workspace/lease coordination, provider port, verifier loop, and control
  helpers
- `AgentJob`: current bridge-side compatibility record that projects Mission
  Control state back onto the existing `/agent` surface

Main remaining integration gap:

- the unified `Mission` model now exists inside
  `@codexbridge/mission-control`
- Phase 8a now adds a package-owned in-process API for:
  - mission summary/detail/timeline/attempt/execution queries
  - retry / resume / stop commands
  - transport-neutral boundary metadata
- Phase 8b now adds an explicit exported host adapter contract for:
  - session/thread binding
  - progress and approval forwarding
  - artifact publication / notification hooks
  - host context lookup
- Phase 8c now adds a package-owned authoritative mission repository inside
  CodexBridge runtime:
  - in-memory and file-backed runtimes both provision a real Mission Control
    repository
  - `/agent` create/read/control/run paths backfill and then share that same
    repository
  - `AgentJob` can now be rebuilt as a compatibility projection/cache after
    restart or projection loss instead of remaining the only mission store
- Phase 9b now adds package-owned source-backed mission creation for the first
  real host flow:
  - `/agent` creation seeds the authoritative mission repository through a
    normalized manual `WorkItemSourceSummary` plus package-owned
    `createMission` command instead of synthesizing mission truth only from the
    host job projection
  - mission `source` can now stay `manual` while `platform` /
    `externalScopeId` continue to represent CodexBridge host bindings, so host
    surface and work-item provenance are no longer conflated
  - checklist snapshot source revision/hash provenance is preserved at mission
    creation time instead of being a later host-local reconstruction concern
- Phase 9c now adds the first package-owned supervision foundation beside that
  authoritative repository:
  - Mission Control exports a `MissionSupervisor` that can recover stale
    leases, derive status snapshots from repository truth, and dispatch
    supervisable missions until idle through the package runtime
  - stale `running` missions are re-queued before dispatch, while stale
    `verifying` / `repairing` missions can continue from persisted attempt
    state instead of requiring bridge-local shell supervision
  - paused human-facing states remain explicit host-controlled resumptions, so
    the bridge still owns user-facing resume intent and approval UX
- Phase 9d now adds package-owned persisted stop-intent semantics on top of
  that supervision foundation:
  - `/agent stop` now routes through the package command layer as an
    authoritative `stopRequest` instead of forcing the bridge projection to
    synthesize terminal mission truth first
  - active runtime/supervision paths consume that persisted stop request at
    safe checkpoints and materialize the final `stopped` state inside the
    package, while host-side thread/session interruption remains a best-effort
    execution hook
  - stopped attempts can now be derived from authoritative mission history even
    after stale-lease recovery clears `activeAttemptId`, so package supervision
    remains the authority for stop reconciliation instead of bridge-local state
- Phase 9e now adds the first real local todo source adapter for the
  CodexBridge host:
  - assistant-record todos can now be normalized as
    `source=local-todo` `WorkItemSourceSummary` items through a bridge-side
    adapter while keeping assistant-record storage fully host-owned
  - structured goal / expected output / acceptance criteria / plan payloads are
    preserved in that local source together with source metadata and a
    deterministic `sourceRevision`
  - if host-side todo edits diverge from the structured payload digest, the
    adapter falls back to the live todo content instead of pretending the stale
    cached checklist is authoritative
- Phase 9f now adds package-owned pristine source sync on top of that source
  foundation:
  - Mission Control exports a `syncMissionSource` command that can replace the
    authoritative `WorkItem + Mission + MissionGeneration + ChecklistSnapshot`
    aggregate for a pristine `draft`/`queued` mission before any attempts
    start, while preserving mission identity and host bindings
  - CodexBridge `/agent rename` now uses that package command for queued
    mission source metadata instead of directly rewriting authoritative
    mission/work-item records through bridge-local repository access
  - non-pristine mission rename/update fallbacks remain transitional host
    projection behavior until more package-owned metadata edit commands land
- Phase 9g now makes CodexBridge use package-owned supervision as the
  authoritative recovery/discovery path for `/agent` dispatch:
  - bridge runtime startup and periodic sweeps now recover stale missions
    through `MissionSupervisor` instead of rewriting interrupted `AgentJob`
    projections back to `queued`/`stopped`
  - resumable `queued` / `verifying` / `repairing` missions are now selected
    from the package repository instead of only from bridge-local queued-job
    projections, so continuation no longer depends on `loop.sh`-style shell
    ownership
  - `AgentJob` remains a compatibility projection/cache, but it no longer
    decides which missions are eligible for continuation after recovery
- Phase 9h now adds package-owned authoritative read models on top of that
  runtime:
  - Mission Control query views now surface resolved workflow load state,
    checklist progress/current item, and rendered workpad/attempt status
    directly from package-owned mission state
  - CodexBridge `/agent show` now consumes those package views instead of
    loading `WORKFLOW.md` and reconstructing attempt/workpad status in bridge
    helpers
  - `/agent result` now prefers authoritative mission `resultText` before
    falling back to session/thread recovery paths, so bridge read behavior
    keeps moving toward package-owned runtime truth
- Phase 9i now hardens pristine source sync lineage on top of that source
  foundation:
  - package-owned `syncMissionSource` no longer destructively resets
    authoritative mission history for pristine `draft`/`queued` missions
  - repeated queued `/agent rename` or other pre-attempt source refreshes now
    supersede prior `ChecklistSnapshot` versions and append
    `mission.source_synced` audit events under the same mission/generation
    identity
  - the bridge therefore keeps package-owned source metadata refreshes without
    rewriting away earlier authoritative source-sync history
- Phase 9j now hardens the outward package boundary so later hosts do not have
  to inherit CodexBridge-only naming:
  - package-owned `commands / queries / host adapter` contracts now expose
    generic `hostSessionId` / `providerThreadId` fields
  - current `/agent` integration keeps `bridgeSessionId` / `codexThreadId`
    only as compatibility aliases while bridge-side storage and execution still
    use those names internally
  - the bridge can therefore keep migrating toward a host adapter/projection
    role without forcing future Telegram, CLI, or service wrappers to speak
    CodexBridge-specific field names at the package boundary
- Phase 9k now proves that later hosts can consume that same package contract
  without inheriting bridge runtime logic:
  - a package-only CLI/manual host proof now creates, runs, queries, and
    streams a mission through the generic `hostSessionId` /
    `providerThreadId` boundary plus `MissionHostAdapter`
  - the proof does not import CodexBridge runtime/store/i18n layers, so the
    same mission core behavior is now validated outside the `/agent`
    integration path
  - this later-host proof did not yet mean the first host UX was complete:
    CodexBridge still needed explicit prompt/checklist confirmation gates plus
    paused-state and loop-snapshot surfaces on top of the package contract
- Phase 9l now adds the first host-owned product start gates on top of that
  package contract:
  - Mission Control exports a package-owned `startMission` command plus
    concrete `awaiting_checklist_confirm` /
    `awaiting_prompt_confirm` states and workflow pending-approval payloads for
    the first autonomous cycle
  - CodexBridge `/agent confirm` now creates a drafted authoritative mission,
    walks the user through checklist confirmation and immutable-prompt
    confirmation, and only then queues the mission for supervision
  - `/agent show` now renders those package-backed start gates from mission
    detail instead of relying on bridge-local draft text after creation time
- Phase 9m now adds the first package-backed loop snapshot UX on top of those
  start gates:
  - Mission Control exports a normalized `loopSnapshot` read model plus
    `getMissionLoopSnapshot` / `streamMissionSnapshots` surfaces derived from
    authoritative supervision state instead of raw shell output
  - package summary/detail/execution views now carry current cycle, current
    stage, current checklist item, progress, overall completion, next step,
    latest blocker, and verifier summary through one host-neutral contract
  - CodexBridge `/agent show` now renders those package-backed loop fields
    directly from mission detail state, so the first host can inspect runtime
    progress without loading `WORKFLOW.md` or inspecting `loop.sh` output
- Phase 9n now adds the first host-side paused-state continuation flow on top
  of those package-backed detail views:
  - CodexBridge `/agent show` now surfaces the latest required user action plus
    an explicit `/agent confirm` continuation hint for paused
    `waiting_user` / `needs_human` / `handoff` / `blocked` missions
  - `/agent confirm` now routes those paused missions through package-owned
    `resumeMission`, preserving the active mission generation instead of
    forcing users onto `/agent retry` or raw shell-log inspection for simple
    continuation
- Phase 9o now adds the first explicit loop-budget terminal state on top of
  those package-backed runtime views:
  - Mission Control runtime now materializes `max_loops_reached` plus
    `mission.max_loops_reached` timeline events when `loopPolicy.maxCycles`
    would be exceeded before another autonomous cycle starts
  - package-backed loop snapshots therefore preserve loop-budget exhaustion as
    authoritative mission truth instead of collapsing it into bridge-local
    generic failure text
  - CodexBridge `/agent show` now renders that package-owned loop-budget state
    directly, while `/agent retry` remains the host-controlled way to open a
    fresh generation after that terminal budget stop
- Phase 9p now adds the first package-backed scope-change resolution flow on
  top of those package-owned mission views:
  - Mission Control exports `proposePlanChange` /
    `resolvePlanChange` commands plus a concrete `scope_change_pending` status
    and workflow pending-approval payload for unresolved checklist changes
  - approved plan changes now append a new authoritative
    `ChecklistSnapshot` version within the active mission generation, while
    rejected changes preserve the current checklist and re-queue the mission
  - CodexBridge `/agent show` now renders the latest proposed scope change
    directly from package detail state, and `/agent confirm [reject]` resolves
    that flow without bridge-local state mutation or shell-log inspection
- Phase 9q now adds the first package-backed paused approval/input resolution
  flow on top of those same mission views:
  - Mission Control exports a package-owned `submitApproval` command plus
    resume-time human-response payloads so paused missions can carry explicit
    approval decisions and attached human input back into authoritative mission
    state
  - CodexBridge `/agent show` now renders package-backed pending approval
    summaries plus approve/reject/input hints for paused
    `waiting_user` / `needs_human` / `handoff` / `blocked` missions instead of
    collapsing them into a generic resume-only prompt
  - `/agent confirm` can now route those paused missions through package-owned
    approval resolution or response-carrying resume flows, so the first host no
    longer needs shell-log inspection or an external `loop.sh` UX to keep a
    checklist-backed mission moving
- `/agent` `list/show/stop/retry` now consume that package API through an
  authoritative mission repository plus `AgentJob` projection instead of
  rebuilding runtime truth directly from bridge compatibility fields
- `/agent runAgentJob` now routes its current host-owned session/thread binding,
  progress, approval forwarding, and artifact-publication seams through that
  host adapter contract instead of wiring those concerns straight through the
  runner
- bridge-side provider/verifier progress on `/agent runAgentJob` now also
  persists through the package-owned progress sink so mission workpad/timeline
  state can retain bridge-delivered progress without letting the host mutate
  lifecycle truth directly
- the next hardening work is wiring broader source sync/reconciliation triggers
  beyond the current manual create path, append-oriented pristine pre-attempt
  sync path, and first local todo adapter; continuing to shrink `AgentJob`
  compatibility caches; and later deciding how much of provider-native in-turn
  approval reply handling should move from today’s host-owned live `/allow`
  flow into a future package-neutral control port without breaking the current
  host adapter boundary

## V0 Migration Baseline Sources

`/agent` already delegates into Mission Control. Its existing user-visible
contract should be treated as migration-protected while the boundaries are
cleaned up.

Current baseline sources:

- `/agent` semantic command contract:
  - `docs/command-skills/agent.md`
- `/agent` migration-protection tests:
  - `test/core/bridge_coordinator.test.ts`
    - `/agent drafts, confirms, runs, verifies, and records a background job`
    - `/agent stores generated attachments and can resend them`
    - `/agent show, retry, rename, stop, and delete manage queued jobs`
    - `/agent runAgentJob retries after an interrupted provider turn and completes on the next attempt`
    - `/agent runAgentJob forwards provider approval requests to the supplied approval callback`

Mission Control should preserve these contracts while replacing the runtime
behind `/agent`.

## Implementation Plan

Live phase/checklist status belongs to `docs/todo/mission-control.md`.
The architecture phases below should stay aligned with the implemented package
state instead of acting as a second stale TODO list.

Important clarification:

- the numbered slices below describe integration architecture and migration
  order
- they are **not** the authoritative current execution phase numbers for the
  loop
- current execution priorities remain the `Phase 7` / `Phase 8` / `Phase 9`
  backlog in `docs/todo/mission-control.md`
- if this document's older numbered slices and the TODO document ever seem to
  conflict, treat `docs/todo/mission-control.md` as the active execution
  source of truth

### Phase 0: Baseline current `/agent` behavior

- treat current `/agent` user-visible behavior as migration-protected
- keep the command-skill contract and bridge tests as the authoritative
  baseline while Mission Control grows underneath `/agent`
- do not change user-facing semantics just to make the runtime abstraction
  cleaner

### Phase 1: Add domain and persistence

- keep `packages/mission-control` as the internal TypeScript package boundary
- add durable mission domain types:
  - mission
  - mission generation
  - attempt
  - event
  - workpad
  - verifier proof
  - lease / pending approval state
- add explicit mission state transitions
- add a first local JSON-backed persistence implementation
- begin stripping authoritative runtime state out of `AgentJob`, leaving it as
  a compatibility projection
- make restart recovery and resumable-mission detection testable before adding
  provider execution

### Phase 2: Add workflow and workpad

- add `MissionWorkflowLoader` for `.codexbridge/mission/WORKFLOW.md`
- add `MissionWorkflowResolver` so workflow choice can vary by work-item type,
  source, and repo/risk context
- parse YAML front matter plus prompt body
- keep workflow policy outside slash-command handlers
- add a canonical mission-attempt prompt contract so prompt, orchestrator, and
  verifier stay separated
- persist workflow hashes and selection reasons per attempt/generation
- add package-local workpad status helpers that expose workflow source, summary,
  blocker, verifier notes, final result, and attempt history
- integrate those helpers into the existing host status surface only after the
  package-side contract is stable

### Phase 3: Add workspace isolation and recovery-safe leases

- add `MissionWorkspaceService`
- use dedicated workspace for code-changing missions
- keep read-only missions in bound cwd when safe
- add runner lease/lock records so restart recovery and concurrency are safe
- persist `workspacePath` and environment stamp
- add package-owned checkpoint records and stable workspace/log/artifact paths
- start converging external supervision behavior into package-owned runtime
  supervision instead of leaving it in shell-script-only control paths

### Phase 4: Codex provider adapter

- add the provider port and `CodexMissionProvider` as the first real provider
- persist provider run/thread identity at the attempt layer
- treat normal provider exit as eligible for bounded continuation when mission
  state and budget still allow more work

### Phase 5: Verification loop

- replace one-shot `/agent` execution with a bounded run / verify / repair loop
- persist verifier summaries, missing acceptance criteria, and retry-budget
  failures after every step
- make verifier verdicts, not provider `completed`, the completion authority
- expose mission history as a real timeline over generations, attempts, events,
  artifacts, and verifier proofs
- add restricted progress/workpad update paths for provider-side progress
  reporting without letting providers mutate authoritative lifecycle state
- absorb the useful operational pieces of `loop.sh` into Mission Control:
  status snapshots, stop markers, history logs, stale-run recovery, and bounded
  supervision semantics
- keep the tracked external loop prompt aligned with
  `docs/architecture/mission-control-loop-prompt.md` while that migration-era
  supervisor still exists

### Phase 6: CodexBridge integration

- keep CodexBridge WeChat as the first control and notification surface
- keep `/agent` as the Mission Control-backed host surface without introducing
  a separate `/mission` surface yet
- move host status/control reads to the package-owned query contract instead of
  primarily reading bridge-side compatibility projections
- thin CodexBridge toward a host-surface adapter that presents and controls
  missions instead of owning duplicated runtime state
- keep bridge-owned delivery, approval wording, and session-binding concerns on
  the host side
- reuse package-owned retry/resume semantics so waiting-human / handoff
  continuations preserve accumulated mission context instead of always resetting
  into a fresh rerun

### Phase 7: Service Exposure

- keep the package-owned `commands / queries / streams` contract
  transport-neutral
- use direct in-process function calls as the first implementation path
- only after the in-process API is stable, add a service wrapper
- prefer `Connect RPC` as the first network transport for
  command/query/stream exposure
- use one canonical request/response schema across function calls and service
  exposure
- add request ids, correlation ids, and idempotency handling at the boundary
- map mission event and snapshot subscriptions to server streaming first, with
  optional SSE/WebSocket adapters for browser-oriented host surfaces
- do not redesign Mission Control around REST resource semantics just to make
  service exposure look conventional
- if broader multi-language service consumption later requires it, expose a
  gRPC-compatible facade derived from the same contract rather than inventing a
  second runtime API

## Guardrails

- do not bypass CodexBridge SendGate for delivery
- do not let agent runs directly call WeChat APIs
- do not let workflow prompt edits silently change runtime permissions
- do not add a new `/mission` command until `/agent` can serve as Mission v0
  without confusing users
- do not let transport-specific route shapes or slash-command semantics leak
  back into the Mission Control package API
- do not rely on a long-lived external `loop.sh`-style supervisor as the
  primary runtime owner once package-owned supervision exists
- do not let providers or hosts write authoritative lifecycle state through
  progress-reporting shortcuts

## Practical Next Step

The immediate useful next step is to keep hardening the Mission Control package
boundary, not to jump to later providers or a web UI.

Current focus:

1. Keep `packages/mission-control` as the single owner of mission state,
   workflow policy, verifier authority, and retry/resume semantics.
2. Keep bridge integrations thin so `/agent` stays the Mission v0 surface
   instead of becoming the runtime owner again.
3. Improve future-host readiness through package-owned control helpers and
   adapter seams, while deferring GitHub/Linear sources, optional web UI, and
   later providers.
