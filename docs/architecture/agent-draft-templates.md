# Agent Draft Templates

This document defines the first-host `/agent` draft template strategy for
CodexBridge. It is a host-level intake contract, not a package-level Mission
Control runtime contract.

Use this document as the reviewable source of truth for:

- task-type-specific draft templates
- immutable prompt scaffolding
- bounded model-assisted natural-language routing expectations
- future internal skill guidance for draft generation

Current repo-local skill skeleton:

- `skills/agent-draft-router/SKILL.md`

The goal is to ensure that `/agent` draft creation produces stable,
checklist-first missions instead of generic lifecycle plans.

## Scope

This document applies to first-host Mission draft intake in CodexBridge:

- `/agent add <natural language>`
- bare `/agent <natural language>` when it resolves to new-task creation

This document does not redefine:

- Mission Control package runtime APIs
- paused-state lifecycle semantics
- service exposure / Connect RPC
- `/auto`

## Routing Boundary

`/agent` intake should follow a mixed model:

1. Deterministic subcommand routing
2. Bounded model-assisted natural-language routing owned by the skill
3. Dedicated create-flow pipeline for add/create intents

### Deterministic Subcommands

These commands should remain program-routed and should not depend on model
intent classification:

- `/agent confirm`
- `/agent edit`
- `/agent cancel`
- `/agent list`
- `/agent show`
- `/agent result`
- `/agent stop`
- `/agent retry`
- `/agent delete`
- `/agent rename`
- `/agent send`

### Bounded Model-Assisted Natural-Language Routing

These forms may use a model or internal skill:

- bare `/agent <natural language>`
- `/agent add <natural language>`

But the model must emit a bounded action schema rather than an unconstrained
free-form answer. Recommended actions include:

- `create_draft`
- `update_pending_draft`
- `clarify`
- `query_jobs`
- `show_job`
- `show_result`
- `propose_stop`
- `propose_retry`
- `reject`

Low-confidence routing should prefer clarification over forced intent
selection. The skill, not the host, owns task typing and scope narrowing.

### Dedicated Create-Flow Pipeline

Only actions resolved to add/create should continue into create-flow:

1. task typing
2. scope clarification
3. checklist drafting
4. immutable-prompt drafting
5. loop-policy drafting

Create-flow should not be reused for confirm/edit/query/stop flows. The host
must only relay the skill result and avoid adding extra host-side scope
heuristics after the skill has returned a draft or a clarification.

## Shared Draft Shape

All task types should converge on the same high-level shape, even when the
rendered prompt differs by task type.

Goal text rule:

- `goal` must be a single direct sentence that restates the user's intent.
- Keep it as concise as possible and use at most one comma.
- Do not turn `goal` into rationale, scope narration, checklist content, or a plan.

Recommended draft fields:

- `title`
- `goal`
- `expectedOutput`
- `acceptanceCriteria[]`
- `immutablePrompt`
- `loopPolicy`
- `plan[]`
- `category`
- `riskLevel`
- `mode`

Important note:

- bridge draft payloads may still use `plan[]` as the serialized field name
- product semantics should treat `plan[]` as the user-confirmed formal
  checklist / TODO list
- `plan[]` must be generated from the user goal plus current repo context, and
  it must never be empty.
- If the skill cannot derive at least 3 concrete checklist items from the goal
  and context, it should return `clarify` instead of `create_draft`.

## Task Types

Initial task-type families:

- `code`
- `research`
- `ops`
- `doc`
- generic fallback

The first required formal template is `code`.

## `code` Template

### When to Use

Use `code` when the task primarily involves:

- code changes
- tests
- debugging
- refactoring
- package/runtime/interface changes
- repository configuration changes

### Required Properties

A `code` draft should be repo-aware and should avoid generic software-lifecycle
checklists.

It should derive or explicitly include:

- branch
- must-read docs
- preflight checks
- execution boundaries
- allowed paths
- discouraged paths
- formal checklist
- acceptance criteria
- validation commands
- commit/report rules

### Clarification Rule

Do not create a formal `code` checklist immediately when the goal is too broad
or when the current context is insufficient to derive at least 3 concrete
checklist items.

Examples that should usually trigger clarification first:

- "finish all remaining Mission Control work"
- "fix the whole project"
- "complete all remaining TODOs"

Clarify scope first, for example:

- which phase
- which package
- which bounded capability slice
- which repo context slice

### User-Visible `code` Draft Layout

Recommended user-facing structure:

```md
Agent 草案 | 代码任务

任务类型：code
模式：Codex 执行
风险：中

最终目标：
<immutableGoal>

范围摘要：
<scopeSummary>

当前工作分支：
- <branch>

开始前请先阅读：
- <mustRead 1>
- <mustRead 2>
- <mustRead 3>

开始前必须做：
1. <preflight 1>
2. <preflight 2>
3. <preflight 3>

执行边界：
1. <boundary 1>
2. <boundary 2>
3. <boundary 3>

主要允许修改：
- <allowed path 1>
- <allowed path 2>

尽量不要修改：
- <discouraged path 1>
- <discouraged path 2>

待确认 checklist：
1. <formal checklist item 1>
2. <formal checklist item 2>
3. <formal checklist item 3>

验收标准：
1. <acceptance criterion 1>
2. <acceptance criterion 2>
3. <acceptance criterion 3>

验证要求：
- <validation command 1>
- <validation command 2>
- <validation command 3>

固定 Prompt：
<immutablePrompt>

循环策略：
- 最大 attempts：<n>
- 每次 attempt 最大 turns：<n>
- 最大循环数：<n>
- 最大无进展循环数：<n>
```

### `code` Immutable Prompt Scaffold

`code` immutable prompts should be generated from a fixed scaffold rather than
free-form prose.

Required sections:

1. immutable goal
2. working branch
3. must-read docs
4. preflight checks
5. execution boundaries
6. allowed paths
7. discouraged paths
8. confirmed checklist
9. acceptance criteria
10. cycle execution rules
11. validation requirements
12. commit/report requirements

Recommended scaffold:

```md
请继续推进当前代码任务。

不可变目标：
<immutableGoal>

当前工作分支：
- <branch>

开始前请先阅读：
- <mustRead 1>
- <mustRead 2>
- <mustRead 3>

开始前必须做：
1. 检查 git status，保护已有未提交改动，不要覆盖用户改动。
2. 确认当前分支符合任务范围；如果不符合，先说明再处理。
3. 对比代码、测试、文档和当前 checklist，确认下一步仍属于本任务范围。
4. 如果文档与代码不一致，以代码、测试和 git 状态为准，先修正文档或提出最小修正方案。

执行边界：
1. 只在任务范围内修改。
2. 不要把不相关的宿主逻辑、平台逻辑或跨领域能力混入当前任务。
3. 除非确有必要，不要扩大改动面。

主要允许修改：
- <allowed path 1>
- <allowed path 2>

尽量不要修改：
- <discouraged path 1>
- <discouraged path 2>

当前确认 checklist：
1. <checklist item 1>
2. <checklist item 2>
3. <checklist item 3>

验收标准：
1. <criterion 1>
2. <criterion 2>
3. <criterion 3>

循环执行要求：
1. 每轮只推进一个最小但完整、可验证的子阶段。
2. 每轮结束必须判断当前 checklist item 是否完成。
3. 每轮结束必须更新：
   - 当前 checklist item 状态
   - overall completion
   - next step
   - latest blocker
   - latest progress summary
4. 如果发现 checklist 需要细化或调整，必须先区分：
   - 内部 substeps
   - 正式 checklist 变更
5. 内部执行细化可以写入 workpad。
6. 正式 checklist 变更不得静默生效，必须产出明确的 refinement/change suggestion。
7. 如果目标过宽、信息不足或当前 checklist 已不足以支撑安全推进，先提出澄清或变更建议。

验证要求：
- <validation command 1>
- <validation command 2>
- <validation command 3>

提交要求：
1. 每轮若完成一个最小完整且验证通过的代码增量，必须创建一个本地 commit。
2. commit message 必须使用双语 Conventional Commit 格式：
   `type(scope): English summary / 中文摘要`
3. commit body 必须包含：
   - `EN:`
   - `ZH:`
4. 如果本轮无法形成安全、完整、可验证的增量，不要强行提交；应明确说明阻塞或继续当前子阶段。
5. 除非任务明确要求，不要自动 push。

最终回复必须说明：
1. 本轮完成了哪个 checklist item 或子阶段
2. 修改了哪些代码和文档
3. 跑了哪些验证
4. 当前 checklist 状态更新
5. 下一步是什么
6. 是否需要正式 checklist refinement 或用户确认
```

### `code` Checklist Rules

The formal checklist for `code` missions must:

- be concrete and observable
- map to real code/doc/test boundaries
- include verification
- avoid filler lifecycle steps unless those are actually the right bounded
  mission items

Bad checklist example:

1. analyze requirements
2. design solution
3. develop code
4. test
5. deploy

Better checklist example:

1. confirm the remaining Phase 10 mission-control service-exposure scope
2. wrap package-owned commands/queries/streams in an internal service layer
3. add Connect RPC transport bindings without forking runtime semantics
4. map mission snapshot/event subscriptions to streaming transport
5. validate typecheck, focused tests, and transport-facing contract behavior

## Generic Non-Code Template

Non-code tasks may use a lighter template, but should still produce:

- immutable goal
- formal checklist
- immutable prompt
- loop policy
- acceptance criteria

They should not inherit repo-specific code scaffolding unless the task actually
needs repository execution.

### When to Use

Use the generic template when the task is not primarily a repository-changing
code task, but still needs a checklist-backed looping mission. Typical
examples:

- structured research
- planning or synthesis
- documentation-only work
- operational coordination that does not require a code-first scaffold

### User-Visible Generic Draft Layout

Recommended user-facing structure:

```md
Agent 草案 | 通用任务

任务类型：<generic | research | doc | ops>
模式：<agents | hybrid | codex>
风险：<low | medium | high>

最终目标：
<immutableGoal>

范围摘要：
<scopeSummary>

约束：
1. <constraint 1>
2. <constraint 2>
3. <constraint 3>

待确认 checklist：
1. <formal checklist item 1>
2. <formal checklist item 2>
3. <formal checklist item 3>

验收标准：
1. <acceptance criterion 1>
2. <acceptance criterion 2>
3. <acceptance criterion 3>

固定 Prompt：
<immutablePrompt>

循环策略：
- 最大 attempts：<n>
- 每次 attempt 最大 turns：<n>
- 最大循环数：<n>
- 最大无进展循环数：<n>
```

### Generic Immutable Prompt Scaffold

Generic non-code prompts should stay lighter than `code`, but they still need
explicit loop discipline and checklist stewardship.

Recommended scaffold:

```md
请继续推进当前任务。

不可变目标：
<immutableGoal>

范围摘要：
<scopeSummary>

当前确认 checklist：
1. <checklist item 1>
2. <checklist item 2>
3. <checklist item 3>

验收标准：
1. <criterion 1>
2. <criterion 2>
3. <criterion 3>

执行要求：
1. 每轮只推进一个最小但完整、可验证的子阶段。
2. 每轮结束必须判断当前 checklist item 是否完成。
3. 每轮结束必须更新：
   - 当前 checklist item 状态
   - overall completion
   - next step
   - latest blocker
   - latest progress summary
4. 如果发现 checklist 需要细化或调整，先区分：
   - 内部 substeps
   - 正式 checklist 变更
5. 内部执行细化可以写入 workpad。
6. 正式 checklist 变更不得静默生效，必须产出明确的 refinement/change suggestion。
7. 如果目标过宽、信息不足或当前 checklist 已不足以支撑安全推进，先提出澄清或变更建议。

输出要求：
1. 说明本轮完成了哪个 checklist item 或子阶段
2. 说明新增证据、结论或产物
3. 更新当前 checklist 状态
4. 说明下一步是什么
5. 说明是否需要正式 checklist refinement 或用户确认
```

## State-Aware Loop Behavior

All task-type templates should explicitly use Mission Control state semantics.
Draft generation and immutable prompts should encourage the model to choose the
smallest correct transition instead of stalling.

Important state-aware behaviors:

- `running` / `verifying` / `repairing`:
  - prefer the smallest next executable step that advances the current
    checklist item
- `waiting_user`:
  - ask one concrete blocking question and explain why progress cannot safely
    continue without that answer
- `needs_human`:
  - summarize why the loop cannot reasonably proceed autonomously and what a
    human must decide or do next
- `handoff`:
  - summarize current state, preserved context, and the recommended next owner
    action
- `blocked`:
  - describe the blocker precisely and propose available options instead of
    stopping with vague failure language
- `max_loops_reached`:
  - explain whether exhaustion came from total cycle budget or no-progress
    budget, and what the most reasonable recovery path is

To avoid "do two steps then stall" behavior:

- prefer clarification only when the missing information is truly blocking
- prefer formal checklist refinement suggestions over vague "cannot continue"
- prefer one bounded next step over broad re-planning
- avoid restating the whole mission when a narrower actionable delta exists

## Internal Skill Recommendation

This document should inform a future internal draft-generation skill, for
example:

- `agent-draft-router`
- `mission-draft-templates`

Recommended responsibilities for that skill:

1. classify bounded natural-language intake
2. determine task type
3. detect over-broad scope and ask clarification questions
4. generate checklist-first drafts
5. render the appropriate immutable prompt scaffold
6. inject state-aware loop rules so templates actively use Mission Control
   status semantics instead of generic lifecycle prose

Recommended non-responsibilities:

- mutating authoritative mission state directly
- bypassing deterministic bridge handlers
- bypassing approval/change gates

## Status

This document is an approved reference template for ongoing implementation. It
does not mean the full first-host create-flow is already complete in code.
The companion repo-local skill skeleton currently lives at:

- `skills/agent-draft-router/SKILL.md`
