# Mission Control

Mission Control is a general-purpose orchestration runtime for long-running
agent work.
It should turn user intent, schedules, and tracker items into observable Codex
work runs instead of treating every request as an isolated chat turn.
CodexBridge is the first embedding host and control surface, not the long-term
product boundary of the runtime itself.

This design follows the parts of OpenAI Symphony that fit a Codex-first runtime:

- a repository-owned workflow contract
- isolated workspaces for long-running work
- bounded background execution
- a persistent workpad for status and handoff
- explicit validation and retry policy
- chat-visible status instead of silent daemon behavior

Reference source:

- Upstream: `https://github.com/openai/symphony`
- Optional local mirror: `reference/symphony` if we need a git-ignored study copy

Reference stack to study and map into this design:

- `openai/symphony`
  - role: orchestration model reference
  - use for: orchestrator shape, isolated workspaces, bounded retries, status
    workpad, lifecycle hooks
- `openai/openai-agents-js`
  - role: OpenAI JS/TS agent primitive reference
  - use for: future `OpenAIAgentsMissionProvider`, tools/handoffs/sessions,
    provider adapter surface
- `langchain-ai/langgraphjs`
  - role: stateful graph runtime reference
  - use for: explicit durable state machine modeling, node/edge checkpoints,
    resumable execution ideas
- `inngest/inngest`
  - role: durable workflow runtime reference
  - use for: retry semantics, queued execution, step-level recovery, scheduled
    background work
- `dbos-inc/dbos-transact-ts`
  - role: database-backed workflow reference
  - use for: persistence-first execution, recovery after restart, lease/lock
    ideas, state ownership
- `mastra-ai/mastra`
  - role: TS AI application framework reference
  - use for: package organization, tool/runtime composition, agent-facing app
    ergonomics
- `VoltAgent/voltagent`
  - role: TS agent engineering platform reference
  - use for: engineering structure, workflow composition, runtime layering
- local `codex-mission-control` prototype copy
  - role: prior Codex-specific supervisor prototype
  - use for: bounded mission contract fields, tmux supervision, lease files,
    heartbeat recovery, checkpoint/workpad seed ideas

These projects are references only. Mission Control should not vendor their
runtime code blindly. The product goal is a provider-pluggable, goal-driven
runtime for agent-class executors, with Codex as the first concrete provider.

CodexBridge-specific control-surface mapping, migration constraints, and
rollout notes are tracked separately in
[`mission-control-codexbridge-integration.md`](./mission-control-codexbridge-integration.md).

## Product Goal

Mission Control should support host surfaces that let a user declare a coding
goal, tracker task, or other long-running objective and
receive a managed work item with:

- current status
- execution workspace
- attempt count
- plan and acceptance criteria
- latest result or blocker
- retry / stop / handoff controls
- final delivery through the host's normal delivery path

The operator should not need to understand Linear, GitHub, worktrees,
provider session protocols, or artifact manifests to operate the system.
Mission Control should remain reusable across chat, CLI, web, API, and future
host surfaces.

## What Symphony Contributes

Symphony is not copied as runtime code. It is used as an orchestration pattern.

Useful patterns:

- `WORKFLOW.md` front matter plus prompt body is the workflow contract.
- The orchestrator is a scheduler/runner, not the owner of business logic.
- Every work item gets an isolated workspace.
- The agent owns detailed ticket/workpad updates through tools.
- The runner owns concurrency, retries, cancellation, lifecycle hooks, and
  structured logs.
- A run can end at a handoff state, not necessarily final completion.

Patterns not copied directly:

- Linear-only issue polling as the only input source.
- Elixir/OTP implementation details.
- PR landing workflow as the only successful outcome.
- No rich UI. The runtime should be UI-agnostic; CodexBridge can remain the
  first chat-first status surface and may later add a web control plane.

## Symphony Essence To Preserve

Mission Control should learn the *operational shape* of Symphony, not just its
surface vocabulary.

The most important parts to preserve are:

1. Policy stays in-repo.
   - Runtime behavior comes from a repository-owned `WORKFLOW.md`, not from
     scattered hard-coded prompt strings and hidden service config.
   - The workflow file is both prompt contract and runtime policy contract.
2. The orchestrator is the authority for coordination, not business logic.
   - It decides dispatch, retries, continuation, stop, cancellation, and
     reconciliation.
   - It is not where ticket-editing, product decisions, or app-specific success
     logic should live.
3. There is one authoritative runtime state for active work.
   - Running missions, claimed missions, retry queue entries, session metadata,
     and aggregate runtime totals should have one owner.
   - Mission Control should not spread that ownership across chat handlers,
     background jobs, and ad hoc storage records.
4. Workspace identity is deterministic and durable.
   - A mission should map to one stable workspace identity that survives normal
     exits and retries.
   - Safety invariants around workspace root and cwd are mandatory, not
     optional polish.
5. Normal exit is not always final completion.
   - A provider run can end normally and still require continuation.
   - Retry policy must cover both failure retries and continuation retries.
6. Success can be a handoff state, not only a terminal done state.
   - For Mission Control, `needs_human`, `waiting_approval`, and similar
     mission outcomes should be first-class states, not awkward failures.
7. Status surfaces observe the orchestrator; they do not own execution.
   - WeChat, Telegram, CLI, and any future web page should expose state and
     controls, but not become the place where run ownership actually lives.

This is the real "Symphony DNA" Mission Control should inherit.

## What The `codex-mission-control` Prototype Contributes

The copied `codex-mission-control` project is useful as a prototype, not as the
final package shape.

Useful pieces to absorb:

- bounded mission contract fields such as objective, success criteria, and stop
  conditions
- file-backed `mission` / `session` / `lease` / `checkpoint` separation
- detached `tmux` runner supervision plus external heartbeat recovery
- explicit lease ownership so one mission cannot silently double-run
- managed prompt scaffolding that forces the running Codex session to report a
  terminal outcome

Pieces that should **not** define the final runtime:

- direct shelling to `codex resume` as the only provider model
- one-runner-per-resume-id as the core abstraction
- state rooted inside the package working tree instead of the bridge-owned data
  area
- no explicit verifier loop, no provider abstraction, and no multi-source
  mission model
- a package/product name that bakes `codex` into the long-term runtime identity

## Recommended Technical Route

The correct route is not "package Symphony into CodexBridge".

The route should be:

1. Use Symphony's SPEC and runtime shape to define:
   - orchestrator
   - workspace manager
   - retry policy
   - state machine
   - workpad lifecycle
   - continuation semantics after normal exit
   - handoff / waiting-user terminal and non-terminal states
2. Use `openai-agents-js` only for a future OpenAI-native provider adapter,
   not as the mission runtime itself.
3. Use current Codex app-server integration as the first real provider:
   `CodexMissionProvider`.
4. Use `LangGraph.js`, `Inngest`, and `DBOS` as references for durability,
   resumability, leases, and restart recovery.
5. Converge all of that into one provider-pluggable package:
   `@codexbridge/mission-control`.

One-sentence summary:

- Symphony answers: "how should long-running agent work be orchestrated?"
- Mission Control answers: "how do we productize that orchestration as a
  reusable runtime for Codex-class agents?"

## Required Layering

Mission Control should keep the same conceptual layering that makes Symphony
portable:

1. `Policy Layer`
   - `WORKFLOW.md` prompt body
   - mission-specific validation, repair, and handoff rules
2. `Configuration Layer`
   - typed config getters
   - defaults, env/path expansion, validation
3. `Coordination Layer`
   - mission orchestrator
   - runtime state owner
   - dispatch / retry / reconciliation / cancellation
4. `Execution Layer`
   - workspace manager
   - provider runner
   - verifier
   - lifecycle hooks
5. `Status Surface Layer`
   - chat adapters
   - CLI adapters
   - web adapters
   - API adapters

If Mission Control starts collapsing these layers back into command handlers or
platform runtime code, it is drifting away from Symphony's core value.

## Prompting Implications

Mission Control should not treat the prompt as the orchestrator.

The prompt should do these things:

- describe the bounded mission objective, scope, success criteria, and stop
  conditions
- expose current attempt/workpad context so Codex can continue coherent work
- teach the agent how to report a terminal outcome or handoff outcome
- encourage checkpoint/workpad updates after meaningful progress

The prompt should **not** do these things:

- decide retry budgets, concurrency, or lease behavior
- decide whether to continue after normal exit
- own mission lifecycle state transitions by itself
- replace verifier logic with "please judge if done" wording

In other words:

- prompt = per-attempt execution contract
- orchestrator = lifecycle authority
- verifier = completion authority

## Product Shape

Mission Control should be developed **inside** the CodexBridge repository first,
but it should still be treated as a package with a stable ownership boundary so
it can later serve non-CodexBridge control surfaces:

```text
packages/mission-control/
```

Target import direction:

```text
Host runtime (chat/CLI/web/API)
  -> Host integration layer
  -> @codexbridge/mission-control
```

The reverse dependency is not allowed:

```text
@codexbridge/mission-control
  -X-> CodexBridge platform/runtime/command modules
```

This means:

- `CodexBridge` may call Mission Control.
- Mission Control must not import host adapters, command parsers, delivery
  systems, i18n layers, or host session-storage internals.
- The first home can be a same-repo internal package; it does **not** need a
  workspace or multi-package release flow yet.
- The first embedding host may preserve its existing user-facing commands;
  package extraction is an implementation boundary, not a UX change.
- The long-term runtime target is broader than CodexBridge, even if the first
  host remains CodexBridge.

## Core Product Definition

Mission Control is not "a dashboard for Codex sessions". It is a
goal-driven execution runtime.

The target runtime experience is:

1. The user gives one goal.
2. Mission Control turns it into a bounded mission.
3. Codex keeps working on the mission through plan, execute, verify, and retry.
4. The run ends only when one of these is true:
   - acceptance criteria passed
   - retry/turn budget is exhausted
   - explicit human input is required
   - the user stops the mission

The system should therefore optimize for:

- durable progress instead of one-shot chat turns
- explicit verification instead of "looks done"
- resumability after restart or disconnect
- human-visible status and control
- provider-pluggable execution
- host/surface independence

## Target Architecture

### 1. Mission Source Layer

Mission sources normalize incoming work into the same domain model.

Initial control surfaces and sources:

- host-created manual missions
- assistant records: todos/reminders promoted to work
- local todo/checklist sources

Later surfaces and sources:

- GitHub issues
- Linear issues
- Notion tasks
- Google Drive / Docs task lists

These examples are illustrative, not a closed built-in list. The stable
contract is the source adapter boundary, not hard-coded vendor support inside
the runtime core.

Mission Control should expose a source abstraction instead of assuming one
chat-first input path.

Suggested port:

```ts
type WorkItemSourceSummary = {
  source: string;
  sourceRef: string;
  title: string;
  goal?: string | null;
  metadata?: Record<string, unknown>;
};

interface WorkItemSourceAdapter {
  createWorkItem(input: {
    title: string;
    goal?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<WorkItemSourceSummary>;
  getWorkItem(input: { sourceRef: string }): Promise<WorkItemSourceSummary | null>;
  listWorkItems(input?: {
    status?: string[];
    cursor?: string | null;
    limit?: number;
  }): Promise<{ items: WorkItemSourceSummary[]; nextCursor?: string | null }>;
  updateWorkItem(input: {
    sourceRef: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}
```

Source-layer rules:

- Mission Control must not assume that all work originates from one host command
- source adapters may be local or remote, but they must normalize into the same
  `WorkItem`/`Mission` creation flow
- source-specific fields should stay behind adapters; the core runtime should
  depend on normalized work-item semantics rather than vendor-specific payloads
- checklist ownership may live beside a work-item source, but runtime truth
  still belongs to Mission Control snapshots

### 2. Workflow Contract Layer

Mission Control should support a project-local workflow file:

```text
.codexbridge/mission/WORKFLOW.md
```

Recommended shape:

```md
---
workspace:
  root: ~/.codexbridge/mission/workspaces
agent:
  max_concurrent: 3
  max_turns: 8
  max_attempts: 2
codex:
  provider_profile: openai-default
  access_preset: full-access
  approval_policy: never
  sandbox_mode: danger-full-access
delivery:
  target: weixin
  final_only: false
---

You are running a Mission Control task.

Mission:
{{ mission.title }}

Goal:
{{ mission.goal }}

Acceptance Criteria:
{{ mission.acceptanceCriteria }}

Rules:
- Keep the mission workpad updated.
- Validate before reporting completion.
- If blocked, explain the blocker and required human action.
- Return final result through the configured host delivery path; do not bypass
  delivery controls.
```

If this file is missing, the host should use a built-in safe default. Invalid
YAML should not break normal host startup; it should block only mission runs
that depend on that workflow.

Workflow rules:

- `WORKFLOW.md` is a versioned contract, not an ad-hoc prompt scratch file
- the workflow contract must separate machine-readable config from prompt body
- built-in defaults must exist so Mission Control can still run without a
  project-local workflow
- host-specific delivery policy may be referenced, but host runtimes must not
  become embedded inside the workflow file

Minimum workflow schema expectations:

```ts
type MissionWorkflowConfig = {
  version: 1;
  workspace?: {
    root?: string;
    reuseBoundCwd?: boolean;
  };
  agent?: {
    maxConcurrent?: number;
    maxTurns?: number;
    maxAttempts?: number;
    maxCycles?: number | null;
    maxNoProgressCycles?: number | null;
  };
  provider?: {
    profile?: string;
    accessPreset?: string;
    approvalPolicy?: string;
    sandboxMode?: string;
  };
  checklist?: {
    requireUserConfirmation?: boolean;
    allowAutoApplyMinorChanges?: boolean;
  };
  delivery?: {
    target?: string;
    finalOnly?: boolean;
  };
};
```

Validation and versioning rules:

- the workflow front matter must carry an explicit `version`
- unknown top-level keys should surface a validation warning or error per
  strictness mode
- invalid workflow config should block mission execution, not whole bridge
  startup
- workflow changes do not retroactively mutate already-running missions; each
  mission attempt should record the workflow path and a workflow hash/digest
- built-in defaults must be deterministic and versioned alongside the package

Workflow selection and override rules:

- Mission Control should resolve a workflow by normalized work-item semantics,
  not only by a single global default
- workflow resolution may consider:
  - work-item type
  - work-item source
  - repo/workspace context
  - risk level
  - explicit mission override
- an explicit mission-level workflow override may replace resolver output only
  after validation
- workflow resolution precedence should be deterministic and persisted
- workflow choice for each attempt should be traceable through a workflow path
  plus digest/hash

Suggested port:

```ts
type MissionWorkflowSelection = {
  workflowPath: string | null;
  workflowHash: string | null;
  resolverReason: string;
};

interface MissionWorkflowResolver {
  resolve(input: {
    workItem: WorkItemSourceSummary | null;
    missionSource: string;
    riskLevel?: "low" | "medium" | "high";
    cwd?: string | null;
    explicitWorkflowPath?: string | null;
  }): Promise<MissionWorkflowSelection>;
}
```

Checklist schema expectations:

- every formal checklist item must have a stable id
- every formal checklist item must declare explicit `doneCriteria`
- checklist snapshots must be hashable and versioned
- checklist providers may render different editing formats, but the normalized
  in-runtime schema must stay the same

Phase 2 foundations inside `packages/mission-control` should provide:

- `MissionWorkflowLoader`
  - resolves explicit path, env override, or workspace/cwd default
  - returns built-in defaults when the file is missing
  - surfaces a typed workflow validation error when config is invalid
- a canonical mission-attempt prompt contract renderer
  - keeps prompt responsibility separate from orchestrator/verifier authority
- workpad status rendering helpers
  - expose workflow source, summary, blocker, verifier notes, final result
  - expose compact attempt history for future host status integrations

### 3. Mission Model

`AgentJob` can remain the v0 host-side compatibility record, but the target
Mission Control domain must be defined independently of bridge-local job
records, chat threads, or provider session ids.

The core domain objects are:

- `WorkItem`: the business object to be completed
- `Mission`: the durable runtime object that drives one fixed goal
- `Checklist`: the user-confirmed task list for that mission
- `ChecklistSnapshot`: the immutable in-runtime copy of a checklist version
- `ChecklistItem`: the smallest completion unit
- `Attempt`: one execution attempt/cycle
- `Event`: append-oriented timeline/audit record
- `Workpad`: current working summary, not the canonical checklist
- `PlanChangeRequest`: AI-proposed checklist change that may require approval
- `CycleResult`: the structured result returned after each loop iteration

#### `WorkItem`

`WorkItem` is the "thing to be done". It is not a single execution attempt and
not a chat thread.

Examples:

- a manually created coding goal
- a local todo entry
- a GitHub issue
- a Linear issue
- a kanban or task-board card

`WorkItem` may outlive a single `Mission`; a fresh rerun can create a new
mission generation without changing the underlying work item identity.

Mission Control should therefore be work-item-centered, not prompt-centered. A
single prompt/run may create or advance a mission, but durable progress should
be tracked against the underlying work item over time.

#### `Mission`

`Mission` is the durable orchestrated execution object. It owns runtime state,
loop policy, workspace assignment, attempts, and final completion authority.

A `Mission` is anchored to `workItemId`. Host chat threads, provider threads,
and host sessions are execution bindings and control-surface references, not
the primary identity of the task itself.

The mission must keep these fields immutable after confirmation:

- `immutableGoal`
- `immutablePrompt`

The mission must not embed the entire mutable checklist body as its primary
source of truth. Instead it stores:

- a checklist reference to the external collaboration source
- the currently active internal checklist snapshot version
- a digest/hash for audit and replay safety

Suggested shape:

```ts
type MissionStatus =
  | "drafting"
  | "awaiting_checklist_confirm"
  | "awaiting_prompt_confirm"
  | "ready"
  | "queued"
  | "planning"
  | "running"
  | "verifying"
  | "repairing"
  | "waiting_user"
  | "needs_human"
  | "scope_change_pending"
  | "blocked"
  | "max_loops_reached"
  | "completed"
  | "failed"
  | "stopped"
  | "archived";

type MissionSource =
  | "manual"
  | "weixin"
  | "telegram"
  | "assistant-record"
  | "github"
  | "linear"
  | "local-todo"
  | "kanban";

type Mission = {
  id: string;
  workItemId: string;
  source: MissionSource;
  sourceRef?: string;
  platform: string;
  externalScopeId: string;
  title: string;
  immutableGoal: string;
  immutablePrompt: string;
  promptHash: string;
  promptConfirmedAt: number;
  promptConfirmedBy: string;
  expectedOutput: string;
  acceptanceRule: string | null;
  checklistRef: string;
  checklistProvider: "markdown" | "local-todo" | "kanban" | "github" | "linear";
  activeChecklistVersionId: string;
  activeChecklistHash: string;
  status: MissionStatus;
  priority: "low" | "normal" | "high";
  riskLevel: "low" | "medium" | "high";
  cwd: string | null;
  workspacePath: string | null;
  workflowPath: string | null;
  providerProfileId: string;
  bridgeSessionId: string | null;
  codexThreadId: string | null;
  currentGenerationId: string;
  currentCycle: number;
  currentItemId: string | null;
  attemptCount: number;
  maxAttempts: number;
  maxTurns: number;
  maxCycles: number | null;
  maxNoProgressCycles: number | null;
  lastRunAt: number | null;
  completedAt: number | null;
  stoppedAt: number | null;
  lastResultPreview: string | null;
  resultText: string | null;
  resultArtifacts: unknown[];
  lastError: string | null;
  latestVerifierSummary: string | null;
  latestBlocker: string | null;
  nextStep: string | null;
  overallCompletion: number | null;
  workpad: MissionWorkpad;
  createdAt: number;
  updatedAt: number;
};
```

#### `Checklist` and `ChecklistSnapshot`

`Checklist` is the user-confirmed todo/checklist for the mission. It is the
formal completion basis. Each item must be individually judgeable.

Best-practice storage model:

- external checklist source: the collaboration truth source users edit
- internal checklist snapshot: the version Mission Control actually runs

Mission Control should not trust a mutable external markdown file or online
board at replay time. It must capture a versioned immutable snapshot every time
an approved checklist changes.

Suggested snapshot shape:

```ts
type ChecklistSnapshot = {
  id: string;
  missionId: string;
  version: number;
  sourceRef: string;
  sourceRevision: string | null;
  hash: string;
  createdAt: number;
  createdBy: string;
  changeReason: string | null;
  items: ChecklistItem[];
};
```

Each `ChecklistItem` is the minimum completion unit:

```ts
type ChecklistItemStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "dropped";

type ChecklistItem = {
  id: string;
  stableKey: string;
  title: string;
  doneCriteria: string[];
  status: ChecklistItemStatus;
  dependsOn: string[];
  notes: string[];
  evidenceRefs: string[];
};
```

Checklist editing rules:

- initial checklist version must be user-confirmed before mission start
- AI may refine internal substeps in the workpad without changing the formal
  checklist
- formal checklist changes should create a `PlanChangeRequest`
- approved changes create a new `ChecklistSnapshot`

```ts
type PlanChangeRequest = {
  id: string;
  missionId: string;
  baseChecklistVersionId: string;
  proposedChecklistVersionId: string;
  reason: string;
  proposedBy: "ai" | "user" | "system";
  status: "pending" | "approved" | "rejected" | "auto-applied";
  createdAt: number;
  resolvedAt: number | null;
};
```

`MissionGeneration` preserves rerun lineage without overwriting prior history:

```ts
type MissionGeneration = {
  id: string;
  missionId: string;
  index: number;
  reason: "initial" | "retry" | "resume" | "manual-rerun" | "system-recovery";
  createdAt: number;
};
```

Mission alone is not enough. The persisted runtime should also track:

```ts
type MissionArtifactRef = {
  id: string;
  missionId: string;
  attemptId: string | null;
  checklistItemId: string | null;
  type: string;
  name?: string;
  path?: string;
  uri?: string;
  createdAt: number;
};

type MissionVerifierProof = {
  id: string;
  missionId: string;
  attemptId: string | null;
  checklistItemId: string | null;
  verdict: string;
  summary: string;
  criteria: Array<{
    criterion: string;
    pass: boolean;
    reason: string | null;
  }>;
  evidence: Record<string, unknown>;
  createdAt: number;
};

type MissionAttempt = {
  id: string;
  missionId: string;
  generationId: string;
  checklistVersionId: string;
  checklistItemId: string | null;
  index: number;
  cycle: number;
  status:
    | "queued"
    | "running"
    | "verifying"
    | "repairing"
    | "completed"
    | "failed"
    | "blocked"
    | "waiting_user"
    | "needs_human"
    | "stopped";
  providerRunId: string | null;
  providerThreadId: string | null;
  renderedPromptHash: string | null;
  startedAt: number | null;
  endedAt: number | null;
  verifierVerdict:
    | "complete"
    | "repair"
    | "blocked"
    | "waiting_user"
    | "needs_human"
    | "handoff"
    | "failed"
    | null;
  verifierSummary: string | null;
  verifierProofId: string | null;
  outputPreview: string | null;
  error: string | null;
};

type MissionEvent = {
  id: string;
  missionId: string;
  attemptId: string | null;
  checklistItemId: string | null;
  kind:
    | "mission.created"
    | "mission.ready"
    | "mission.queued"
    | "mission.planned"
    | "mission.started"
    | "mission.progress"
    | "mission.verifying"
    | "mission.retrying"
    | "mission.waiting_user"
    | "mission.needs_human"
    | "mission.handoff"
    | "mission.scope_change_pending"
    | "mission.blocked"
    | "mission.max_loops_reached"
    | "mission.completed"
    | "mission.failed"
    | "mission.stopped"
    | "checklist.snapshot.created"
    | "plan_change.requested"
    | "plan_change.approved"
    | "plan_change.rejected";
  payload: Record<string, unknown>;
  createdAt: number;
};
```

`CycleResult` is the structured return object Mission Control expects after each
loop iteration. This plays the same role that `LOOP_STATUS`/`LOOP_REASON`
fields play in the current `loop.sh`, but as a typed runtime protocol instead
of shell-parsed text:

```ts
type CycleResult = {
  schemaVersion: "mission-cycle/v1";
  cycle: number;
  status:
    | "continue"
    | "retry"
    | "waiting_user"
    | "needs_human"
    | "handoff"
    | "done"
    | "blocked"
    | "failed"
    | "stopped";
  stage: string;
  progress: string;
  overallCompletion: number | null;
  nextStep: string | null;
  activeItemId: string | null;
  activeItemStatus: ChecklistItemStatus | null;
  checklistVersion: number;
  verifierSummary: string | null;
  blocker: string | null;
  needUserAction: string | null;
  planChangeSuggestion: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
  audit: {
    attemptId: string;
    eventSeq: number;
    updatedAt: string;
  };
};
```

### Mission State Machine

The state machine must be explicit. Long-running behavior should never be
hidden inside ad-hoc retries.

```text
drafting
  -> awaiting_checklist_confirm
  -> awaiting_prompt_confirm
  -> ready
  -> queued
  -> planning
  -> running
  -> verifying
    -> completed
    -> repairing -> running
    -> waiting_user
    -> needs_human
    -> scope_change_pending
    -> blocked
    -> failed
running/verifying/repairing
  -> stopped
running/verifying/repairing
  -> max_loops_reached
completed/failed/stopped/max_loops_reached
  -> archived
```

Required transition rules:

- `drafting -> awaiting_checklist_confirm`: initial checklist exists but is not
  user-confirmed yet
- `awaiting_checklist_confirm -> awaiting_prompt_confirm`: checklist is
  confirmed and prompt still needs user confirmation
- `awaiting_prompt_confirm -> ready`: immutable prompt is confirmed
- `ready -> queued`: mission can enter the orchestrated loop
- `queued -> planning`: workflow and prompt can be rendered
- `planning -> running`: workspace and provider context are ready
- `running -> verifying`: provider returned a candidate result
- `verifying -> planning`: current cycle is accepted and the mission should
  continue into another loop iteration with updated context or the next
  checklist item
- `verifying -> repairing`: verifier says the goal is not complete but can be
  fixed within budget
- `verifying -> waiting_user`: verifier needs user input before the current
  checklist item can continue
- `verifying -> needs_human`: verifier decides the mission needs explicit human
  intervention
- `verifying -> needs_human` with handoff metadata: verifier requires explicit
  transfer to a human or another execution surface
- `verifying -> scope_change_pending`: AI requested a formal checklist change
  beyond auto-apply policy
- `verifying -> blocked`: verifier requires human input or missing permission
- `verifying -> failed`: retry/turn/time budget is exhausted or verifier marks
  unrecoverable failure
- `blocked/waiting_user/needs_human -> running`: human approves or supplies the
  missing input
- `scope_change_pending -> planning`: a new checklist snapshot is approved and
  activated
- `running/verifying/repairing -> max_loops_reached`: loop policy forbids more
  cycles
- `running/verifying/repairing -> stopped`: explicit user stop

Definition of done:

- "Mission completed" means every active checklist item is completed **and**
  the immutable mission goal passes final verification.
- "Mission produced text" is **not** enough.
- "Mission stopped without failure" must be represented as `stopped`, not
  `completed`.

### Mission Control Outcomes

The spec must distinguish between:

- stable mission states persisted on the mission record
- verifier/control outcomes returned after a cycle
- host-facing labels shown in chat or web UI

`continue`, `retry`, `handoff`, and `done` are control outcomes. They are not
all mission states.

Outcome rules:

- `continue`: the latest cycle made enough progress to keep going without human
  intervention. The mission should usually transition `verifying -> planning`,
  then run another cycle. This can mean:
  - the current checklist item still needs another execution pass, or
  - the current checklist item is done and the next incomplete item should
    start
- `retry`: the latest cycle did not satisfy the active checklist item, but the
  verifier believes another bounded attempt can repair it. The mission should
  transition `verifying -> repairing -> running` or `verifying -> repairing ->
  planning`, depending on whether prompt re-rendering is needed.
- `waiting_user`: the origin user must answer a concrete question or supply a
  missing input before the same mission can proceed. This is a stable mission
  state.
- `needs_human`: a human operator, approver, or domain expert must intervene.
  This is a stable mission state and is broader than `waiting_user`.
- `handoff`: a special verifier/control outcome meaning the mission should be
  explicitly transferred out of the current autonomous loop. `handoff` should
  emit a `mission.handoff` event and usually persist the mission in
  `needs_human`, unless policy maps it to another paused state.
- `done`: not a standalone mission status. It means the active checklist item
  is complete, every remaining checklist item is also complete, and the
  immutable mission goal passes final verification. Only then should the
  mission enter `completed`.

Recommended normalization:

```ts
type MissionControlOutcome =
  | "continue"
  | "retry"
  | "waiting_user"
  | "needs_human"
  | "handoff"
  | "done"
  | "blocked"
  | "failed"
  | "stopped";
```

Recommended outcome-to-state mapping:

- `continue` -> `planning`
- `retry` -> `repairing`
- `waiting_user` -> `waiting_user`
- `needs_human` -> `needs_human`
- `handoff` -> `needs_human` plus `mission.handoff` event
- `done` -> `completed` only after whole-mission completion rules pass
- `blocked` -> `blocked`
- `failed` -> `failed`
- `stopped` -> `stopped`

Lifecycle authority rule:

- the orchestrator is the single owner of retry, continuation, stop,
  concurrency, budget, and recovery state
- providers may suggest outcomes, and hosts may cache summaries, but neither
  may own conflicting lifecycle truth or budget counters
- duplicated host-side retry/stop/resume state should be treated as migration
  debt, not permanent architecture

### 4. Workspace Manager

Long-running missions should not run directly in an arbitrary current working
directory unless the user explicitly wants that.

Default layout:

```text
~/.codexbridge/mission/
  workflows/
  workspaces/
    <missionId>/
  artifacts/
    <missionId>/
  checkpoints/
    <missionId>/
  env/
    <missionId>.json
  logs/
    <missionId>.jsonl
```

Rules:

- Code-changing missions should use a dedicated workspace.
- Read-only research and writing missions may reuse the bound session cwd.
- Workspace lifecycle hooks should come from `WORKFLOW.md`.
- A mission must never write outside its workspace except approved artifact and
  log directories.
- workspace paths must be stable across normal continuation and restart
- environment stamp metadata should be persisted so operators can understand the
  execution context that produced an attempt
- checkpoints should capture recoverable runtime metadata, not just raw process
  output

Suggested persisted metadata:

```ts
type MissionEnvironmentStamp = {
  cwd: string | null;
  workspacePath: string | null;
  gitSha: string | null;
  gitBranch: string | null;
  workflowHash: string | null;
  providerProfileId: string | null;
  capturedAt: number;
};

type MissionCheckpoint = {
  id: string;
  missionId: string;
  attemptId: string | null;
  generationId: string;
  cycle: number;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: number;
};
```

### 4.4 Continuation and Checkpointing

Mission Control must treat normal provider exit as a recoverable execution
moment, not automatically as terminal completion.

Continuation rules:

- a provider run may end normally while the mission still requires more work
- continuation should resume from persisted mission state plus the latest
  checkpoint/workpad context
- "continue after normal exit" is a first-class lifecycle path, not a patch
  around missing state
- checkpoints should be written at meaningful boundaries so restart/retry logic
  does not depend on replaying the entire host conversation

### 4.5 Provider Boundary

Mission Control should own a provider abstraction instead of hard-coding Codex
runtime details into the runner.

Initial provider:

- `CodexMissionProvider`: wraps current Codex app-server / provider-profile flow

Later providers:

- `OpenAIAgentsMissionProvider`
- future OpenAI-compatible task providers if they can support long-running
  execution semantics

Suggested port:

```ts
type MissionProviderStartResult = {
  providerRunId: string;
  providerThreadId: string | null;
  previewText?: string | null;
};

type MissionProviderResult = {
  status: "completed" | "blocked" | "failed" | "stopped";
  text: string | null;
  artifacts: Array<{ type: string; name?: string; path?: string; uri?: string }>;
  requiresHuman?: boolean;
  stopReason?: string | null;
};

interface MissionProvider {
  start(input: MissionExecutionInput): Promise<MissionProviderStartResult>;
  continue(input: MissionExecutionInput): Promise<MissionProviderStartResult>;
  wait(runId: string, options?: { timeoutMs?: number }): Promise<MissionProviderResult>;
  interrupt(runId: string): Promise<void>;
}
```

Rules:

- Mission Control decides *when* to run or retry.
- The provider decides *how* a single execution attempt is performed.
- Provider adapters must not own mission state transitions.

### 4.6 Host Adapter Boundary

Mission Control must also depend on a host adapter instead of reaching directly
into CodexBridge session, notification, or approval services.

The host adapter owns host-surface integration only:

- session/thread binding
- approval and identity collection
- artifact publication
- status notifications
- host auth/context lookup

Suggested port:

```ts
type MissionHostContext = {
  platform: string;
  externalScopeId: string;
  bridgeSessionId: string | null;
  actorId: string | null;
  actorDisplayName: string | null;
  authContext: Record<string, unknown> | null;
};

type MissionNotification = {
  missionId: string;
  status: string;
  summary: string;
  details?: Record<string, unknown>;
};

type MissionApprovalRequest = {
  missionId: string;
  attemptId: string | null;
  reason: string;
  kind: "permission" | "scope_change" | "input_request" | "handoff";
  payload?: Record<string, unknown>;
};

interface MissionHostAdapter {
  getContext(missionId: string): Promise<MissionHostContext>;
  bindProviderThread(input: {
    missionId: string;
    providerThreadId: string | null;
  }): Promise<void>;
  requestApproval(input: MissionApprovalRequest): Promise<{ approvalId: string }>;
  waitForApproval(input: {
    approvalId: string;
    timeoutMs?: number;
  }): Promise<"approved" | "rejected" | "timeout">;
  publishArtifacts(input: {
    missionId: string;
    attemptId: string | null;
    artifacts: Array<{ type: string; name?: string; path?: string; uri?: string }>;
  }): Promise<void>;
  notify(input: MissionNotification): Promise<void>;
}
```

Host adapter rules:

- the host adapter does not own mission state transitions
- the host adapter may enrich identity/auth context, but that context becomes
  input to Mission Control rather than hidden host-local state
- host adapters may fail independently; Mission Control must persist mission
  truth before attempting host notifications
- CodexBridge may be the first host adapter, but it must remain a consumer of
  Mission Control rather than the runtime itself

### 4.7 Host Surface Adapters

Host surfaces such as chat, CLI, web, or mobile control planes should be thin
adapters over Mission Control capabilities.

Surface-adapter rules:

- host surfaces own presentation, navigation, and operator interaction
- host surfaces may translate mission data into slash commands, web actions, or
  mobile UI, but they must not redefine mission lifecycle rules
- host surfaces should prefer package-owned queries, streams, and bindings over
  reconstructing mission truth from host-local state

### 5. Workpad

Each mission needs a single persistent workpad. This is the equivalent of
Symphony's issue comment, adapted first for CodexBridge chat surfaces and later
for other hosts.

The workpad is not:

- the formal checklist source of truth
- the event log
- the final result archive

The workpad is the current working summary. It should store:

- environment stamp: host, workspace, git SHA
- current status
- current checklist item summary
- internal execution substeps
- latest notes
- blockers
- latest verifier summary
- final result summary

Rendering rules:

- host surfaces should be able to render a compact workpad view
- host surfaces should be able to retrieve final result text separately from
  the live workpad
- host surfaces may offer full result export as a file or attachment
- host delivery should default to concise progress and final summaries, not the
  entire workpad unless explicitly requested

Agent/provider progress updates should be structured and restricted.

Suggested port:

```ts
type MissionProgressUpdate = {
  missionId: string;
  attemptId: string | null;
  checklistItemId: string | null;
  kind: "summary" | "substep" | "blocker" | "note" | "artifact";
  message: string;
  metadata?: Record<string, unknown>;
};

interface MissionProgressSink {
  appendProgress(update: MissionProgressUpdate): Promise<void>;
}
```

Progress-update rules:

- agents/providers may append progress and workpad updates
- agents/providers must not directly mutate authoritative mission status,
  checklist snapshots, or final verifier truth through the progress API
- progress updates should enrich observability, not bypass orchestrator
  authority

### 5.5 Verification Contract

To support "keep working until it is actually done", Mission Control needs a
first-class verification step.

Verification input should include:

- immutable mission goal
- immutable prompt contract if relevant
- active checklist snapshot version
- active checklist item and its done criteria
- latest provider result
- latest artifacts
- workspace context if relevant
- previous verifier feedback

Verification output should be normalized to:

```ts
type MissionVerification = {
  verdict:
    | "complete"
    | "repair"
    | "blocked"
    | "waiting_user"
    | "needs_human"
    | "handoff"
    | "failed";
  summary: string;
  repairPrompt?: string | null;
  missingCriteria?: string[];
  requiresHumanReason?: string | null;
};
```

The AI-facing item judgment must be explicit and structured. The verifier is
responsible for judging whether the active checklist item is complete and why.

Recommended normalized item-level verdict:

```ts
type MissionItemVerdict = {
  itemId: string | null;
  checklistVersionId: string;
  decision:
    | "complete"
    | "incomplete"
    | "blocked"
    | "waiting_user"
    | "needs_human"
    | "handoff"
    | "failed";
  summary: string;
  criteria: Array<{
    criterion: string;
    pass: boolean;
    reason: string | null;
  }>;
  nextActionHint:
    | "continue"
    | "retry"
    | "waiting_user"
    | "needs_human"
    | "handoff"
    | "fail";
  blocker: string | null;
  needUserAction: string | null;
  planChangeSuggestion: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
};
```

Judgment rules:

- AI must judge the active checklist item against declared `doneCriteria`, not
  against vague overall intent
- every `doneCriteria` line should be explicitly marked pass/fail/unknown in the
  structured verdict
- "some code was written" is not enough to mark an item complete
- if the active item is complete but later items remain, the verdict should
  imply `continue`, not mission completion
- if the AI believes the formal checklist itself is wrong or incomplete, it
  should emit `planChangeSuggestion` rather than silently mutating the active
  checklist

Orchestrator decision rules:

- `decision=complete` and remaining checklist items exist -> advance item and
  continue the mission loop
- `decision=complete` and no checklist items remain -> run final mission-level
  verification before entering `completed`
- `decision=incomplete` with `nextActionHint=retry` -> bounded repair/retry path
- `decision=waiting_user` -> persist `waiting_user` and request host/user action
- `decision=needs_human` -> persist `needs_human`
- `decision=handoff` -> emit handoff event and persist paused human-owned state
- `decision=blocked` -> persist `blocked`
- `decision=failed` -> persist `failed`

Mission Control, not the AI, is the final authority on transition legality,
budget enforcement, loop limits, and whether a mission is truly done.

The verifier can initially be implemented with:

- Codex-native review/result checks for code-changing runs
- simple rule checks for reporting or read-only missions
- bridge-owned hard guards for missing files, missing artifacts, or known
  incomplete outputs

The verifier must judge completion at the checklist-item level first. Mission
completion is a second-layer decision made only after the active checklist item
and then the whole checklist are complete.

The verifier must be persisted. A restart must not forget why the mission was
being repaired or blocked.

### 5.6 Persistence and Recovery

Mission Control should be safe to restart.

Minimum persisted units:

- immutable mission goal and immutable prompt
- checklist source reference
- checklist snapshots
- missions
- attempts
- event log
- workpad snapshots
- plan change requests
- workspace metadata
- pending approvals / blockers
- active runner lease

Authoritative persisted objects:

- `work_items`
- `missions`
- `mission_generations`
- `checklist_snapshots`
- `plan_change_requests`
- `attempts`
- `events`
- `workpad_snapshots`
- `verifier_proofs`
- `artifacts` metadata
- `approvals`
- `runner_leases`

Projection/cache objects that may be rebuilt:

- host-side `AgentJob` summary projections or other host-owned summary caches
- compact status cards
- rendered workpad previews
- denormalized counters such as attempt totals or latest status labels
- thread/session index caches derived from authoritative mission bindings

Persistence rules:

- event/timeline history should be append-oriented and not silently discarded on
  rerun
- a fresh rerun should create a new mission generation or equivalent lineage, not
  overwrite prior attempt/event history
- external checklist sources are collaboration surfaces, not sufficient replay
  state by themselves
- every running or completed attempt must record the checklist snapshot version,
  workflow digest, and rendered prompt hash used for that cycle
- projections may be dropped and rebuilt; authoritative records may not depend
  on projections for correctness
- timeline/history views should be derivable from authoritative mission,
  generation, attempt, event, artifact, and verifier-proof records

Recovery rules:

- `queued`, `planning`, and lease-expired `running` missions should be
  re-enqueued on startup
- `verifying` and `repairing` missions should resume from persisted attempt
  state instead of starting over
- `blocked` missions should remain blocked until explicit human action
- duplicate concurrent runners must be prevented with a lease/lock record

### 5.6.4 Supervision Model

Mission Control should absorb the useful supervision properties currently
demonstrated by `loop.sh`, but as first-class runtime behavior rather than a
long-term external shell-script dependency.

Required supervision capabilities:

- bounded loop/cycle execution with explicit loop counters
- persisted status snapshots after each meaningful cycle transition
- exclusive runner ownership through a lease/lock
- explicit stop signal/marker semantics
- append-oriented history and status log retention
- stale-run detection and restart recovery

Recommended runtime behaviors:

- every cycle should update a machine-readable mission snapshot
- missions should be stoppable through a persisted stop request instead of
  best-effort process signaling alone
- stale leases or interrupted runs should be detectable and recoverable without
  losing mission history
- operator-visible status should come from runtime state, not only from
  inspecting external shell logs

Temporary external supervisor scripts may still exist as migration tooling or
operational fallback, but the target architecture is for Mission Control itself
to own supervision, recovery, and observability semantics.

### 5.6.5 Interface Contract

Mission Control should expose the same conceptual API whether used by direct
function calls or later wrapped by `Connect RPC`.

API groups:

- `commands`: create/change/control mission execution
- `queries`: fetch current and historical state
- `streams`: subscribe to status/events

Suggested command surface:

```ts
type MissionRequestMeta = {
  requestId?: string | null;
  correlationId?: string | null;
  idempotencyKey?: string | null;
};

type CreateMissionRequest = {
  meta?: MissionRequestMeta;
  workItemId?: string | null;
  source: string;
  sourceRef?: string | null;
  title: string;
  immutableGoal: string;
  immutablePrompt: string;
  checklistRef: string;
  checklistProvider: string;
  initialChecklistVersionId: string;
  loopPolicy?: {
    maxAttempts?: number | null;
    maxTurns?: number | null;
    maxCycles?: number | null;
    maxNoProgressCycles?: number | null;
  };
  actor?: {
    id?: string | null;
    displayName?: string | null;
  };
};

type MissionCommandResponse = {
  missionId: string;
  status: string;
  accepted: boolean;
  correlationId?: string | null;
};

interface MissionCommands {
  createMission(input: CreateMissionRequest): Promise<MissionCommandResponse>;
  startMission(input: { missionId: string }): Promise<MissionCommandResponse>;
  stopMission(input: { missionId: string; reason?: string }): Promise<MissionCommandResponse>;
  retryMission(input: { missionId: string; reason?: string }): Promise<MissionCommandResponse>;
  resumeMission(input: { missionId: string; reason?: string }): Promise<MissionCommandResponse>;
  submitApproval(input: {
    missionId: string;
    approvalId: string;
    decision: "approved" | "rejected";
  }): Promise<MissionCommandResponse>;
  applyPlanChange(input: {
    missionId: string;
    changeRequestId: string;
    decision: "approved" | "rejected";
  }): Promise<MissionCommandResponse>;
}
```

Suggested query surface:

```ts
type MissionSummary = {
  missionId: string;
  title: string;
  status: string;
  currentCycle: number;
  currentItemId: string | null;
  overallCompletion: number | null;
  updatedAt: string;
};

interface MissionQueries {
  getMission(input: { missionId: string }): Promise<Mission>;
  listMissions(input?: {
    status?: string[];
    source?: string[];
    limit?: number;
    cursor?: string | null;
  }): Promise<{ items: MissionSummary[]; nextCursor?: string | null }>;
  getMissionBundle(input: { missionId: string }): Promise<{
    mission: Mission;
    activeChecklistSnapshot: ChecklistSnapshot | null;
    latestWorkpad: MissionWorkpad | null;
    latestAttempt: MissionAttempt | null;
  }>;
  getMissionTimelineView(input: { missionId: string }): Promise<{
    mission: Mission;
    generations: MissionGeneration[];
    attempts: MissionAttempt[];
    events: MissionEvent[];
    artifacts: MissionArtifactRef[];
    verifierProofs: MissionVerifierProof[];
  }>;
  getMissionTimeline(input: {
    missionId: string;
    afterSeq?: number | null;
  }): Promise<MissionEvent[]>;
  getMissionExecutionRefs(input: { missionId: string }): Promise<{
    missionId: string;
    platform: string;
    externalScopeId: string;
    hostSessionId: string | null;
    providerThreadId: string | null;
    latestProviderRunId: string | null;
    artifactRefs: Array<{ type: string; name?: string; path?: string; uri?: string }>;
  }>;
  listAttempts(input: { missionId: string }): Promise<MissionAttempt[]>;
  listEvents(input: { missionId: string; afterSeq?: number | null }): Promise<MissionEvent[]>;
  listPlanChangeRequests(input: { missionId: string }): Promise<PlanChangeRequest[]>;
}
```

Suggested stream surface:

```ts
interface MissionStreams {
  streamMissionEvents(input: {
    missionId: string;
    afterSeq?: number | null;
  }): AsyncIterable<MissionEvent>;
  streamMissionSnapshots(input: {
    missionId: string;
  }): AsyncIterable<{
    missionId: string;
    status: string;
    currentCycle: number;
    currentItemId: string | null;
    overallCompletion: number | null;
    updatedAt: string;
  }>;
}
```

Interface rules:

- all commands should be idempotent where practical
- command and query requests should carry `requestId` and `correlationId` when
  available so traces can be joined across hosts, providers, and storage
- request/response types should be transport-neutral so the same schema works
  for in-process calls and later RPC
- one canonical request/response schema should exist for each operation; a
  service wrapper must not invent a second semantic API
- command acceptance does not guarantee immediate completion; long-running work
  is observed through queries and streams
- streams are observational surfaces, not authoritative state storage

### 5.6.6 Transport and Service Exposure

Mission Control should define one host-neutral API contract first and only then
choose how that contract is transported.

Recommended layering:

1. in-process function-call API
2. optional local sidecar/service wrapper
3. networked RPC exposure when needed

Transport rules:

- the canonical API shape is `commands + queries + streams`
- transport choice must not change mission semantics, state ownership, or
  persistence rules
- `MissionControlAPI` request/response models should be shared across direct
  function calls and service adapters
- a transport adapter may add authentication, deadlines, metadata, and
  pagination details, but it must not redefine domain objects

Recommended service transport:

- if Mission Control is exposed over the network, `Connect RPC` is the
  recommended default transport
- `Connect RPC` fits command-oriented RPC plus streaming better than a
  REST-first design
- `Connect RPC` keeps browser/debugging friction lower than a pure gRPC-only
  posture while preserving strong RPC semantics

Recommended transport split:

- commands/queries: `Connect RPC`
- event and snapshot streams: `Connect RPC` server streaming by default
- optional browser-friendly status subscription: SSE or WebSocket adapter over
  the same underlying event stream

REST guidance:

- REST may be exposed as a compatibility or administrative facade
- REST should not be the primary internal contract for mission lifecycle
  operations such as retry/resume/stop/handoff
- mission-control implementations should not be forced to model RPC-style
  lifecycle transitions as awkward REST resource mutations

Cross-language guidance:

- the service contract should stay schema-first and transport-neutral so other
  runtimes can consume it through generated or hand-written clients
- if broader non-TS/non-Go adoption becomes a hard requirement, the service
  layer may additionally expose a gRPC-compatible surface derived from the same
  command/query/stream contract
- the runtime spec remains the same even if multiple transport adapters exist

Non-goals:

- GraphQL is not the primary mission-lifecycle protocol
- WebSocket/SSE are not replacements for the command/query API; they are stream
  delivery options
- transport selection must not leak host-specific command naming into the
  runtime contract

### 5.7 Web and Chat Surfaces

The first-class surface is still chat. A web page can be added later, but it
must read from the same persisted mission state instead of inventing a parallel
runtime.

Ownership split:

- host control surfaces own user intent, control, and delivery
- Mission Control owns mission state and runner orchestration
- future web control plane owns visualization and manual operator actions only

That means a later mission page may show:

- mission list
- status timeline
- current workpad
- attempt history
- workspace/artifact links
- retry/stop/approve actions

But the page must not become the only way to drive missions.

### 6. Runner Loop

Symphony's key behavior is not "one prompt, one answer"; it is a bounded loop.

Mission Control runner loop:

1. Load mission, workflow, and active checklist snapshot.
2. Ensure workspace.
3. Select the next incomplete checklist item.
4. Render the cycle prompt as:
   - immutable prompt
   - immutable goal
   - active checklist snapshot
   - current checklist item
   - current workpad summary
   - previous verifier feedback if any
5. Start or resume the provider.
6. Capture progress, artifacts, approvals, and candidate output.
7. Run verifier against the current checklist item.
8. Parse and persist a structured `CycleResult`.
9. If the checklist item is complete, advance to the next item.
10. If verification fails and policy allows repair, continue the bounded loop.
11. If the AI proposes a formal checklist change, create a plan change request
    or activate a new checklist snapshot per policy.
12. If blocked or waiting on human input, persist a paused state.
13. If every checklist item is complete and the immutable goal passes final
    verification, complete the mission.

Hard limits:

- max concurrent missions
- max turns per mission
- max attempts per mission
- max cycles per mission
- max no-progress cycles
- timeout per turn
- artifact count and size limits

### 7. Status Surface

Status visibility is required before any web dashboard. The surface may be
chat, CLI, web, or another host-specific UI, but the underlying capabilities
must stay host-neutral.

Minimum status/control capabilities:

- list missions
- fetch a mission summary and current workpad snapshot
- fetch final result text independently from live progress state
- fetch timeline/history for replay and audit
- fetch execution references for reopening provider threads, host sessions, or
  related artifacts from a host-specific UI
- stop a running mission
- retry or resume a paused/failed mission
- resolve pending approvals or plan-change requests

Command names, route shapes, UI affordances, and navigation patterns are
host-defined concerns. Mission Control specifies the underlying capabilities
and data contracts, not the slash-command surface of any one consumer.

Later, a web control plane can read the same persisted records and logs. It
should not own mission state.

## Related Documents

- Formal runtime backlog: `docs/todo/mission-control.md`
- CodexBridge integration and migration notes:
  [`mission-control-codexbridge-integration.md`](./mission-control-codexbridge-integration.md)
