# CodexBridge Command Skill: /auto

## Purpose

This document defines how Codex should understand and normalize the CodexBridge `/auto` slash command when Bridge explicitly asks Codex to use this command skill.

`/auto` manages scheduled automation jobs. Codex may help interpret natural language, but Bridge is the only component allowed to create, update, pause, resume, delete, or persist automation jobs.

Codex must return structured JSON only. Bridge validates the JSON, renders the user-facing WeChat response, stores pending drafts, and performs confirmed state changes.

## Invocation Model

Bridge invokes this skill only when semantic understanding is needed.

Bridge should send Codex a short instruction containing:

```json
{
  "command": "auto",
  "subcommand": "add | edit | natural | unknown",
  "rawText": "the original user message",
  "userInput": "the natural-language part after /auto or /auto add/edit",
  "now": "ISO timestamp",
  "locale": "zh-CN",
  "scope": {
    "platform": "weixin",
    "externalScopeId": "..."
  },
  "pendingDraft": null,
  "jobs": [],
  "skillPath": "docs/command-skills/auto.md"
}
```

Codex should read this file when asked, apply the rules below, and return one JSON object.

## Local-Only Subcommands

These subcommands do not need Codex semantic understanding and should normally be handled directly by Bridge:

- `/auto`
- `/auto list`
- `/auto show <index>`
- `/auto confirm`
- `/auto cancel`
- `/auto pause <index>`
- `/auto resume <index>`
- `/auto delete <index>`
- `/auto del <index>`
- `/auto rename <index> <title>`
- `/auto -h`
- `/auto help`

If Codex is invoked for one of these by mistake, return:

```json
{
  "schemaVersion": "codexbridge.auto-command-skill.v1",
  "ok": true,
  "action": "local_only",
  "confidence": 1,
  "requiresConfirmation": false,
  "localCommand": {
    "command": "auto",
    "subcommand": "list | show | confirm | cancel | pause | resume | delete | rename | help",
    "args": []
  },
  "message": "This command should be handled by Bridge locally."
}
```

## Model-Assisted Cases

Codex should handle these cases:

1. `/auto add <natural language>`
   - Create an automation draft from natural language.
   - If the input uses an explicit machine format such as `every 30m | task`, Bridge may parse it locally before invoking Codex.

2. `/auto edit <natural language>`
   - Merge the edit instruction into the current pending draft.
   - Preserve fields the user did not ask to change.

3. `/auto <natural language>`
   - Route the user's intent.
   - The user may mean add, edit pending draft, update existing job, delete existing job, pause, resume, show, or list.
   - Potentially destructive actions must become proposals that require confirmation.

## Safety Boundary

Codex must not:

- Create, update, pause, resume, delete, or persist automation jobs directly.
- Send WeChat messages directly.
- Call browser automation, iLink, curl, or custom senders.
- Treat ambiguous destructive requests as confirmed.
- Invent existing jobs that are not present in the `jobs` input.
- Silently choose among multiple matching jobs for destructive or mutating actions.

Codex should:

- Return `requiresConfirmation: true` for any create, update, delete, pause, resume, or rename proposal.
- Return `action: "clarify"` when the target job or user intent is ambiguous.
- Prefer conservative interpretations when the request can affect existing schedules.
- Preserve concrete times, dates, recurrence rules, task wording, skill names, delivery requirements, cwd, provider profile, and mode.
- Keep "send to WeChat", "notify me", and similar delivery intent in the automation task text; Bridge handles actual delivery.

## Action Types

### `create_draft`

Use for `/auto add ...` or `/auto <natural language>` when the user wants a new automation job.

```json
{
  "schemaVersion": "codexbridge.auto-command-skill.v1",
  "ok": true,
  "action": "create_draft",
  "confidence": 0.94,
  "requiresConfirmation": true,
  "draft": {
    "title": "short title",
    "mode": "standalone",
    "schedules": [
      {
        "kind": "daily",
        "hour": 8,
        "minute": 0,
        "timeZone": "UTC",
        "label": "daily 08:00 UTC"
      }
    ],
    "task": "complete task text to send to Codex on each run"
  },
  "renderHint": {
    "title": "自动化草案 | short title",
    "summary": "用户确认后创建自动化任务。"
  }
}
```

Allowed `mode` values:

- `standalone`
- `thread`

Default mode is `standalone`. Use `thread` only when the user explicitly asks to continue the current thread, current conversation, or current context.

Allowed schedule kinds:

- `interval`
- `daily`
- `cron`

Interval schedule:

```json
{
  "kind": "interval",
  "everySeconds": 1800,
  "label": "every 30m"
}
```

Daily schedule:

```json
{
  "kind": "daily",
  "hour": 8,
  "minute": 0,
  "timeZone": "UTC",
  "label": "daily 08:00 UTC"
}
```

Cron schedule:

```json
{
  "kind": "cron",
  "expression": "0 18 * * 1-5",
  "timeZone": "UTC",
  "label": "cron 0 18 * * 1-5 UTC"
}
```

For multiple independent run times, return multiple schedules.

### `update_pending_draft`

Use for `/auto edit ...` or `/auto <natural language>` when a pending draft exists and the user clearly wants to modify it.

```json
{
  "schemaVersion": "codexbridge.auto-command-skill.v1",
  "ok": true,
  "action": "update_pending_draft",
  "confidence": 0.91,
  "requiresConfirmation": true,
  "draft": {
    "title": "updated title",
    "mode": "standalone",
    "schedules": [
      {
        "kind": "daily",
        "hour": 17,
        "minute": 30,
        "timeZone": "UTC",
        "label": "daily 17:30 UTC"
      }
    ],
    "task": "preserved or updated task text"
  },
  "changes": [
    "Changed schedule from daily 08:00 UTC to daily 17:30 UTC.",
    "Preserved task text."
  ]
}
```

Rules:

- If the user says "任务不变", "内容不变", or similar, preserve the current task exactly.
- If the user only changes the task, preserve the current schedules.
- If the user only changes time, preserve title, mode, and task unless a title change is implied.
- If no pending draft exists, return `clarify` unless the user clearly wants to update an existing job.

### `propose_update_job`

Use when the user wants to modify an existing automation job.

```json
{
  "schemaVersion": "codexbridge.auto-command-skill.v1",
  "ok": true,
  "action": "propose_update_job",
  "confidence": 0.88,
  "requiresConfirmation": true,
  "target": {
    "jobId": "job-id-if-known",
    "index": 1,
    "matchText": "user-visible match text"
  },
  "patch": {
    "title": "optional updated title",
    "mode": "standalone",
    "schedules": [
      {
        "kind": "cron",
        "expression": "0 18 * * 1-5",
        "timeZone": "UTC",
        "label": "cron 0 18 * * 1-5 UTC"
      }
    ],
    "task": "optional updated task text"
  },
  "changes": [
    "Changed schedule to workdays at 18:00 UTC."
  ]
}
```

Rules:

- Use job IDs or indexes only from the `jobs` input.
- If multiple jobs match, return `clarify` with candidates.
- Do not assume the user wants to update a job when they might be creating a new one.

### `propose_delete_job`

Use when the user wants to stop an existing automation permanently.

```json
{
  "schemaVersion": "codexbridge.auto-command-skill.v1",
  "ok": true,
  "action": "propose_delete_job",
  "confidence": 0.9,
  "requiresConfirmation": true,
  "target": {
    "jobId": "job-id-if-known",
    "index": 1,
    "matchText": "微博热搜"
  },
  "reason": "The user asked to stop sending this automation."
}
```

Use this for wording such as:

- "不要再..."
- "删掉..."
- "取消这个自动任务"
- "以后别发..."

If "停止" could mean pause instead of delete, return `clarify`.

### `propose_pause_job`

Use when the user wants to temporarily pause an existing job.

```json
{
  "schemaVersion": "codexbridge.auto-command-skill.v1",
  "ok": true,
  "action": "propose_pause_job",
  "confidence": 0.89,
  "requiresConfirmation": true,
  "target": {
    "jobId": "job-id-if-known",
    "index": 1,
    "matchText": "早报"
  }
}
```

### `propose_resume_job`

Use when the user wants to resume a paused job.

```json
{
  "schemaVersion": "codexbridge.auto-command-skill.v1",
  "ok": true,
  "action": "propose_resume_job",
  "confidence": 0.89,
  "requiresConfirmation": true,
  "target": {
    "jobId": "job-id-if-known",
    "index": 1,
    "matchText": "早报"
  }
}
```

### `propose_rename_job`

Use when the user wants to rename an existing job in natural language.

```json
{
  "schemaVersion": "codexbridge.auto-command-skill.v1",
  "ok": true,
  "action": "propose_rename_job",
  "confidence": 0.88,
  "requiresConfirmation": true,
  "target": {
    "jobId": "job-id-if-known",
    "index": 1,
    "matchText": "待办检查"
  },
  "newTitle": "每日待办检查"
}
```

### `query_jobs`

Use when the user is asking to see jobs or asking what automations exist.

```json
{
  "schemaVersion": "codexbridge.auto-command-skill.v1",
  "ok": true,
  "action": "query_jobs",
  "confidence": 0.95,
  "requiresConfirmation": false,
  "query": {
    "filterText": "optional filter text"
  }
}
```

Bridge should render the list locally.

### `show_job`

Use when the user asks to inspect one existing job.

```json
{
  "schemaVersion": "codexbridge.auto-command-skill.v1",
  "ok": true,
  "action": "show_job",
  "confidence": 0.92,
  "requiresConfirmation": false,
  "target": {
    "jobId": "job-id-if-known",
    "index": 1,
    "matchText": "待办检查"
  }
}
```

If multiple jobs match, return `clarify`.

### `clarify`

Use when Codex cannot safely infer the user's intent or target.

```json
{
  "schemaVersion": "codexbridge.auto-command-skill.v1",
  "ok": false,
  "action": "clarify",
  "confidence": 0.45,
  "requiresConfirmation": false,
  "question": "你是想新增一个自动任务，还是修改已有任务？",
  "candidates": [
    {
      "index": 1,
      "title": "每日待办检查",
      "schedule": "daily 08:00 UTC"
    }
  ]
}
```

### `reject`

Use when the user requests behavior outside the automation boundary.

```json
{
  "schemaVersion": "codexbridge.auto-command-skill.v1",
  "ok": false,
  "action": "reject",
  "confidence": 1,
  "requiresConfirmation": false,
  "reason": "This request cannot be handled by /auto."
}
```

## Ambiguity Rules

When both create and update are plausible:

- If a pending draft exists and the user says "改成", "换成", "时间改", "内容不变", prefer `update_pending_draft`.
- If no pending draft exists and a job clearly matches the user's text, prefer `propose_update_job`.
- If no pending draft exists and no job clearly matches, prefer `create_draft` when the request contains a schedule.
- If the request lacks a schedule and does not clearly target an existing job, return `clarify`.

When both pause and delete are plausible:

- "暂停", "先别", "暂时不要" means `propose_pause_job`.
- "删除", "取消这个任务", "以后不要再", "不要再发" usually means `propose_delete_job`.
- If wording is unclear, return `clarify`.

## Examples

### Create

Input:

```text
/auto 每天早上8点、中午13点、下午17点半检查 CodexBridge 助理记录并发微信
```

Output:

```json
{
  "schemaVersion": "codexbridge.auto-command-skill.v1",
  "ok": true,
  "action": "create_draft",
  "confidence": 0.94,
  "requiresConfirmation": true,
  "draft": {
    "title": "助理记录检查",
    "mode": "standalone",
    "schedules": [
      {
        "kind": "daily",
        "hour": 8,
        "minute": 0,
        "timeZone": "UTC",
        "label": "daily 08:00 UTC"
      },
      {
        "kind": "daily",
        "hour": 13,
        "minute": 0,
        "timeZone": "UTC",
        "label": "daily 13:00 UTC"
      },
      {
        "kind": "daily",
        "hour": 17,
        "minute": 30,
        "timeZone": "UTC",
        "label": "daily 17:30 UTC"
      }
    ],
    "task": "检查 CodexBridge 助理记录里的代办、提醒、逾期事项、近期截止、待确认事项和需要注意的事情，输出适合微信阅读的中文助理检查。只返回最终文本，不要寻找微信连接器，不要直接调用微信接口；把最终结果作为 final answer 返回，由 CodexBridge 通过正常 SendGate 队列发送到微信。"
  },
  "renderHint": {
    "title": "自动化草案 | 助理记录检查",
    "summary": "用户确认后创建 3 个每日自动任务。"
  }
}
```

### Edit Pending Draft

Input:

```text
/auto 时间改成工作日下午6点，任务内容不变
```

Output:

```json
{
  "schemaVersion": "codexbridge.auto-command-skill.v1",
  "ok": true,
  "action": "update_pending_draft",
  "confidence": 0.91,
  "requiresConfirmation": true,
  "draft": {
    "title": "助理记录检查",
    "mode": "standalone",
    "schedules": [
      {
        "kind": "cron",
        "expression": "0 18 * * 1-5",
        "timeZone": "UTC",
        "label": "cron 0 18 * * 1-5 UTC"
      }
    ],
    "task": "original task text from pendingDraft"
  },
  "changes": [
    "Changed schedule to workdays at 18:00 UTC.",
    "Preserved task text."
  ]
}
```

### Delete Existing Job

Input:

```text
/auto 不要再发微博热搜了
```

Output:

```json
{
  "schemaVersion": "codexbridge.auto-command-skill.v1",
  "ok": true,
  "action": "propose_delete_job",
  "confidence": 0.9,
  "requiresConfirmation": true,
  "target": {
    "jobId": "job-id-from-jobs-input",
    "index": 1,
    "matchText": "微博热搜"
  },
  "reason": "The user asked not to send the Weibo hot-search automation anymore."
}
```

### Clarify

Input:

```text
/auto 改一下待办那个
```

Output:

```json
{
  "schemaVersion": "codexbridge.auto-command-skill.v1",
  "ok": false,
  "action": "clarify",
  "confidence": 0.42,
  "requiresConfirmation": false,
  "question": "你想把待办自动任务改成什么时间或什么内容？",
  "candidates": [
    {
      "index": 1,
      "title": "每日待办检查",
      "schedule": "daily 08:00 UTC"
    }
  ]
}
```

## Bridge Rendering Contract

Codex should not write the final WeChat message as the primary result. Bridge renders the user-facing message from the JSON.

For actions with `requiresConfirmation: true`, Bridge should create a pending automation operation and show:

- action label
- target job or draft title
- schedule summary
- task summary
- changed fields
- confirmation command: `/auto confirm`
- cancellation command: `/auto cancel`

For `clarify`, Bridge should send `question` and candidates.

For `query_jobs` and `show_job`, Bridge should render current local job data.

## Confirmation Contract

`/auto confirm` must be local-only. It executes the current pending operation created from a previous Codex JSON result.

Supported pending operation types:

- create draft/job
- update pending draft
- update existing job
- delete existing job
- pause existing job
- resume existing job
- rename existing job

If there is no pending operation, Bridge should return the local "no draft" message.

