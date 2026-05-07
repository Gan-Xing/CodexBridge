# @codexbridge/mission-control

Mission Control runtime package, currently developed inside the CodexBridge
repository.

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

- `phase-9j-host-neutral-contract`: package-owned mission
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
  CodexBridge migration.

This package should preserve the Symphony-style separation between:

- policy
- configuration
- coordination
- execution
- status surfaces

CodexBridge may depend on this package as its first host surface. This package
must not import from CodexBridge platform/runtime/store/i18n modules.
