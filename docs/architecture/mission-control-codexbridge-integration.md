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
- `/agent` `list/show/stop/retry` now consume that package API through an
  `AgentJob`-backed host adapter repository instead of rebuilding runtime truth
  directly from bridge compatibility fields
- the next hardening work is pushing the remaining read/control paths and
  `AgentJob` projection cleanup onto the same package-owned surface, so future
  Telegram, CLI, or web hosts do not re-implement bridge-local runtime logic

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
