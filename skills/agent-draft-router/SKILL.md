---
name: agent-draft-router
description: Generate checklist-first CodexBridge `/agent` drafts from natural-language intake using bounded action routing, skill-owned task typing, scope clarification, and immutable prompt scaffolds. Use when implementing, testing, or simulating first-host `/agent add` or bare `/agent` draft creation, especially for repo-aware `code` missions and lighter generic non-code missions.
---

# Agent Draft Router

Use this skill only for first-host `/agent` draft intake. Do not use it for:

- explicit `/agent confirm|edit|cancel|list|show|result|stop|retry|delete|rename|send`
- Mission runtime execution
- package-owned lifecycle control

Primary reference:

- `../../docs/architecture/agent-draft-templates.md`

Read that document when you need the full `code` or generic template contract.

## Workflow

1. Determine whether the request is draft intake at all.
2. Keep explicit `/agent` subcommands deterministic and out of model routing.
3. For bare `/agent <text>` or `/agent add <text>`, emit only a bounded action.
4. If the action is add/create, enter create-flow:
   - determine task type inside the skill
   - clarify only when the missing information is truly blocking
   - generate the formal checklist
   - generate the immutable prompt
   - generate loop policy
5. Produce a checklist-first draft rather than a generic lifecycle plan.

## Routing Rules

Allowed bounded actions for natural-language intake:

- `create_draft`
- `update_pending_draft`
- `clarify`
- `query_jobs`
- `show_job`
- `show_result`
- `propose_stop`
- `propose_retry`
- `reject`

Prefer clarification over forced routing when confidence is low.

Do not:

- invent jobs or drafts
- mutate authoritative mission state
- bypass deterministic bridge handlers
- bypass package-owned approval or change gates

## Create-Flow Rules

Only continue into create-flow when the action clearly resolves to add/create.

Inside create-flow:

1. Determine task type from the current request and repo context.
2. If the task is genuinely ambiguous or underspecified, ask one narrowing question.
3. Generate a formal checklist, not a generic software lifecycle.
4. Generate an immutable prompt scaffold that can survive autonomous loops.
5. Keep internal substeps separate from formal checklist mutation.

## `code` Missions

For `code` missions, prefer:

- repo-aware checklist items
- fixed immutable prompt scaffolding
- explicit verification commands
- explicit execution boundaries
- bilingual Conventional Commit requirements when repository changes are in scope
- repo context from the invocation payload over fixed path assumptions
- distill the user input into one direct sentence with at most one comma; do not expand it into rationale, checklist, or scope narration
- generate `plan[]` from the user goal plus repo context, and never leave it empty
- if at least 3 concrete checklist items cannot be derived from the goal and context, return `clarify` instead of forcing `create_draft`

Do not fall back to:

- analyze
- design
- code
- test
- deploy

unless those are truly the correct bounded checklist items.

## Generic Non-Code Missions

For generic non-code missions:

- keep the prompt lighter than `code`
- still require immutable goal, checklist, acceptance criteria, and loop policy
- still require checklist/progress updates each cycle

## State-Aware Loop Expectations

When shaping immutable prompts, make sure the loop can use Mission Control
status semantics:

- `running` / `verifying` / `repairing`: take the smallest next executable step
- `waiting_user`: ask one concrete blocking question
- `needs_human`: summarize why autonomy is no longer reasonable
- `handoff`: preserve current state and recommended next owner action
- `blocked`: describe the blocker precisely and offer options
- `max_loops_reached`: explain which budget was exhausted and the next recovery path

To avoid "do two steps then stall" behavior:

- prefer one bounded next step over broad re-planning
- prefer checklist refinement suggestions over vague failure language
- only clarify when the missing information is truly blocking

## Output Requirements

When generating or updating drafts:

- treat `plan[]` as the formal confirmed checklist / TODO
- preserve user-confirmed scope unless a formal refinement is required
- ensure the immutable prompt explicitly requires checklist-status updates,
  overall progress updates, blockers, and next-step updates each cycle
- for `code` missions, include bilingual Conventional Commit rules whenever
  repository changes are allowed

When editing a draft:

- return the full updated draft, not a patch
- preserve fields the user did not request to change
