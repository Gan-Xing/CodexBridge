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

It must not own bridge behavior:

- WeChat or Telegram transports
- slash commands or i18n
- SendGate or platform rate limits
- bridge sessions or thread browsing UX
- approvals as chat wording or UI policy
- assistant records, automations, uploads, or artifact delivery policy
- provider-native in-turn approval replies before a provider-neutral approval
  control port exists

Current phase:

- `phase-6-codexbridge-integration`: package boundary plus durable mission
  domain, repository-backed persistence, typed workflow loading, canonical
  attempt prompt contract, workpad status rendering helpers, deterministic
  workspace assignment, recovery-safe lease coordination, provider port,
  `CodexMissionProvider` adapter shell, verifier/budget/repair-prompt
  primitives, package-owned retry/resume snapshot helpers, and a
  repository-backed bounded mission runtime that drives continuation,
  repair/retry, verifier authority, and stop/interrupt control, with
  CodexBridge `/agent` and scheduled `/auto` runs delegating into the same
  Mission Control runtime without introducing a separate `/mission` surface

This package should preserve the Symphony-style separation between:

- policy
- configuration
- coordination
- execution
- status surfaces

CodexBridge may depend on this package as its first host surface. This package
must not import from CodexBridge platform/runtime/store/i18n modules.
