# CodexBridge Command Skill: /agent

## Purpose

This file defines how Codex should normalize CodexBridge `/agent` slash commands when Bridge explicitly asks Codex to use this project-local command skill.

`/agent` manages background Agent jobs. Codex may interpret natural language and return a structured decision, but Bridge is the only component allowed to create, run, stop, retry, delete, rename, export, send, confirm, or persist Agent jobs.

Return exactly one JSON object. Do not use Markdown, prose, code fences, tool calls, or side effects.

## Invocation

Bridge invokes this skill only for semantic forms:

1. `/agent <natural language>`
2. `/agent add <natural language>`
3. `/agent edit <natural language>`

Important host boundary:

- For bare `/agent <text>` and `/agent add <text>`, this skill is the
  normalization boundary.
- This skill owns task typing, scope narrowing, and draft-shape decisions.
- `create_draft` means "the request is sufficiently bounded for a new pending
  draft; Bridge should store the draft after basic schema validation."
- Bridge should not reinterpret the skill response with extra host-side scope
  heuristics after this skill answers.

For task-type-specific draft shaping, especially `code` missions, also follow:

- `docs/architecture/agent-draft-templates.md`
- `skills/agent-draft-router/SKILL.md`

Bridge sends a prompt with this payload shape:

```json
{
  "command": "agent",
  "subcommand": "natural | add | edit",
  "rawText": "original user message",
  "userInput": "natural-language part after /agent, /agent add, or /agent edit",
  "now": "ISO timestamp",
  "locale": "zh-CN",
  "timezone": "Etc/UTC",
  "localTime": "YYYY-MM-DD HH:mm Etc/UTC",
  "scope": {
    "platform": "weixin",
    "externalScopeId": "..."
  },
  "repoContext": {
    "cwd": null,
    "repoRoot": null,
    "repoName": null,
    "branch": null,
    "packageManager": "pnpm",
    "packageScripts": [],
    "topLevelEntries": []
  },
  "pendingDraft": null,
  "jobs": [],
  "skillPath": "docs/command-skills/agent.md"
}
```

Use only `pendingDraft`, `jobs`, and `repoContext` from the payload as state. Do not invent jobs, drafts, ids, indexes, outputs, files, fixed paths, or attachments.

## Output Contract

Every response must include:

```json
{
  "schemaVersion": "codexbridge.agent-command-skill.v1",
  "ok": true,
  "action": "one_action_name",
  "confidence": 0.9,
  "requiresConfirmation": false
}
```

Use `ok: false` for `clarify` and `reject`. Use confidence from `0` to `1`.

Action summary:

| Action | Purpose | Confirmation |
| --- | --- | --- |
| `create_draft` | Create a new pending Agent draft | true |
| `update_pending_draft` | Replace the current pending draft with an edited full draft | true |
| `query_jobs` | List existing jobs | false |
| `show_job` | Show one job's details | false |
| `show_result` | Show one job's text result | false |
| `export_result` | Export one job's text result as a file | false |
| `send_attachments` | Resend one job's existing attachments | false |
| `propose_update_job` | Propose changing an existing job's executable metadata | true |
| `propose_stop_job` | Propose stopping an existing job | true |
| `propose_retry_job` | Propose retrying an existing job | true |
| `propose_delete_job` | Propose deleting an existing job record | true |
| `propose_rename_job` | Propose renaming an existing job | true |
| `clarify` | Ask the user to disambiguate | false |
| `reject` | Refuse routing outside `/agent` | false |
| `local_only` | Tell Bridge this should be handled locally | false |

## Subcommand Rules

### `subcommand: "add"`

Interpret the input as a request for a new background Agent job.

Allowed actions: `create_draft`, `clarify`, `reject`, `local_only`.

Do not use `add` to update, stop, retry, delete, rename, show, export, or send existing jobs. If the text clearly asks for a scheduled or recurring task, return `reject` and point to `/auto add`.

`add` is create-only. Do not route it to existing-job actions even if the user
mentions an old job title.

### `subcommand: "edit"`

Interpret the input as an edit to `pendingDraft`.

Allowed actions: `update_pending_draft`, `clarify`, `reject`, `local_only`.

If `pendingDraft` is null, return `clarify`. Do not silently create a new draft. Do not convert a draft edit into an existing-job operation.

`edit` is pending-draft-only. Do not emit `create_draft` here.

### `subcommand: "natural"`

Route the user's intent. Allowed actions are all actions in the summary table.

When both new-job creation and existing-job management are plausible:

- If `pendingDraft` exists and wording such as "改成", "换成", "补充", "只做方案", "不要改代码", or "目标不变" clearly refers to the draft, use `update_pending_draft`.
- If one existing job clearly matches the user's text, use the relevant existing-job action. This includes `propose_update_job` when the user changes the job's goal, output, plan, category, risk, or mode.
- If no pending draft exists and no existing job clearly matches, use `create_draft` only when the user is asking for a new background task.
- If intent or target is ambiguous, use `clarify`.

Natural-language "确认", "取消", or "执行这个草案" should not be treated as semantic confirmation. Return `local_only` or `clarify` and let Bridge require `/agent confirm` or `/agent cancel`.

## Local-Only Commands

These forms should normally be handled directly by Bridge and not invoke Codex:

- `/agent`
- `/agent list`
- `/agent ls`
- `/agent show <index|id>`
- `/agent result <index|id>`
- `/agent result <index|id> file`
- `/agent send <index|id>`
- `/agent stop <index|id>`
- `/agent retry <index|id>`
- `/agent rt <index|id>`
- `/agent delete <index|id>`
- `/agent del <index|id>`
- `/agent rename <index|id> <title>`
- `/agent confirm`
- `/agent confirm <index|id> reject`
- `/agent c`
- `/agent cancel`
- help flags such as `-h`, `--help`, `-help`, `-helps`

If invoked for one of these by mistake:

```json
{
  "schemaVersion": "codexbridge.agent-command-skill.v1",
  "ok": true,
  "action": "local_only",
  "confidence": 1,
  "requiresConfirmation": false,
  "reason": "This command should be handled by Bridge locally."
}
```

## Safety Boundary

Confirmed Agent jobs run in detached Codex sessions with full-access settings. Be conservative.

Codex must not:

- Create, run, stop, retry, delete, rename, export, send, confirm, or persist Agent jobs directly.
- Send WeChat messages directly or bypass CodexBridge SendGate.
- Call browser automation, iLink, curl, custom senders, external delivery tools, or network delivery APIs.
- Treat ambiguous destructive or operational requests as confirmed.
- Invent existing jobs or select among multiple plausible jobs for mutating actions.
- Turn scheduled, recurring, or reminder-like requests into Agent jobs. Use `reject` and tell Bridge to use `/auto add`.

Codex should:

- Preserve concrete project names, file paths, deliverable formats, verification requirements, cwd hints, model/tool/skill names, and delivery requirements.
- Keep "send back to WeChat", "notify me", "发给我", and similar delivery intent in `expectedOutput`; Bridge handles actual delivery.
- Resolve relative dates or times in task text using `timezone` and `localTime` when they affect the job. Prefer absolute local dates/times such as `2026-05-02 09:00 Etc/UTC`; do not leave only "今天", "明天", "下周三", or "下个月".
- Avoid scheduling semantics. If the main user intent is "run later", "run every day", "remind me", or "定时", reject to `/auto add`.
- Increase `riskLevel` when a task can modify code, deploy, delete data, affect production, spend money, publish externally, or access private data.

## Target Rules

Use this target shape for all one-job actions:

```json
{
  "target": {
    "jobId": null,
    "index": 1,
    "matchText": "visible title or phrase"
  }
}
```

Rules:

- `jobId` and `index` must come from `jobs`.
- `matchText` should be the user's visible phrase for the target job.
- Prefer exact `jobId` or `index` when available.
- If exactly one job matches by title, goal, output, original input, or visible phrase, return that action.
- If multiple jobs match, return `clarify` with candidate indexes and titles.
- If no job matches a one-job action, return `clarify`; do not create a new job unless the user clearly asks for one.
- For `query_jobs`, target is not needed.

Status guidance:

- `propose_stop_job`: Use for queued, planning, running, verifying, or repairing jobs. If the job is already completed, failed, or stopped, prefer `show_job`, `show_result`, `propose_retry_job`, or `clarify`.
- `propose_update_job`: Prefer queued, stopped, or failed jobs. If the job is running, verifying, repairing, or completed, use `clarify` unless the user clearly wants to update metadata for a future retry.
- `propose_retry_job`: Use when the user asks to rerun or try again. If the job is currently running, use `clarify` unless the user clearly means restart from scratch.
- `propose_delete_job`: Any existing job can be proposed for deletion, but it always requires confirmation.
- `show_result`, `export_result`, and `send_attachments`: It is okay if the job has no result or attachment; Bridge will render the local "no result" or "no attachment" response.

## Draft Rules

Draft shape:

```json
{
  "draft": {
    "title": "short title",
    "goal": "clear goal",
    "expectedOutput": "final deliverable",
    "acceptanceCriteria": ["criterion 1", "criterion 2"],
    "immutablePrompt": "fixed prompt for every cycle",
    "loopPolicy": {
      "maxAttempts": 2,
      "maxTurns": 8,
      "maxCycles": null,
      "maxNoProgressCycles": 3
    },
    "plan": ["formal checklist item 1", "formal checklist item 2", "formal checklist item 3"],
    "category": "code",
    "riskLevel": "medium",
    "mode": "codex"
  }
}
```

Allowed `category`:

- `code`: code, tests, build, repo changes, debugging, refactoring.
- `research`: investigation, comparison, source synthesis, market or technical research.
- `ops`: deployment, service restart, logs, infra, credentials, monitoring.
- `doc`: writing, summarizing, reports, specs, documentation.
- `media`: image, video, audio, publishing assets.
- `mixed`: multiple categories or unclear category.

Allowed `riskLevel`:

- `low`: read-only, documentation, summarization, local inspection with no sensitive action.
- `medium`: local code edits, tests, generated artifacts, non-production changes.
- `high`: production operations, deploy/restart, deletion, publishing, payments, credentials, private data, broad filesystem changes.

Allowed `mode`:

- `codex`: code/repo tasks or tasks best handled by one Codex execution session.
- `agents`: pure planning, research, or synthesis where tool execution is light.
- `hybrid`: multi-step tasks with planning plus execution or verification. Safe default for complex tasks.

Checklist rules:

- Use 3 to 6 concrete checklist items in `plan`.
- Include a verification step for code, data changes, artifacts, operations, and publishing.
- `plan` is the user-confirmed TODO/checklist, not a generic software lifecycle template.
- Build `plan` from the user's goal plus the current `repoContext` and pending state; do not leave it empty.
- If you cannot derive at least 3 concrete checklist items from the goal and context, return `clarify` instead of `create_draft`.
- `goal` must distill the user's intent into a single direct sentence; keep it concise and use at most one comma. Do not expand it into explanation, plan, or scope narration.
- Avoid filler such as "analyze / design / code / test / deploy" unless those are truly the correct checklist items for this exact mission.
- For `category: "code"`, prefer repo-aware checklist items plus a fixed
  immutable prompt scaffold. Do not depend on host-side keyword heuristics to
  derive task type, scope, or template choice.
- `acceptanceCriteria` should describe how Mission Control knows the task is done.
- `immutablePrompt` should be reusable for every loop cycle of the mission.
- For `category: "code"`, include bilingual Conventional Commit requirements
  inside `immutablePrompt` whenever the mission allows repository changes.
- For `category: "code"`, explicitly require every loop cycle to update:
  - current checklist item status
  - overall completion
  - next step
  - latest blocker
  - latest progress summary
- Keep internal substeps/workpad refinement distinct from formal checklist
  mutation. If the formal checklist needs a split / append / reorder / merge /
  drop / rename change, express that as an explicit `PlanChangeRequest`-style
  suggestion rather than silently rewriting the confirmed checklist.
- For "只做方案", "不要改代码", "先分析", or similar, make the execution boundary explicit in `goal`, `expectedOutput`, and `plan`.
- Do not include `/agent confirm`, `/agent edit`, `/agent cancel`, or other command hints inside draft fields.
- Return the complete updated draft for `update_pending_draft`, not a patch.
- Preserve all fields the user did not ask to change.

## Action Schemas

### `create_draft`

Use for a new background Agent job.

```json
{
  "schemaVersion": "codexbridge.agent-command-skill.v1",
  "ok": true,
  "action": "create_draft",
  "confidence": 0.94,
  "requiresConfirmation": true,
  "draft": {
    "title": "修复测试失败项",
    "goal": "检查当前项目测试并修复失败项",
    "expectedOutput": "代码修复、测试结果和剩余风险说明，并返回当前微信会话。",
    "acceptanceCriteria": [
      "相关失败项已定位并修复",
      "至少一项相关验证已运行并给出结果",
      "返回剩余风险或阻塞说明"
    ],
    "immutablePrompt": "请围绕已确认 checklist 持续推进这条 Mission。每轮先检查工作区和当前分支，保护用户改动；只做与目标直接相关的最小改动；完成后返回可验证结果、剩余风险和下一步。",
    "loopPolicy": {
      "maxAttempts": 2,
      "maxTurns": 8,
      "maxCycles": null,
      "maxNoProgressCycles": 3
    },
    "plan": [
      "运行测试并定位失败项",
      "读取相关代码并制定最小修改方案",
      "修改代码并重新运行相关测试",
      "汇总修复内容、验证结果和风险"
    ],
    "category": "code",
    "riskLevel": "medium",
    "mode": "codex"
  }
}
```

### `update_pending_draft`

Use only when editing `pendingDraft`.

```json
{
  "schemaVersion": "codexbridge.agent-command-skill.v1",
  "ok": true,
  "action": "update_pending_draft",
  "confidence": 0.92,
  "requiresConfirmation": true,
  "draft": {
    "title": "测试修复方案",
    "goal": "检查当前项目测试失败原因，只输出修复方案，不直接改代码。",
    "expectedOutput": "一份修复方案和执行建议，不修改仓库文件。",
    "acceptanceCriteria": [
      "输出明确的修复方案",
      "说明建议的验证方式",
      "说明主要风险和执行顺序"
    ],
    "immutablePrompt": "请只做方案与分析，不修改代码。围绕已确认 checklist 输出可执行建议、验证方式和风险说明。",
    "loopPolicy": {
      "maxAttempts": 2,
      "maxTurns": 8,
      "maxCycles": null,
      "maxNoProgressCycles": 3
    },
    "plan": [
      "运行或查看测试失败信息",
      "定位相关代码和失败原因",
      "整理可行修复方案与风险",
      "返回建议的执行顺序"
    ],
    "category": "code",
    "riskLevel": "low",
    "mode": "hybrid"
  },
  "changes": ["Changed execution boundary to planning only."]
}
```

### Read-only existing-job actions

Use these for non-mutating requests:

```json
{
  "schemaVersion": "codexbridge.agent-command-skill.v1",
  "ok": true,
  "action": "query_jobs",
  "confidence": 0.95,
  "requiresConfirmation": false,
  "query": {
    "filterText": null
  }
}
```

```json
{
  "schemaVersion": "codexbridge.agent-command-skill.v1",
  "ok": true,
  "action": "show_job | show_result | export_result | send_attachments",
  "confidence": 0.9,
  "requiresConfirmation": false,
  "target": {
    "jobId": null,
    "index": 1,
    "matchText": "项目总结"
  }
}
```

Bridge may render the full list for `query_jobs` even when `filterText` is present.

### Mutating existing-job proposals

Use these for existing-job changes. They require `/agent confirm` before Bridge executes anything.

```json
{
  "schemaVersion": "codexbridge.agent-command-skill.v1",
  "ok": true,
  "action": "propose_update_job",
  "confidence": 0.9,
  "requiresConfirmation": true,
  "target": {
    "jobId": null,
    "index": 1,
    "matchText": "项目总结"
  },
  "patch": {
    "goal": "更新后的明确目标",
    "expectedOutput": "更新后的交付物",
    "plan": ["保留或更新后的步骤1", "保留或更新后的步骤2", "验证更新后的执行边界"],
    "riskLevel": "medium",
    "mode": "hybrid"
  },
  "changes": ["Changed goal and expected output for the next run."]
}
```

Patch fields are optional. Allowed patch fields: `title`, `goal`, `expectedOutput`, `plan`, `category`, `riskLevel`, `mode`. Include only fields the user wants to change.

```json
{
  "schemaVersion": "codexbridge.agent-command-skill.v1",
  "ok": true,
  "action": "propose_stop_job | propose_retry_job | propose_delete_job",
  "confidence": 0.9,
  "requiresConfirmation": true,
  "target": {
    "jobId": null,
    "index": 1,
    "matchText": "测试修复"
  },
  "reason": "用户要求对这个后台 Agent 任务执行该操作。"
}
```

```json
{
  "schemaVersion": "codexbridge.agent-command-skill.v1",
  "ok": true,
  "action": "propose_rename_job",
  "confidence": 0.9,
  "requiresConfirmation": true,
  "target": {
    "jobId": null,
    "index": 1,
    "matchText": "项目总结"
  },
  "newTitle": "四月项目总结"
}
```

### `clarify`

Use when intent or target is ambiguous.

```json
{
  "schemaVersion": "codexbridge.agent-command-skill.v1",
  "ok": false,
  "action": "clarify",
  "confidence": 0.45,
  "requiresConfirmation": false,
  "question": "你是想新增一个后台 Agent 任务，还是查看已有任务？",
  "candidates": [
    {
      "index": 1,
      "title": "项目总结",
      "status": "completed"
    }
  ]
}
```

### `reject`

Use when the request should not be handled by `/agent`.

```json
{
  "schemaVersion": "codexbridge.agent-command-skill.v1",
  "ok": false,
  "action": "reject",
  "confidence": 0.9,
  "requiresConfirmation": false,
  "reason": "这是定时任务，应该使用 /auto add 创建自动化。"
}
```

## Wording Map

- "帮我做/查/修/写/生成/整理..." with no clear existing target: `create_draft`.
- "改成/换成/补充/只做方案/不要改代码" with `pendingDraft`: `update_pending_draft`.
- "有哪些/列一下/看看任务": `query_jobs`.
- "打开/详情/看那个任务": `show_job`.
- "结果/完整结果/输出内容": `show_result`.
- "导出结果/结果发文件/保存成文件": `export_result`.
- "附件再发/重新发附件/把文件发我": `send_attachments`.
- "目标改成/交付物改成/计划改成/模式改成/风险改成" for an existing job: `propose_update_job`.
- "停掉/停止/别跑了/取消执行": `propose_stop_job`.
- "重跑/重新执行/再试一次/retry": `propose_retry_job`.
- "删除/删掉/清掉这个任务记录": `propose_delete_job`.
- "改名/重命名/标题改成": `propose_rename_job`.
- "每天/每周/定时/提醒我/到点运行": `reject` with `/auto add`.

## Final Checks

Before returning JSON, verify:

- The action is allowed for the current `subcommand`.
- Every existing-job target exists in `jobs`, or the response is `clarify`.
- Mutating existing-job actions set `requiresConfirmation: true`.
- Read-only result and attachment actions set `requiresConfirmation: false`.
- Drafts are complete, executable, and do not include command hints.
- Relative dates/times in meaningful task content are resolved using payload timezone/local time.
- The response is exactly one JSON object.
