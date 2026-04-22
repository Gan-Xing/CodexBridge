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
- every slash command also supports a short alias such as `/h`, `/st`, `/us`, `/lg`, `/sp`, `/n`, `/up`, `/pd`, `/ms`, `/m`, `/psn`, `/ins`, `/th`, `/se`, `/nx`, `/pv`, `/o`, `/pk`, `/rn`, `/perm`, `/al`, `/dn`, `/rc`, `/rt`, and `/rs`
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
