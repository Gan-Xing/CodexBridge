# Weixin Slash Commands

This document describes the current text-first slash command surface for the WeChat bridge.

## Locale

Slash-command replies now go through the shared i18n layer.

- Supported locales:
  - `zh-CN`
  - `en`
- Command-level precedence: `/lang` value overrides scope override and environment default for that scope/session.
- Default locale: `zh-CN`
- Override with:
  - `CODEXBRIDGE_LOCALE=zh-CN`
  - `CODEXBRIDGE_LOCALE=en`

Example:

```bash
CODEXBRIDGE_LOCALE=en npm run weixin:serve
```

## Design Rule

The WeChat bridge is not a strict shell CLI.
It borrows the most useful CLI help conventions while staying chat-friendly:

- `/helps` shows the full command catalog
- `/helps <command>` shows one command in detail
- every slash command supports `-h`, `--help`, `-help`, and `-helps`
- every slash command also supports a short alias such as `/h`, `/st`, `/us`, `/lg`, `/sp`, `/rv`, `/ag`, `/sk`, `/n`, `/up`, `/as`, `/td`, `/rmd`, `/nt`, `/pd`, `/ms`, `/m`, `/psn`, `/ins`, `/th`, `/se`, `/nx`, `/pv`, `/o`, `/pk`, `/rn`, `/perm`, `/al`, `/dn`, `/rc`, `/rt`, and `/rs`
- `/lang` and `/lang <zh|en>` to switch reply language for this scope (higher priority than env).
- thread browsing is index-first on WeChat, so `/open 2` is preferred over copying raw thread ids

## Fast Start

```text
/helps
/h
/st
/login
/lg
/login list
/review
/rv
/review base main
/review commit HEAD~1
/agent 帮我检查当前项目测试并修复失败项
/agent confirm
/agent show 1
/agent result 1
/agent result 1 file
/agent send 1
/skills
/sk
/skills search 新闻
/skills show 1
/plugins
/pg
/pg search 日记
/pg show 1
/auto
/auto add 每30分钟检查一次系统状态，有变化发送给我
/auto confirm
/auto list
/auto rename 1 晚间部署巡检
/auto del 1
/as 今天修复了 /pg search 日记召回太宽的问题 #CodexBridge
/as 明天上午10点提醒我给王总回电话
/as ok
/as 给王总回电话这件事已经完成了
/as ok
/log 今天测试微信桥接，发现插件搜索需要更高相关度
/todo 检查服务器磁盘空间
/todo done 1
/remind 每周一早上9点提醒我看项目进度
/note Notion 适合结构化日志，Google Drive 适合导出归档
/stop
/sp
/provider
/pd
/threads
/th
/search bridge
/se bridge
/next
/nx
/prev
/pv
/open 2
/o 2
/peek 2
/pk 2
/rename 2 微信桥接排障
/rn 2 微信桥接排障
/model
/m
/model gpt-5.4
/model default
/models
/ms
/lang zh
/personality
/psn pragmatic
/instructions
/instructions edit
/permissions
/perm
/allow
/al
/allow 1
/allow 2
/deny
/dn
/retry
/rt
```

## Command Catalog

### `/helps`, `/help`, and `/h`

Show all slash commands, or show help for one command.

Examples:

```text
/helps
/helps threads
/help open
/h
```

### `/status`, `/where`, and `/st`

Show the current scope binding, provider profile, Codex thread, access settings, and active-turn state.

Examples:

```text
/status
/where
/st
```

### `/login` and `/lg`

Manage the host Codex login account pool.

- `/login` starts or refreshes a pending device login flow
- `/login list` shows the locally saved account pool
- `/login <index>` switches the active host Codex login
- `/login cancel` cancels the pending device login flow

Examples:

```text
/login
/lg
/login list
/login 1
/login cancel
```

### `/stop` and `/sp`

Request an interrupt for the active Codex turn.
`/stop` is the canonical command shown to WeChat users.

Examples:

```text
/stop
/sp
```

### `/review` and `/rv`

Run a native Codex code review for the current workspace changes.

- `/review` reviews uncommitted changes
- `/review base <branch>` reviews the diff against a base branch
- `/review commit <sha>` reviews the changes introduced by a commit
- the bridge returns the native text review result directly to WeChat
- it does not switch the current thread binding

Examples:

```text
/review
/rv
/review base main
/review commit HEAD~1
```

### `/agent` and `/ag`

Create a confirmed background Agent job for deeper multi-step work.

- `/agent <task>` creates a draft instead of executing immediately
- `/agent confirm` confirms the draft and queues the background job
- `/agent edit <change instruction>` refines the current draft by merging the new instruction back into the existing draft
- `/agent list` lists jobs for the current WeChat chat
- `/agent show <index>` shows the plan, status, attempts, and verifier result
- `/agent result <index>` shows the full text result in pages
- `/agent result <index> file` exports the full text result as a phone-friendly TXT attachment
- `/agent send <index>` resends saved attachments for a completed job
- `/agent stop <index>` requests stop for the job
- `/agent retry <index>` queues a failed/stopped/completed job again
- `/agent rename <index> <title>` updates the local job title
- `/agent del <index>` deletes the job record

Examples:

```text
/agent 检查当前项目测试并修复失败项
/ag 写一份 CodexBridge Agent 接入方案
/agent confirm
/agent edit 只做方案，不改代码
/agent list
/agent show 1
/agent result 1
/agent result 1 2
/agent result 1 file
/agent send 1
/agent stop 1
/agent retry 1
/agent del 1
```

Implementation note: the workflow is Codex-first hybrid. Codex app-server is preferred for planning, execution, and semantic verification, so a host Codex subscription is used by default. OpenAI Agents SDK is only a fallback when `CODEXBRIDGE_AGENT_API_KEY` or `OPENAI_API_KEY` is configured and the Codex normalization/verifier path is unavailable. Long text results are kept separately from the preview, so `/agent result <index>` can page through the full answer and `/agent result <index> file` can export it as phone-friendly TXT. Jobs with generated attachments keep artifact records, so `/agent send <index>` can resend the file if WeChat rate-limits the first delivery. If both Codex and Agents SDK normalization are unavailable, local fallback keeps the command usable.

MiniMax/OpenAI-compatible example:

```bash
CODEXBRIDGE_AGENT_API_KEY=...
CODEXBRIDGE_AGENT_BASE_URL=https://api.minimax.io/v1
CODEXBRIDGE_AGENT_MODEL=MiniMax-M2.7
CODEXBRIDGE_AGENT_API=chat_completions
```

### `/as`, `/log`, `/todo`, `/remind`, and `/note`

Save personal assistant records from WeChat.

- `/as <text>` is the unified natural-language entry. Codex first decides whether the text is a new record or a management action on an existing record, then classifies new records as log, todo, reminder, or note.
- `/log <text>` forces a log record.
- `/todo <text>` forces a todo record. Use `/todo done 1` to complete it.
- `/remind <text>` forces a reminder. Phrases such as `明天上午10点` and `每周一早上9点` are parsed locally.
- `/note <text>` forces a note record.
- Logs and notes are saved directly. `/as` todo/reminder drafts ask for confirmation with `/as ok`.
- `/as edit <change instruction>` refines the pending draft by merging the new instruction back into the original matched record.
- `/as <natural update>` can also update existing records. The bridge asks Codex to route the message as create, update, complete, cancel, or archive. It only targets an existing record when the message clearly refers to the same concrete item; otherwise it creates a new record. Existing-record changes ask Codex to merge the original record with the new instruction and require `/as ok` before writing.
- `/as search <keyword>` searches records in the current WeChat chat.
- `/as show 1` shows full content and attachment paths.
- `/as del 1` archives a record.

Examples:

```text
/as 今天修复了 /pg search 日记召回太宽的问题 #CodexBridge
/as 明天上午10点提醒我给王总回电话
/as ok
/as edit 把王总改成李总，时间改成明天上午11点
/as cancel
/as 给王总回电话这件事已经完成了
/as ok
/as 修马桶发票已经拿回来了
/as edit 备注：还差医药发票不确定
/as ok
/log 今天测试微信桥接，发现插件搜索需要更高相关度
/todo 下周五前整理 CodexBridge 视频脚本 p1
/todo done 1
/remind 每周一早上9点提醒我看项目进度
/note Notion 适合结构化日志，Google Drive 适合导出归档
```

Attachment workflow:

```text
/up
发送一个或多个文件、图片、语音、视频
/as 把这些资料记录为合同附件 #合同
```

When `/up` is active, finishing with `/as`, `/log`, `/todo`, `/remind`, or `/note` archives the staged files into the assistant attachment directory instead of sending the batch to Codex as a normal thread prompt.

Data layout:

```text
~/.codexbridge/runtime/assistant_records.json
~/.codexbridge/assistant/attachments/YYYY/MM/DD/<recordId>/
```

Boundary with `/auto`:

- `/remind` only notifies you at a time.
- `/todo` tracks work you will do.
- `/auto` runs scheduled system work and sends the result back to WeChat.

### `/plan` and `/pl`

Inspect or toggle the current bridge session plan mode.

- `/plan` shows the current mode
- `/plan on` enables native `plan` mode for later turns in the current session
- `/plan off` restores native `default` mode

Examples:

```text
/plan
/pl
/plan on
/plan off
```

Notes:

- this is a session-level collaboration mode toggle, not an approval flow
- when enabled, later normal messages start in native `plan` mode
- when disabled, later normal messages return to native `default` mode

### `/skills` and `/sk`

List the skills currently visible to Codex for the active session cwd, search for related skills, inspect what a skill is for, and enable or disable it.

- `/skills` shows the current visible skills
- `/skills search <keyword>` performs a broad relevance match over the visible skills
- `/skills show <index|name>` explains a skill's purpose, path, scope, default prompt, and dependencies
- `/skills on <index|name>` enables the selected skill
- `/skills off <index|name>` disables the selected skill
- `/skills reload` forces a fresh re-scan for the current cwd

Examples:

```text
/skills
/sk
/skills search 新闻
/skills show 1
/skills on 2
/skills off 2
/skills reload
```

### `/plugins` and `/pg`

Browse and manage native Codex plugin packages. Search uses a local hybrid matcher: exact/fuzzy text matching over plugin metadata plus bilingual synonym expansion for common needs such as todo, diary, mail, calendar, repository, MCP, and skills. It only shows high-relevance matches, so broad words like logs or notes do not flood unrelated plugin results.

- `/plugins` or `/pg` shows featured plugins
- `/pg search <keyword>` searches plugin names, descriptions, capabilities, bundled Apps, MCP servers, and Skills
- `/pg search <keyword> <page>` opens another search result page
- `/pg list` groups plugins by capability type
- `/pg show <index|name>` explains what the selected plugin provides
- `/pg add <index|name>` installs a plugin package
- `/pg del <index|name>` uninstalls a plugin package
- `/pg alias <index|name> <alias>` sets a short alias for later `/use` or `@alias` calls

Examples:

```text
/plugins
/pg
/pg search 日记
/pg search todo
/pg search gogle drve
/pg search 邮箱 2
/pg list
/pg list 1
/pg show 1
/pg add 1
/pg alias 1 gd
```

### `/automation` and `/auto`

Create and manage scheduled background jobs. Results are always delivered back to the same WeChat chat.

- `/auto add ...` uses natural language first:
  - Codex turns the request into one or more schedule drafts
  - `/auto confirm` persists the job or jobs
- default mode is `standalone`
- `thread` mode reuses the current bound session and requires an existing scope session
- `daily` and `cron` schedules are interpreted in `UTC`

Examples:

```text
/auto
/auto add 每30分钟检查一次系统状态，有变化发送给我
/auto add 每天早上7点调用 news skill 给我发送到微信
/auto add 工作日晚上6点检查部署状态，异常时通知我
/auto add 每天早上8点、中午13点、下午17点半，把待办事项整理后发到微信
/auto confirm
/auto edit 只把时间改成每小时，任务内容不变
/auto cancel
/auto list
/auto show 1
/auto pause 1
/auto resume 1
/auto rename 1 晚间部署巡检
/auto delete 1
/auto del 1
```

### `/new` and `/n`

Create a new bridge session on the current provider profile.
You can optionally pass a working directory.

Examples:

```text
/new
/new /home/ubuntu/dev/CodexBridge
/n
```

### `/provider` and `/pd`

List provider profiles or switch the current scope to another provider profile.

Examples:

```text
/provider
/pd
/provider openai-default
/pd openai-default
```

### `/models` and `/ms`

List available models for the current provider profile.

Examples:

```text
/models
/ms
```

### `/model` and `/m`

View the current model setting or switch it for the current scope.

Examples:

```text
/model
/m
/model default
/model high
/model gpt-5.4 xhigh
/model gpt-5.4
```

### `/personality [friendly|pragmatic|none]` and `/psn [friendly|pragmatic|none]`

Show or update the personality used for future turns in the current scope.

Examples:

```text
/personality
/psn
/personality pragmatic
/psn none
```

### `/instructions` and `/ins`

View or edit the global Codex custom instructions file backed by `AGENTS.md`.

- `/instructions` shows the current file path and content status
- `/instructions set <text>` replaces `AGENTS.md` inline
- `/instructions edit` arms the next non-command message as the new file content
- `/instructions clear` removes the current custom instructions
- `/instructions cancel` exits pending edit mode

Examples:

```text
/instructions
/ins
/instructions set Always explain the tradeoffs before editing.
/instructions edit
/instructions clear
/instructions cancel
```

### `/fast`

Enable or disable Fast mode for future turns in the current scope.
`/fast` turns on `serviceTier=fast`. `/fast off` forces `serviceTier=flex`.

Examples:

```text
/fast
/fast off
```

### `/threads` and `/th`

Show the first page of threads for the current provider profile.
Each page is rendered as WeChat-friendly text with:

- page number
- current binding marker
- title or alias
- one-line preview
- relative update time
- suggested follow-up commands

Examples:

```text
/threads
/threads -h
/th
```

### `/search <term>` and `/se <term>`

Search thread titles and previews, then show the first page of results.

Examples:

```text
/search bridge
/se bridge
/search 微信
/se 微信
```

### `/next`, `/prev`, `/nx`, and `/pv`

Move through the current thread browser page set.
You must run `/threads` or `/search` first so the current page context exists.

Examples:

```text
/threads
/next
/nx
/prev
/pv
```

### `/open <index|threadId>` and `/o <index|threadId>`

Bind the current WeChat scope to an existing Codex thread.
On WeChat, numeric indexes are the preferred way to open a thread.

Examples:

```text
/open 2
/o 2
/open 019d95ad-7166-7ee3-89a3-3bbb50e0fd64
```

### `/peek <index|threadId>` and `/pk <index|threadId>`

Preview the most recent turns from a thread before opening it.

Examples:

```text
/peek 1
/pk 1
/peek 019d95ad-7166-7ee3-89a3-3bbb50e0fd64
```

### `/rename <index|threadId> <alias>` and `/rn <index|threadId> <alias>`

Set a local bridge alias for a thread.
This does not change the provider-side thread id.

Examples:

```text
/rename 2 微信桥接排障
/rn 2 微信桥接排障
/rename 019d95ad-7166-7ee3-89a3-3bbb50e0fd64 CodexBridge
```

### `/permissions [preset]` and `/perm [preset]`

Show or update the access preset for the next turn.

Supported presets:

- `read-only`
- `default`
- `full-access`

Examples:

```text
/permissions
/perm
/permissions full-access
/perm full-access
```

### `/allow [1|2] [index]` and `/al [1|2] [index]`

Handle the approval request that is currently pending during an active turn.
This mirrors the Codex CLI/App-style `1 / 2 / 3` approval flow on WeChat.

- `/allow` shows the current pending approval list
- `/allow 1` approves the first pending request once
- `/allow 2` approves and remembers it for the current session when supported
- if multiple requests are pending, use `/allow 2 2` to answer request `#2`

Examples:

```text
/allow
/al
/allow 1
/allow 2
/allow 2 2
```

Notes:

- use `/permissions` to change the default preset for the next turn
- use `/allow` only for the approval request that is pending right now
- `/allow 2` is session-scoped remembered approval, not a replacement for `/permissions full-access`

### `/deny [index]` and `/dn [index]`

Deny the approval request that is currently pending during an active turn.
This is the clearer replacement for the old `/allow 3` wording.

- `/deny` denies the first pending request
- `/deny 2` denies request `#2` when multiple approvals are pending
- old `/allow 3` remains supported for compatibility, but it is no longer the recommended form

Examples:

```text
/deny
/dn
/deny 2
```

### `/reconnect` and `/rc`

Refresh the current Codex provider session.

Example:

```text
/reconnect
/rc
```

### `/retry` and `/rt`

Retry the previous non-command user request in the same thread.
The bridge refreshes the current Codex session first, then starts a new turn with the previous request snapshot.

- use this after a turn becomes `interrupted`
- this does not resume the old turn in place; it reruns the previous request as a new turn
- if the previous request depended on local attachments that no longer exist, the bridge will refuse the retry and show the missing path

Examples:

```text
/retry
/rt
```

### `/restart` and `/rs`

Queue a restart of the bridge service when the current host supports it.

Example:

```text
/restart
/rs
```

### `/lang`

View or switch the current scope's language.

Examples:

```text
/lang
/lang zh-CN
/lang en
/lang zh
```

## Help Conventions

Each command supports the same help entrypoints.

Examples:

```text
/threads -h
/open --help
/rename -helps
/th -h
/perm --help
```

These forms are equivalent to:

```text
/helps threads
/helps open
/helps rename
```

## Recommended WeChat Workflow

For day-to-day use on WeChat:

1. Run `/threads`
2. Use `/peek 1` or `/peek 2` to inspect candidates
3. Use `/open 1` or `/open 2` to bind the thread
4. Use `/rename 1 <alias>` if you want a stable, readable name
5. Use `/stop` if the current reply needs to be interrupted
6. Use `/permissions` when you need to inspect or change the next-turn access preset
7. Use `/personality` to keep the session tone aligned with how you want Codex to respond
8. Use `/instructions` when you want to update your global custom instructions without leaving WeChat
9. Use `/allow` to approve and `/deny` to reject when Codex asks for approval during the current turn
10. Use `/retry` after an interrupted turn; use `/reconnect` only when you want to refresh the session without rerunning the previous request

This workflow avoids copying raw thread ids and works well in a chat UI without buttons.
