# @codexbridge/mission-control

Mission Control runtime package, currently developed inside the CodexBridge
repository.

## Status

Development for this package is currently paused.

It remains in the repository as historical/internal reference material, but it
is not part of the active roadmap at this time.

Immutable target:

> `@codexbridge/mission-control` provides a durable, goal-driven runtime that
> can keep a mission moving through plan, execute, verify, repair/retry, and
> handoff states until the requested outcome is actually complete, explicitly
> blocked, or needs human input.

This package is intended to own only mission-runtime behavior:

- mission domain model
- mission state machine
- workflow loading
- workspace and lease coordination
- provider abstraction
- run / verify / repair / retry loop
- attempts, events, workpad, and runner state persistence
- stop plus retry/resume requeue control actions
- pending-approval and handoff state modeling
- host-adapter contracts for host-owned bindings, approvals, progress, and notifications

It must not own bridge behavior:

- WeChat or Telegram transports
- slash commands or i18n
- SendGate or platform rate limits
- bridge sessions or thread browsing UX
- approvals as chat wording or UI policy
- assistant records, uploads, or artifact delivery policy
- provider-native in-turn approval replies before a provider-neutral approval
  control port exists

Current phase:

- `phase-9v-checklist-refinement-gates`: package-owned mission
  domain/workflow/workspace/provider/verifier/runtime foundations, first-class
  `WorkItem` / `ChecklistSnapshot` / `PlanChangeRequest` /
  `MissionGeneration` lineage, direct in-process `commands / queries / streams`
  API contracts for `/agent`, a typed `CycleResult` loop protocol persisted on
  mission events, an explicit host-adapter contract for session/thread
  binding plus approval/artifact/notification handoff, a first
  `WorkItemSourceAdapter` contract, a package-owned create path that turns
  normalized manual source summaries into authoritative
  `WorkItem + Mission + Generation + ChecklistSnapshot` records, and a
  repository-backed progress sink that lets providers/hosts append workpad
  progress without mutating lifecycle truth. The package now also exports a
  first `MissionSupervisor` foundation that recovers stale leases, rebuilds
  status snapshots from authoritative repository state, runs supervisable
  missions until idle without requiring `loop.sh` to own runtime truth, and
  persists explicit mission stop requests that runtime/supervision consume at
  safe checkpoints instead of treating host-side stop UX as the source of
  lifecycle truth. Pristine `draft`/`queued` source-backed missions can now
  also be re-synced through the package command layer before the first attempt
  starts, so hosts such as CodexBridge no longer need to rewrite authoritative
  mission/work-item records directly just to keep queued source metadata in
  sync. Those pristine source refreshes now preserve append-oriented mission
  history by superseding prior checklist snapshot versions and appending
  `mission.source_synced` audit events instead of destructively resetting the
  authoritative aggregate. CodexBridge host runtimes now also use
  package-owned supervision for
  stale mission recovery and resumable `/agent` dispatch discovery, reducing
  `loop.sh` to an operational fallback instead of a structural runtime owner.
  Query read models now also surface authoritative workflow load status,
  checklist progress, and workpad/attempt status views so host surfaces such
  as `/agent show` can read those package-owned views instead of loading
  `WORKFLOW.md` or reconstructing mission state from compatibility fields.
  The outward-facing host-binding contract now also prefers generic
  `hostSessionId` / `providerThreadId` fields while keeping
  `bridgeSessionId` / `codexThreadId` as compatibility aliases during the
  CodexBridge migration. A package-only host-neutral proof now also exercises
  create/run/query/stream flows with a CLI-shaped host adapter using those
  generic bindings, so later hosts can consume the same mission core without
  requiring CodexBridge-specific runtime glue. The runtime now also emits
  package-backed host notifications after authoritative cycle updates, and the
  first host can proactively push those retry/continue loop snapshots without
  falling back to shell-owned progress UX. Package-owned loop budget
  exhaustion now also covers consecutive `maxNoProgressCycles` checks through
  persisted cycle history, so restart-safe repair loops can halt
  authoritatively before another autonomous cycle starts. Formal
  `plan[]` checklist items now also become the first-class progress surface
  when present: runtime prompt focus, checklist/read-model current item
  selection, cycle `overallCompletion`, and host-facing loop snapshots now
  advance against the confirmed checklist/TODO instead of implicitly leading
  with acceptance-only items. Bridge-side verifier results can now also persist
  authoritative per-cycle progress summaries, next steps, and blockers through
  package-owned cycle/workpad state. Verifier results can now also pause the
  runtime behind explicit `PlanChangeRequest` gates when the confirmed formal
  checklist needs a split / append / reorder / merge / drop / rename change,
  while workpad substeps stay progress-only and the per-attempt prompt now
  includes the confirmed `immutablePrompt` instead of dropping it before
  execution.

This package should preserve the Symphony-style separation between:

- policy
- configuration
- coordination
- execution
- status surfaces

CodexBridge may depend on this package as its first host surface. This package
must not import from CodexBridge platform/runtime/store/i18n modules.
