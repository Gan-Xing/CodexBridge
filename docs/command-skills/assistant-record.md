# CodexBridge Command Skill: Assistant Records

## Purpose

This document defines how Codex should understand and normalize CodexBridge assistant-record slash commands when Bridge explicitly asks Codex to use this command skill.

Assistant records are personal WeChat records stored by Bridge. Codex may classify, route, or rewrite natural language, but Bridge is the only component allowed to create, update, complete, cancel, archive, confirm, or persist records.

Codex must return structured JSON only. Bridge validates the JSON, renders the WeChat response, stores pending drafts, and performs confirmed state changes.

## Invocation Model

Bridge invokes this skill only when semantic understanding is needed for these 10 forms:

1. `/as <natural language>`
2. `/as edit <natural language>`
3. `/log <natural language>`
4. `/log edit <natural language>`
5. `/todo <natural language>`
6. `/todo edit <natural language>`
7. `/remind <natural language>`
8. `/remind edit <natural language>`
9. `/note <natural language>`
10. `/note edit <natural language>`

Bridge sends a short instruction with a JSON payload like:

```json
{
  "command": "as | log | todo | remind | note",
  "subcommand": "natural | edit",
  "operation": "classify_new_record | route_existing_record | rewrite_record",
  "rawText": "the original user message",
  "userInput": "the natural-language part after the command",
  "forcedType": "log | todo | reminder | note | null",
  "now": "ISO timestamp",
  "locale": "zh-CN",
  "timezone": "Etc/UTC",
  "scope": {
    "platform": "weixin",
    "externalScopeId": "..."
  },
  "localDraft": null,
  "pendingRecord": null,
  "targetRecord": null,
  "records": [],
  "skillPath": "docs/command-skills/assistant-record.md"
}
```

Codex should read this file when asked, apply the rules below, and return one JSON object for the selected `operation`.

## Local-Only Subcommands

These subcommands do not need Codex semantic understanding and should be handled directly by Bridge:

- `/as`
- `/as list`
- `/as ls`
- `/as status`
- `/as search <keyword>`
- `/as show <index>`
- `/as done <index>`
- `/as complete <index>`
- `/as del <index>`
- `/as delete <index>`
- `/as archive <index>`
- `/as ok`
- `/as confirm`
- `/as cancel`
- `/<typed>`, where `<typed>` is `log`, `todo`, `remind`, or `note`
- `/<typed> list`
- `/<typed> ls`
- `/<typed> status`
- `/<typed> search <keyword>`
- `/<typed> show <index>`
- `/<typed> done <index>`
- `/<typed> complete <index>`
- `/<typed> del <index>`
- `/<typed> delete <index>`
- `/<typed> archive <index>`
- `/<typed> ok`
- `/<typed> confirm`
- `/<typed> cancel`
- `/<typed> cancel <index>`
- help flags such as `-h`, `--help`, `-help`, `-helps`

Natural-language view/list requests are also local-only, not new records. Examples:

- `/todo 给我看看现在还有哪些待办`
- `/todo 还有哪些`
- `/as 给我看看现在有哪些待办`
- `/remind 看看还有哪些提醒`
- `/note 列出现在的笔记`

These requests ask Bridge to show existing records. They must not be normalized as `classify_new_record`, even if they arrive after a typed command such as `/todo`.

If Codex is invoked for one of these by mistake, return:

```json
{
  "schemaVersion": "codexbridge.assistant-record-command-skill.v1",
  "ok": true,
  "operation": "local_only",
  "confidence": 1,
  "reason": "This command should be handled by Bridge locally."
}
```

## Record Types

Allowed `type` values:

- `log`: facts that already happened, daily records, test results, completed notes.
- `todo`: work the user needs to do, follow up, calculate, submit, verify, prepare, or finish.
- `reminder`: the user explicitly asks to be reminded, notified, called, or messaged at a time or recurrence.
- `note`: durable reference information, ideas, context, or knowledge with no required action.
- `uncategorized`: only when the type cannot be reliably determined.

When `forcedType` is not null:

- `/log` forces `type: "log"`.
- `/todo` forces `type: "todo"`.
- `/remind` forces `type: "reminder"`.
- `/note` forces `type: "note"`.
- The returned type must match `forcedType` unless the operation is `local_only`.

## Shared Rules

Codex must:

- Return strict JSON only. Do not use Markdown or explanation.
- Preserve user facts, names, projects, amounts, dates, and attachments context.
- Remove meta-instructions such as "帮我记录", "帮我整理", "给我列出来", "看看放哪里合适", "这个东西要记一下" from saved `content`.
- Keep `title` short; do not copy a long paragraph as title.
- Keep tags without the `#` prefix.
- Use `priority: "high"` when the user says urgent, important, must finish today, high priority, or equivalent.
- Use `dueAt` only for todo records.
- Use `remindAt` and `recurrence` only for reminder records.
- Use `null` instead of inventing unknown dates or times.

Codex must not:

- Create, update, complete, cancel, archive, or persist records directly.
- Send WeChat messages directly.
- Call browser automation, iLink, curl, or custom senders.
- Invent existing records that are not present in `records`, `pendingRecord`, or `targetRecord`.
- Silently choose among multiple existing records when the target is ambiguous.
- Treat "same category" or shared generic words as enough to update an existing record.

## Time Handling

Time conversion is mandatory for all five commands: `/as`, `/log`, `/todo`, `/remind`, and `/note`.

Bridge provides:

- `now`: the current UTC timestamp.
- `timezone`: the user's current timezone for this request.
- `localTime`: the same current moment rendered in that timezone.

Codex must treat `timezone` and `localTime` as authoritative. Do not use the server timezone, model runtime timezone, or a guessed location. If `timezone` is `Etc/UTC`, use UTC because that is the timezone Bridge supplied for this invocation.

All relative or fuzzy time expressions must be converted before returning JSON. This is not limited to the examples below. It includes any expression whose meaning depends on the current date, week, month, timezone, or context:

- Relative days: 今天, 明天, 后天, 大后天, 昨天, 前天, 今晚, 明早, 明晚, 后天上午
- Relative weeks: 本周, 这周, 下周, 下下周, 上周, 本周五, 下周三, 下周四, 下周末
- Relative months: 本月, 这个月, 下个月, 下下个月, 上个月, 月初, 月中, 月底, 下个月初, 下个月底
- Relative years or quarters: 今年, 明年, 去年, 本季度, 下季度, 年底, 明年初
- Deadline phrasing: 今天前, 明天前, 下周四前, 月底前, 下个月之前, 这两天, 最近几天, 过几天

Do not preserve these expressions as the time value. Do not return content whose only time reference is "今天", "昨天", "明天", "下周四", "下周三", "下个月", or similar wording. Use concrete absolute local dates or local date-times in user-visible text.

The absolute point must be specific enough to act on:

- If the user gives a date and time, compute that exact local date-time.
- If the user gives a date-like deadline for a `todo` but no time, use local `23:59` on that date.
- If the user gives a date-like fact for a `log` or `note` but no time, write the absolute local date.
- If the user gives a month-like deadline for a `todo`, such as "下个月" or "月底", resolve it to a concrete local date. Use the last day of that month at local `23:59` for "月底/下个月底"; use the first day of that month when the wording clearly says "月初".
- If the user says "下周三/下周四", resolve it to the actual calendar date in the supplied `timezone`, not a weekday label.
- If the user gives a reminder without enough time to schedule, do not invent a random hour. Return `remindAt: null`, but still convert the date part in `content` and make clear that a specific reminder time is missing.

Formatting rules:

- In `content`, write dates as `YYYY-MM-DD <timezone>` when only a date is known.
- In `content`, write date-times as `YYYY-MM-DD HH:mm <timezone>` when a time is known.
- `dueAt` and `remindAt` must be ISO-8601 timestamps representing the exact instant in the provided `timezone`, or `null`.
- `content`, `dueAt`, `remindAt`, and `recurrence` must agree with each other.
- `changeSummary` may mention the user's wording, but if it describes a time change, include the absolute date or date-time too.

Type-specific rules:

- For `todo`, if the user gives a date but no time, set `dueAt` to local `23:59` on that date.
- For `todo`, if the user says "今天必须做完", "明天前", or equivalent, convert the due date using the provided timezone.
- For `reminder`, only set `remindAt` when the reminder time is specific enough to schedule. "明天上午10点" is specific; "明天提醒我一下" is not specific enough unless the user or existing record already provides a time.
- For `reminder`, if the user gives only a vague date without a time, keep `remindAt: null` and make the missing time clear in `content`.
- For `log`, relative dates describe when something happened. Convert "昨天完成了..." into an absolute local date in `content`.
- For `note`, preserve useful time context, but still convert relative time words to absolute local dates if they are factual context.

## Operation: `classify_new_record`

Use for:

- `/as <natural language>` when Bridge has decided this is a new record.
- `/log <natural language>` when `route_existing_record` has decided this is a new log.
- `/todo <natural language>` when `route_existing_record` has decided this is a new todo.
- `/remind <natural language>` when `route_existing_record` has decided this is a new reminder.
- `/note <natural language>` when `route_existing_record` has decided this is a new note.

Bridge stores new natural-language records as pending and applies them only after the user confirms with the matching command, such as `/as ok`, `/todo ok`, `/log ok`, `/remind ok`, or `/note ok`.

Return this schema:

```json
{
  "schemaVersion": "codexbridge.assistant-record-command-skill.v1",
  "operation": "classify_new_record",
  "type": "log | todo | reminder | note | uncategorized",
  "title": "short title",
  "content": "complete content to save for the user",
  "priority": "low | normal | high",
  "dueAt": null,
  "remindAt": null,
  "recurrence": null,
  "project": null,
  "tags": [],
  "confidence": 0.94
}
```

Examples:

```json
{
  "schemaVersion": "codexbridge.assistant-record-command-skill.v1",
  "operation": "classify_new_record",
  "type": "todo",
  "title": "停机坪成本和报价测算",
  "content": "2026-04-30 UTC 必须完成停机坪的成本和报价测算。",
  "priority": "high",
  "dueAt": "2026-04-30T23:59:00.000Z",
  "remindAt": null,
  "recurrence": null,
  "project": null,
  "tags": [],
  "confidence": 0.95
}
```

```json
{
  "schemaVersion": "codexbridge.assistant-record-command-skill.v1",
  "operation": "classify_new_record",
  "type": "reminder",
  "title": "提醒给王总回电话",
  "content": "2026-05-01 10:00 UTC 提醒给王总回电话。",
  "priority": "normal",
  "dueAt": null,
  "remindAt": "2026-05-01T10:00:00.000Z",
  "recurrence": null,
  "project": null,
  "tags": [],
  "confidence": 0.96
}
```

## Operation: `route_existing_record`

Use for any natural-language assistant-record command when Bridge provides existing candidate `records`:

- `/as <natural language>` with `forcedType: null`
- `/log <natural language>` with `forcedType: "log"`
- `/todo <natural language>` with `forcedType: "todo"`
- `/remind <natural language>` with `forcedType: "reminder"`
- `/note <natural language>` with `forcedType: "note"`

Return whether the user is creating a new record or managing one existing record. This is the natural-language equivalent of choosing among the local assistant-record commands: create a new record, update a matched record, mark a matched record complete, cancel a matched record, or archive/delete a matched record.

When `forcedType` is not null, route only among records of that type and keep returned `type` equal to `forcedType`.

Return this schema:

```json
{
  "schemaVersion": "codexbridge.assistant-record-command-skill.v1",
  "operation": "route_existing_record",
  "action": "create | update | complete | cancel | archive | none",
  "targetRecordId": null,
  "targetIndex": null,
  "type": "log | todo | reminder | note | uncategorized | null",
  "reason": "brief reason",
  "confidence": 0.91
}
```

Routing rules:

- Use `create` when the user describes a new thing to save, even if old records share broad words.
- Use `update` only when the user clearly modifies or adds progress to one existing concrete record.
- Use `complete` only when the user says a clearly matched record is finished.
- Use `cancel` only when the user says a clearly matched record is no longer needed.
- Use `archive` only when the user says to delete, remove, or archive a clearly matched record.
- Use `none` when the request cannot be understood.
- If the target is ambiguous, return `create` or `none`; do not choose a destructive target.
- For `update`, `complete`, `cancel`, and `archive`, Bridge will show a confirmation draft and apply it only after the user confirms.
- If the user says "第一条", "第一个", or similar, use the provided `records[index]` order within the current command scope. With `/todo`, "第一条" means the first todo candidate, not the first record of all types.

Examples:

```json
{
  "schemaVersion": "codexbridge.assistant-record-command-skill.v1",
  "operation": "route_existing_record",
  "action": "complete",
  "targetRecordId": "record-id-from-input",
  "targetIndex": 1,
  "type": "todo",
  "reason": "用户明确表示给王总回电话这件事已经完成。",
  "confidence": 0.94
}
```

```json
{
  "schemaVersion": "codexbridge.assistant-record-command-skill.v1",
  "operation": "route_existing_record",
  "action": "create",
  "targetRecordId": null,
  "targetIndex": null,
  "type": "reminder",
  "reason": "用户要求新增一个提醒，没有唯一指向已有记录。",
  "confidence": 0.9
}
```

## Operation: `rewrite_record`

Use for:

- `/as edit <natural language>`
- `/log edit <natural language>`
- `/todo edit <natural language>`
- `/remind edit <natural language>`
- `/note edit <natural language>`
- `/as <natural language>` after `route_existing_record` selected `update`
- `/<typed> <natural language>` after `route_existing_record` selected `update`, where `<typed>` is `log`, `todo`, `remind`, or `note`

Bridge provides `pendingRecord` or `targetRecord`.

Return the complete rewritten record, not a patch.

Return this schema:

```json
{
  "schemaVersion": "codexbridge.assistant-record-command-skill.v1",
  "operation": "rewrite_record",
  "action": "update",
  "type": "log | todo | reminder | note | uncategorized",
  "title": "short title",
  "content": "complete merged content",
  "status": "pending | active | done | cancelled | archived",
  "priority": "low | normal | high",
  "dueAt": null,
  "remindAt": null,
  "recurrence": null,
  "project": null,
  "tags": [],
  "changeSummary": "what changed",
  "confidence": 0.93
}
```

Rewrite rules:

- `content` must be the full merged record content, not just the user's latest instruction.
- Preserve original facts unless the user explicitly corrects or removes them.
- If the user says "不是 A，是 B", replace A with B.
- If the user changes time, update `content`, `dueAt`, `remindAt`, and `recurrence` consistently.
- For forced-type edit commands, preserve `forcedType`.
- For pending-record edits, keep `status: "pending"` unless the user explicitly asks to cancel or complete.
- For existing active-record updates, preserve the existing status unless the user clearly changes it.
- Do not use `status: "pending"` to mean "this update needs confirmation"; Bridge handles the confirmation draft separately.

Example:

```json
{
  "schemaVersion": "codexbridge.assistant-record-command-skill.v1",
  "operation": "rewrite_record",
  "action": "update",
  "type": "reminder",
  "title": "提醒给李总回电话",
  "content": "2026-05-01 11:00 UTC 提醒给李总回电话。",
  "status": "pending",
  "priority": "normal",
  "dueAt": null,
  "remindAt": "2026-05-01T11:00:00.000Z",
  "recurrence": null,
  "project": null,
  "tags": ["客户", "重要客户"],
  "changeSummary": "把王总改为李总，将提醒时间改为 11:00，并补充重要客户标签。",
  "confidence": 0.95
}
```
