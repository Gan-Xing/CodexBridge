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

## Product Goal

Mission Control should support a surface like CodexBridge letting a user say:

```text
/agent 帮我修复 CodexBridge 微信 preview 卡死问题，完成后给我测试结果
/auto 每天早上 8 点检查助理记录和逾期事项，发到微信
```

and get a managed work item with:

- current status
- execution workspace
- attempt count
- plan and acceptance criteria
- latest result or blocker
- retry / stop / delete controls
- final delivery through the normal CodexBridge SendGate

The operator should not need to understand Linear, GitHub, worktrees,
app-server protocols, or artifact manifests to operate the system. Mission
Control should remain reusable from other control surfaces besides WeChat.

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
   - CodexBridge WeChat `/agent`
   - CodexBridge `/auto`
   - CLI
   - future Telegram / web / API adapters

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

## Current CodexBridge Mapping

Existing pieces already cover part of Mission Control:

- `/agent`: manual background job creation, confirmation, full-access run,
  verification, retry, stop, rename, delete, export, and send.
- `/auto`: scheduled job creation and WeChat delivery-oriented recurring runs.
- `/review`: native Codex review as a focused work run.
- `/threads`, `/open`, `/status`, `/retry`, `/reconnect`: session recovery and
  runtime diagnosis.
- `TurnArtifactDeliveryState`: provider-native and bridge-declared artifact
  handoff.
- `AgentJob`: current persisted unit for background agent work.

Main missing abstraction:

- There is no unified `Mission` model that can represent manual agent jobs,
  scheduled automation runs, tracker issues, and future desktop/browser tasks.

## V0 Migration Baseline Sources

Before `/agent` and `/auto` delegate into Mission Control, the existing
user-visible contract should be treated as migration-protected.

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
- `/auto` semantic command contract:
  - `docs/command-skills/auto.md`
- `/auto` migration-protection tests:
  - `test/core/bridge_coordinator.test.ts`
    - `/auto add creates a draft first and /auto confirm persists the standalone automation job`
    - `/auto add natural language produces a draft through provider normalization before /auto confirm`
    - `/auto edit updates the pending automation draft instead of replacing it`
    - `/auto rename and /auto del update and remove automation jobs`
    - `/auto pause and /auto resume update automation job status`
    - `/auto show without args opens the only automation job and shows a future next-run time`
    - `/auto show without args asks for an index when multiple automation jobs exist`
    - `/auto add thread requires an existing bound session`
    - `/auto cancel clears the pending automation draft`

Mission Control should preserve these contracts while replacing the runtime
behind them.

## Product Shape

Mission Control should be developed **inside** the CodexBridge repository first,
but it should still be treated as a package with a stable ownership boundary so
it can later serve non-CodexBridge control surfaces:

```text
packages/mission-control/
```

Target import direction:

```text
CodexBridge WeChat/Telegram/CLI runtime
  -> CodexBridge integration layer
  -> @codexbridge/mission-control
```

The reverse dependency is not allowed:

```text
@codexbridge/mission-control
  -X-> CodexBridge platform/runtime/command modules
```

This means:

- `CodexBridge` may call Mission Control.
- Mission Control must not import WeChat adapters, slash-command parsers,
  SendGate, i18n, or bridge-session storage internals.
- The first home can be a same-repo internal package; it does **not** need a
  workspace or multi-package release flow yet.
- The first public-facing product can still be `/agent` and `/auto`; package
  extraction is an implementation boundary, not a UX change.
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

- CodexBridge slash commands: `/agent`, `/auto`, future `/mission`
- assistant records: todos/reminders promoted to work
- local scheduled automation

Later surfaces and sources:

- GitHub issues
- Linear issues
- Notion tasks
- Google Drive / Docs task lists

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

You are running a CodexBridge Mission.

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
- Return final result through CodexBridge only; do not bypass SendGate.
```

If this file is missing, CodexBridge should use a built-in safe default. Invalid
YAML should not break normal bridge startup; it should block only mission runs
that depend on that workflow.

Phase 2 foundations inside `packages/mission-control` should provide:

- `MissionWorkflowLoader`
  - resolves explicit path, env override, or workspace/cwd default
  - returns built-in defaults when the file is missing
  - surfaces a typed workflow validation error when config is invalid
- a canonical mission-attempt prompt contract renderer
  - keeps prompt responsibility separate from orchestrator/verifier authority
- workpad status rendering helpers
  - expose workflow source, summary, blocker, verifier notes, final result
  - expose compact attempt history for future `/agent show` integration

### 3. Mission Model

`AgentJob` can remain the v0 execution record, but the target abstraction should
be:

```ts
type MissionStatus =
  | "draft"
  | "queued"
  | "planning"
  | "running"
  | "verifying"
  | "repairing"
  | "blocked"
  | "completed"
  | "failed"
  | "stopped"
  | "archived";

type MissionSource =
  | "weixin"
  | "automation"
  | "assistant-record"
  | "github"
  | "linear"
  | "manual";

type Mission = {
  id: string;
  source: MissionSource;
  sourceRef?: string;
  platform: string;
  externalScopeId: string;
  title: string;
  goal: string;
  expectedOutput: string;
  acceptanceCriteria: string[];
  plan: string[];
  status: MissionStatus;
  priority: "low" | "normal" | "high";
  riskLevel: "low" | "medium" | "high";
  cwd: string | null;
  workspacePath: string | null;
  workflowPath: string | null;
  providerProfileId: string;
  bridgeSessionId: string | null;
  codexThreadId: string | null;
  attemptCount: number;
  maxAttempts: number;
  maxTurns: number;
  lastRunAt: number | null;
  completedAt: number | null;
  lastResultPreview: string | null;
  resultText: string | null;
  resultArtifacts: unknown[];
  lastError: string | null;
  workpad: MissionWorkpad;
  createdAt: number;
  updatedAt: number;
};
```

Mission alone is not enough. The persisted runtime should also track:

```ts
type MissionAttempt = {
  id: string;
  missionId: string;
  index: number;
  status: "queued" | "running" | "verifying" | "repairing" | "completed" | "failed" | "blocked";
  providerRunId: string | null;
  providerThreadId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  verifierVerdict: "complete" | "repair" | "blocked" | "failed" | null;
  verifierSummary: string | null;
  error: string | null;
};

type MissionEvent = {
  id: string;
  missionId: string;
  attemptId: string | null;
  kind:
    | "mission.created"
    | "mission.planned"
    | "mission.started"
    | "mission.progress"
    | "mission.verifying"
    | "mission.retrying"
    | "mission.blocked"
    | "mission.completed"
    | "mission.failed"
    | "mission.stopped";
  payload: Record<string, unknown>;
  createdAt: number;
};
```

### Mission State Machine

The state machine must be explicit. Long-running behavior should never be
hidden inside ad-hoc retries.

```text
draft
  -> queued
  -> planning
  -> running
  -> verifying
    -> completed
    -> repairing -> running
    -> blocked
    -> failed
running/verifying/repairing
  -> stopped
completed/failed/stopped
  -> archived
```

Required transition rules:

- `queued -> planning`: workflow and prompt can be rendered
- `planning -> running`: workspace and provider context are ready
- `running -> verifying`: provider returned a candidate result
- `verifying -> repairing`: verifier says the goal is not complete but can be
  fixed within budget
- `verifying -> blocked`: verifier requires human input or missing permission
- `verifying -> failed`: retry/turn/time budget is exhausted or verifier marks
  unrecoverable failure
- `blocked -> running`: human approves or supplies the missing input
- `running/verifying/repairing -> stopped`: explicit user stop

Definition of done:

- "Mission completed" means acceptance criteria passed.
- "Mission produced text" is **not** enough.
- "Mission stopped without failure" must be represented as `stopped`, not
  `completed`.

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
  logs/
    <missionId>.jsonl
```

Rules:

- Code-changing missions should use a dedicated workspace.
- Read-only research and writing missions may reuse the bound session cwd.
- Workspace lifecycle hooks should come from `WORKFLOW.md`.
- A mission must never write outside its workspace except approved artifact and
  log directories.

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

### 5. Workpad

Each mission needs a single persistent workpad. This is the equivalent of
Symphony's issue comment, adapted first for CodexBridge chat surfaces and later
for other hosts.

The workpad should store:

- environment stamp: host, workspace, git SHA
- current status
- plan checklist
- acceptance criteria
- validation checklist
- latest notes
- blockers
- final result summary

Rendering rules:

- `/agent show <n>` or future `/mission show <n>` shows the compact workpad.
- `/agent result <n>` shows only the final result text.
- `/agent result <n> file` exports full result as `.txt`.
- Host adapters such as CodexBridge WeChat delivery should send concise
  progress and final summaries, not the entire workpad unless requested.

### 5.5 Verification Contract

To support "keep working until it is actually done", Mission Control needs a
first-class verification step.

Verification input should include:

- mission goal
- acceptance criteria
- latest provider result
- latest artifacts
- workspace context if relevant
- previous verifier feedback

Verification output should be normalized to:

```ts
type MissionVerification = {
  verdict: "complete" | "repair" | "blocked" | "failed";
  summary: string;
  repairPrompt?: string | null;
  missingCriteria?: string[];
  requiresHumanReason?: string | null;
};
```

The verifier can initially be implemented with:

- Codex-native review/result checks for code-changing runs
- simple rule checks for automation/reporting missions
- bridge-owned hard guards for missing files, missing artifacts, or known
  incomplete outputs

The verifier must be persisted. A restart must not forget why the mission was
being repaired or blocked.

### 5.6 Persistence and Recovery

Mission Control should be safe to restart.

Minimum persisted units:

- missions
- attempts
- event log
- workpad snapshots
- workspace metadata
- pending approvals / blockers
- active runner lease

Recovery rules:

- `queued`, `planning`, and lease-expired `running` missions should be
  re-enqueued on startup
- `verifying` and `repairing` missions should resume from persisted attempt
  state instead of starting over
- `blocked` missions should remain blocked until explicit human action
- duplicate concurrent runners must be prevented with a lease/lock record

### 5.7 Web and Chat Surfaces

The first-class surface is still chat. A web page can be added later, but it
must read from the same persisted mission state instead of inventing a parallel
runtime.

Ownership split:

- chat commands own user intent, control, and delivery
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

1. Load mission and workflow.
2. Ensure workspace.
3. Start or resume Codex app-server thread.
4. Send workflow-rendered prompt.
5. Capture progress, artifacts, approvals, and result.
6. Verify acceptance criteria.
7. If verification fails and attempts remain, repair/retry.
8. If blocked, mark `blocked` with a human-action reason.
9. If completed, deliver result through SendGate.

Hard limits:

- max concurrent missions
- max turns per mission
- max attempts per mission
- timeout per turn
- artifact count and size limits

### 7. Status Surface

Chat-first status is required before any web dashboard.

Minimum commands:

- `/agent` lists current mission-like jobs.
- `/agent show <n>` shows status and workpad summary.
- `/agent stop <n>` stops a running mission.
- `/agent retry <n>` reruns using the same mission context.
- `/agent result <n>` returns final result text.
- `/agent result <n> file` exports a `.txt` result.

Later, a web control plane can read the same persisted records and logs. It
should not own mission state.

## Implementation Plan

### Phase 0: Baseline current `/agent` and `/auto` behavior

- Treat current `/agent` and `/auto` user-visible behavior as migration
  protected.
- Keep the command-skill contracts and bridge tests as the authoritative
  baseline while Mission Control grows underneath them.
- Do not change user-facing semantics just to make the runtime abstraction
  cleaner.

### Phase 1: Add domain and persistence

- Keep `packages/mission-control` as the internal TypeScript package boundary.
- Add durable mission domain types:
  - mission
  - attempt
  - event
  - workpad
  - lease / pending approval state
- Add explicit mission state transitions.
- Add a first local JSON-backed persistence implementation.
- Make restart recovery and resumable-mission detection testable before adding
  provider execution.

### Phase 2: Add workflow and workpad

- Add `MissionWorkflowLoader` for `.codexbridge/mission/WORKFLOW.md`.
- Parse YAML front matter plus prompt body.
- Keep workflow policy outside slash-command handlers.
- Add a canonical mission-attempt prompt contract so prompt, orchestrator, and
  verifier stay separated.
- Add package-local workpad status helpers that expose workflow source, summary,
  blocker, verifier notes, final result, and attempt history.
- Integrate those helpers into `/agent show` only after the package-side
  contract is stable.

### Phase 3: Add workspace isolation and recovery-safe leases

- Add `MissionWorkspaceService`.
- Use dedicated workspace for code-changing missions.
- Keep read-only missions in bound cwd when safe.
- Add runner lease/lock records so restart recovery and concurrency are safe.
- Persist `workspacePath` and environment stamp.

### Phase 4: Add Codex provider and bounded run / verify / repair loop

- Replace one-shot `/agent` execution with a loop:
  - run
  - verify
  - repair if needed
  - block / fail / complete
- Persist attempt and verifier state after every step.
- Ensure restart recovery can resume queued/running/verifying missions safely.

### Phase 5: Add control adapters and external sources

- Keep CodexBridge WeChat as the first control and notification surface.
- Add a clean integration path for `/auto` and future Telegram reuse.
- Keep the runtime host-agnostic so other surfaces can embed it without
  changing mission core behavior.
- GitHub issues first if GitHub auth is available.
- Linear second, because Symphony already proves the shape.
- Only after chat control is solid, add a read/write web control plane against
  the same persisted mission state.

## Guardrails

- Do not bypass CodexBridge SendGate for delivery.
- Do not let agent runs directly call WeChat APIs.
- Do not let workflow prompt edits silently change runtime permissions.
- Do not treat a scheduled `/auto` job and a manual `/agent` mission as the same
  record until the Mission abstraction exists.
- Do not add a new `/mission` command until `/agent` can serve as Mission v0
  without confusing users.

## Practical Next Step

The immediate useful next step is not copying Symphony's Elixir code. It is:

1. Keep `reference/symphony` as architecture reference.
2. Add workflow loading around `/agent`.
3. Add workpad fields to `AgentJob`.
4. Make `/agent show` present the workpad.
5. Make `/agent retry` reuse the workpad and workspace context.
6. Add `packages/mission-control` as the internal runtime boundary before
   attempting a broader npm extraction.

That gives Mission Control a real Codex-first runtime while keeping CodexBridge
as the primary initial control surface.
