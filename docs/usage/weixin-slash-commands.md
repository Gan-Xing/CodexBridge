# Weixin Slash Commands

This document describes the current text-first slash command surface for the WeChat bridge.

## Design Rule

The WeChat bridge is not a strict shell CLI.
It borrows the most useful CLI help conventions while staying chat-friendly:

- `/helps` shows the full command catalog
- `/helps <command>` shows one command in detail
- every slash command supports `-h`, `--help`, `-help`, and `-helps`
- thread browsing is index-first on WeChat, so `/open 2` is preferred over copying raw thread ids

## Fast Start

```text
/helps
/stop
/threads
/open 2
/peek 2
/rename 2 微信桥接排障
/permissions
```

## Command Catalog

### `/helps` and `/help`

Show all slash commands, or show help for one command.

Examples:

```text
/helps
/helps threads
/help open
```

### `/status` and `/where`

Show the current scope binding, provider profile, Codex thread, access settings, and active-turn state.

Examples:

```text
/status
/where
```

### `/stop` and `/interrupt`

Request an interrupt for the active Codex turn.
`/stop` is the primary command.
`/interrupt` is kept as a compatibility alias.

Examples:

```text
/stop
/interrupt
```

### `/new`

Create a new bridge session on the current provider profile.
You can optionally pass a working directory.

Examples:

```text
/new
/new /home/ubuntu/dev/CodexBridge
```

### `/provider`

List provider profiles or switch the current scope to another provider profile.

Examples:

```text
/provider
/provider openai-default
```

### `/threads`

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
```

### `/search <term>`

Search thread titles and previews, then show the first page of results.

Examples:

```text
/search bridge
/search 微信
```

### `/next` and `/prev`

Move through the current thread browser page set.
You must run `/threads` or `/search` first so the current page context exists.

Examples:

```text
/threads
/next
/prev
```

### `/open <index|threadId>`

Bind the current WeChat scope to an existing Codex thread.
On WeChat, numeric indexes are the preferred way to open a thread.

Examples:

```text
/open 2
/open 019d95ad-7166-7ee3-89a3-3bbb50e0fd64
```

### `/peek <index|threadId>`

Preview the most recent turns from a thread before opening it.

Examples:

```text
/peek 1
/peek 019d95ad-7166-7ee3-89a3-3bbb50e0fd64
```

### `/rename <index|threadId> <alias>`

Set a local bridge alias for a thread.
This does not change the provider-side thread id.

Examples:

```text
/rename 2 微信桥接排障
/rename 019d95ad-7166-7ee3-89a3-3bbb50e0fd64 CodexBridge
```

### `/permissions [preset]`

Show or update the access preset for the next turn.

Supported presets:

- `read-only`
- `default`
- `full-access`

Examples:

```text
/permissions
/permissions full-access
```

### `/reconnect`

Refresh the current Codex provider session.

Example:

```text
/reconnect
```

### `/restart`

Queue a restart of the bridge service when the current host supports it.

Example:

```text
/restart
```

## Help Conventions

Each command supports the same help entrypoints.

Examples:

```text
/threads -h
/open --help
/rename -helps
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

This workflow avoids copying raw thread ids and works well in a chat UI without buttons.
