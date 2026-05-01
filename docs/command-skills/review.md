# CodexBridge Command Skill: /review

## Purpose

This file defines how Codex should understand and normalize natural-language CodexBridge `/review` requests when Bridge explicitly asks Codex to use this project-local command skill.

`/review` is a read-only code-review command. Codex may classify the user's intent and choose a review target, but Bridge is the only component allowed to invoke the actual review execution path.

Return exactly one JSON object. Do not use Markdown, prose, code fences, tool calls, or side effects.

## Invocation

Bridge invokes this skill only for semantic forms such as:

1. `/review <natural language>`
2. `/rv <natural language>`

Bridge should continue handling these forms locally:

- `/review`
- `/review base <branch>`
- `/review commit <sha>`
- `/review custom <instructions>`
- `/review -h`
- `/review --help`

Bridge sends a prompt with a payload similar to:

```json
{
  "command": "review",
  "subcommand": "natural",
  "rawText": "original user message",
  "userInput": "natural-language part after /review",
  "now": "ISO timestamp",
  "locale": "zh-CN",
  "scope": {
    "platform": "weixin",
    "externalScopeId": "..."
  },
  "cwd": "/path/to/repo",
  "capabilities": {
    "supportedTargets": [
      "uncommittedChanges",
      "baseBranch",
      "commit",
      "custom"
    ],
    "customOptions": [
      "instructions",
      "focus",
      "includePaths",
      "excludePaths"
    ]
  },
  "skillPath": "docs/command-skills/review.md"
}
```

## Output Contract

Every response must include:

```json
{
  "schemaVersion": "codexbridge.review-command-skill.v1",
  "ok": true,
  "action": "run_review | clarify | reject | local_only",
  "confidence": 0.9,
  "requiresConfirmation": false
}
```

Use `ok: false` for `clarify` and `reject`. `/review` never needs confirmation.

## Action Types

### `run_review`

Use this when the user clearly wants Bridge to run a code review.

```json
{
  "schemaVersion": "codexbridge.review-command-skill.v1",
  "ok": true,
  "action": "run_review",
  "confidence": 0.94,
  "requiresConfirmation": false,
  "target": {
    "type": "uncommittedChanges"
  }
}
```

Supported `target.type` values:

1. `uncommittedChanges`
   Use when the user wants to review current local changes.

```json
{
  "type": "uncommittedChanges"
}
```

2. `baseBranch`
   Use when the user clearly wants to compare against a branch.

```json
{
  "type": "baseBranch",
  "branch": "main"
}
```

3. `commit`
   Use when the user clearly wants to review one commit.

```json
{
  "type": "commit",
  "sha": "HEAD~1",
  "title": null
}
```

`title` is optional. Only include it when the user explicitly names the commit review.

4. `custom`
   Use when the user gives a custom review instruction that is better expressed as a prompt than as a plain base/commit/uncommitted target.

```json
{
  "type": "custom",
  "instructions": "只审查 Agent 状态流转相关的改动，重点看回归风险。",
  "focus": [
    "状态流转",
    "回归风险"
  ],
  "includePaths": [
    "src/core/bridge_coordinator.ts",
    "test/core/bridge_coordinator.test.ts"
  ],
  "excludePaths": [
    "docs/"
  ]
}
```

### `custom` target schema

These fields define the structured custom review request:

- `instructions`: required string
  The primary review request Bridge should execute.

- `focus`: optional string array
  Topics or risk areas to pay extra attention to.
  Examples: `["tests", "state transitions", "regression risk"]`

- `includePaths`: optional string array
  Preferred files or directories to focus on.
  Examples: `["src/core/", "test/core/bridge_coordinator.test.ts"]`

- `excludePaths`: optional string array
  Files or directories to avoid unless necessary.
  Examples: `["docs/", "dist/"]`

### Important custom-target limits

- `custom` is prompt-driven. Use it when the user mainly wants a focused review instruction.
- Do not pretend that `custom` can safely combine all diff selectors with all filters.
- If the user clearly asks for a branch diff, prefer `baseBranch`.
- If the user clearly asks for one commit, prefer `commit`.
- Bridge language should stay in sync with review output. `/review` output language follows the invocation `locale`.
- If the user asks for combinations that the underlying review path may not support reliably, such as:
  - "跟 main 比，只看测试目录"
  - "检查上一个提交，但忽略 docs"
  then return `clarify` unless one interpretation is clearly dominant.

## Clarify

Use `clarify` when the review target is ambiguous or when the user mixes incompatible intents.

```json
{
  "schemaVersion": "codexbridge.review-command-skill.v1",
  "ok": false,
  "action": "clarify",
  "confidence": 0.42,
  "requiresConfirmation": false,
  "question": "你是要审查当前未提交改动，还是要相对 main 做分支对比？",
  "candidates": [
    { "label": "当前未提交改动" },
    { "label": "相对 main 的分支对比" }
  ]
}
```

## Reject

Use `reject` when the request should not be handled by `/review`.

Examples:

- the user actually wants code changes performed, not just review
- the user wants a background multi-step execution job
- the user wants a scheduled recurring check

```json
{
  "schemaVersion": "codexbridge.review-command-skill.v1",
  "ok": false,
  "action": "reject",
  "confidence": 0.97,
  "requiresConfirmation": false,
  "reason": "这是执行或修复请求，不是只读审查。应该使用 /agent。"
}
```

## Local-Only

Use `local_only` when the request is really asking for a command Bridge already handles directly.

```json
{
  "schemaVersion": "codexbridge.review-command-skill.v1",
  "ok": true,
  "action": "local_only",
  "confidence": 1,
  "requiresConfirmation": false,
  "reason": "This request should be handled by Bridge locally."
}
```

## Routing Rules

Prefer these mappings:

- "看看当前改动有没有问题" -> `uncommittedChanges`
- "跟 main 比一下" -> `baseBranch`
- "看下 HEAD~1 这个提交" -> `commit`
- "重点看测试和状态流转" -> `custom`
- "帮我修一下这些问题" -> `reject` to `/agent`
- "每天晚上检查这次改动有没有风险" -> `reject` to `/auto`

## Final Checks

Before returning:

1. Make sure the JSON is valid.
2. Make sure the chosen action fits `/review`.
3. Make sure `target` matches one supported target type.
4. For `custom`, make sure `instructions` is concrete and non-empty.
5. Do not invent branches, commits, files, or repository facts that are not clearly implied.
