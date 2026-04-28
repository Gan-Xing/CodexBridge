# CodexBridge

CodexBridge is a Codex-centered gateway for connecting multiple chat platforms to one shared Codex engine, while switching backend provider profiles inside Codex when needed.

## Current Direction

- First delivery target: `WeChat + Codex`
- Future platforms: `Telegram`, additional chat transports
- Future Codex provider profiles: `MiniMax via CLIProxyAPI`, additional Codex-compatible backends
- Core rule: platforms are adapters, Codex stays the execution engine, and Codex thread state stays the source of truth

## Documents

- [Core architecture](./docs/architecture/codexbridge-core-architecture.md)
- [Roadmap TODO](./docs/todo/roadmap.md)
- [WeChat slash command reference](./docs/usage/weixin-slash-commands.md)

## Repository Layout

```text
src/
  core/
  platforms/
  providers/
  runtime/
  store/
test/
docs/
```

## Status

Project bootstrap is now focused on:

1. Landing the core session and binding model
2. Keeping platform and provider plugins independent
3. Making `WeChat + Codex` the first real implementation path

Current implemented bridge pieces:

- Core session routing with WeChat-friendly slash commands, including `/helps`, `/status`, `/usage`, `/login`, `/stop`, `/review`, `/agent`, `/plan`, `/skills`, `/plugins`, `/automation`, `/weibo`, `/new`, `/uploads`, `/as`, `/log`, `/todo`, `/remind`, `/note`, `/provider`, `/models`, `/model`, `/personality`, `/instructions`, `/fast`, `/threads`, `/search`, `/next`, `/prev`, `/open`, `/peek`, `/rename`, `/permissions`, `/allow`, `/deny`, `/reconnect`, `/retry`, `/restart`, and `/lang`
- File-backed JSON repositories for persistent bridge state
- WeChat platform skeleton for Hermes-compatible iLink config loading, QR account state reuse, inbound DM normalization, long-poll client/poller wiring, context-token persistence, text chunking, and outbound text/typing delivery
- Codex profile loader and initial Codex app-server client/plugin path for shared thread execution
- WeChat runtime wiring that feeds poll events into the shared bridge coordinator and sends responses back through the WeChat transport

## WeChat Slash Commands

The WeChat bridge now uses a text-first command surface designed for chat, not buttons.
Recommended entrypoints:

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
/agent 帮我检查当前项目测试并修复失败项
/agent confirm
/agent show 1
/agent result 1
/agent result 1 file
/agent send 1
/agent retry 1
/plan
/pl
/plan on
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
/as edit 把王总改成李总，时间改成明天上午11点
/log 今天测试微信桥接，发现插件搜索需要更高相关度
/todo 检查服务器磁盘空间
/todo done 1
/remind 每周一早上9点提醒我看项目进度
/note Notion 适合结构化日志，Google Drive 适合导出归档
/helps threads
/stop
/sp
/provider
/pd
/models
/ms
/model
/m
/personality
/psn pragmatic
/instructions
/instructions edit
/fast
/fast off
/model gpt-5.4 xhigh
/model high
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
/model default
/models
/lang
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

### `/models` and `/ms`

List available models for the current provider profile.

Examples:

```text
/models
/ms
```

### `/automation` and `/auto`

Create and manage scheduled background jobs. Results are always delivered back to the same WeChat chat.

Examples:

```text
/auto
/auto add 每30分钟检查一次系统状态，有变化发送给我
/auto add 每天早上7点调用 news skill 给我发送到微信
/auto add 工作日晚上6点检查部署状态，异常时通知我
/auto add 每天早上8点、中午13点、下午17点半，把待办事项整理后发到微信
/auto confirm
/auto edit 每小时检查一次部署状态，有变化发送给我
/auto cancel
/weibo
/weibo top 10
/auto add 每5分钟把微博热搜前10条发给我
/auto list
/auto show 1
/auto pause 1
/auto resume 1
/auto rename 1 晚间部署巡检
/auto delete 1
/auto del 1
```

### `/as`, `/log`, `/todo`, `/remind`, and `/note`

Personal assistant records for WeChat. `/as` is the natural-language entry for logs, todos, reminders, and notes. It asks Codex to decide whether the message is a new record or a management action on an existing record; local keyword rules are only a conservative fallback when the provider is unavailable. `/log`, `/todo`, `/remind`, and `/note` remain shortcuts when you want to force a category.

Examples:

```text
/as 今天修复了 /pg search 日记召回太宽的问题 #CodexBridge
/as 明天上午10点提醒我给王总回电话
/as ok
/as 给王总回电话这件事已经完成了
/as ok
/as 修马桶发票已经拿回来了
/as edit 备注：还差医药发票不确定
/as ok
/log 今天测试微信桥接，发现插件搜索需要更高相关度
/todo 检查服务器磁盘空间
/todo done 1
/remind 每周一早上9点提醒我看项目进度
/note Notion 适合结构化日志，Google Drive 适合导出归档
```

`/as` also manages existing records with natural language. Codex first routes the message as create, update, complete, cancel, or archive. It only targets an existing record when the message clearly refers to the same concrete item; otherwise it creates a new log/todo/reminder/note. Existing-record changes are shown as a pending draft and are only written after `/as ok`. Use `/as edit <change instruction>` to refine that pending update draft, or `/as cancel` to discard it.

For natural-language updates, the bridge prefers a short-lived Codex app-server rewrite thread, so the host Codex subscription handles the “original record + modification instruction” merge. API-key based Agents SDK normalization is only a fallback when Codex normalization is unavailable; local rules are the final fallback.

`/up` can stage files first. If the final message is `/as`, `/log`, `/todo`, `/remind`, or `/note`, the staged files are archived onto the assistant record under `~/.codexbridge/assistant/attachments/YYYY/MM/DD/<recordId>/`; structured records are stored in `~/.codexbridge/runtime/assistant_records.json`.

Boundary: `/remind` only notifies, `/todo` tracks user-owned work, and `/auto` runs scheduled system work.

### `/plan` and `/pl`

Inspect or switch the session-level collaboration mode for future turns.

Examples:

```text
/plan
/pl
/plan on
/plan off
```

`/plan on` enables native `plan` mode for later turns in the current bridge session. `/plan off` restores the native `default` collaboration mode. This is a mode toggle, not an approval flow.

### `/agent` and `/ag`

Create a confirmed background Agent job for deeper multi-step work.

Examples:

```text
/agent 帮我研究并实现一个小功能，然后测试
/agent confirm
/agent edit 改成只做方案，不修改代码
/agent list
/agent show 1
/agent result 1
/agent result 1 file
/agent send 1
/agent stop 1
/agent retry 1
/agent del 1
```

The experimental workflow is hybrid but Codex-first: Codex app-server is preferred for planning, execution, and verification so an existing Codex subscription is used by default. OpenAI Agents SDK is only a fallback when an Agent API key is configured and the Codex normalization/verifier path is unavailable. Long text results can be paged with `/agent result <index>` or exported as a phone-friendly TXT attachment with `/agent result <index> file`. Jobs with generated attachments keep artifact records, so `/agent send <index>` can resend the file if WeChat rate-limits the first delivery. If both Codex normalization and Agents SDK are unavailable, local fallback still creates a usable draft and verifier path.

Agent planner/verifier configuration:

```bash
# OpenAI default
OPENAI_API_KEY=...
CODEXBRIDGE_AGENT_MODEL=gpt-5.5

# OpenAI-compatible provider, for example MiniMax
CODEXBRIDGE_AGENT_API_KEY=...
CODEXBRIDGE_AGENT_BASE_URL=https://api.minimax.io/v1
CODEXBRIDGE_AGENT_MODEL=MiniMax-M2.7
CODEXBRIDGE_AGENT_API=chat_completions
```

`CODEXBRIDGE_AGENT_API_KEY` takes precedence over `OPENAI_API_KEY` for the fallback Agents SDK path. The default path still uses Codex app-server first. When `CODEXBRIDGE_AGENT_BASE_URL` or `OPENAI_BASE_URL` is set, the bridge defaults Agents SDK calls to Chat Completions compatibility mode unless `CODEXBRIDGE_AGENT_API=responses` is explicitly set.

### `/model` and `/m`

Check or switch the model used for future turns.

Examples:

```text
/model
/m
/model default
/model high
/model gpt-5.4 xhigh
/model gpt-5.4
```

All slash commands support command-scoped help flags:

```text
/threads -h
/open --help
/permissions -helps
```

Best-practice rule:

- use `/helps` for command discovery
- use `/login` and `/login list` to manage the host Codex account pool before switching accounts with `/login <index>`
- use `/review`, `/review base <branch>`, or `/review commit <sha>` when you want a native Codex code review without changing the current thread binding
- use `/agent <task>` when the task needs planning, background execution, verifier checks, and one automatic retry before delivery
- use `/plan on` when you want later turns in the current session to prioritize planning first, and `/plan off` when you want to restore the default collaboration mode
- use `/skills` to inspect what Codex can currently see in the active project, `/skills search <keyword>` for related matches, and `/skills show <index>` to understand what a skill is for before enabling or disabling it
- use `/auto add ...` in natural language first; the bridge will draft a schedule, then `/auto confirm` creates the job
- use `/threads` and numeric indexes on WeChat instead of copying raw thread ids
- use `/personality` to control the response style for future turns in the current scope
- use `/instructions` to manage the active Codex `AGENTS.md` custom instructions file
- use `/lang zh-CN` or `/lang en` to switch reply language for the current scope
- use `/allow 1` or `/allow 2` to approve, and `/deny` to reject, when Codex asks for approval mid-turn
- use `/retry` after an interrupted turn; it refreshes the current Codex session first, then reruns the previous request in the same thread
- use `/helps <command>` when you need exact usage and examples

See the full command reference in [docs/usage/weixin-slash-commands.md](./docs/usage/weixin-slash-commands.md).

## Validation

```bash
npm install
npm run typecheck
npm test
```

The validation suite is expected to pass on both Linux and Windows.

## Deployment Quick Start

### Common Prerequisites

- Node.js `>= 24`
- `npm`
- A working Codex CLI login on the host

Recommended first check after cloning:

```bash
npm install
npm run typecheck
npm test
codex --version
```

If the Codex CLI is not installed yet, install it first:

```bash
npm install -g @openai/codex@latest --include=optional
codex --version
```

If `codex --version` still fails, fix that before attempting `weixin:login` or `weixin:serve`.

### Linux

```bash
npm install
npm run typecheck
npm test
codex --version
npm run weixin:login
npm run weixin:serve -- --cwd /absolute/path/to/workspace
```

For long-running deployment, prefer the service-manager flow described below instead of leaving a terminal window open.

### Windows (First-Time Bring-Up)

Open PowerShell in the repo root and run:

```powershell
npm install
npm run typecheck
npm test
codex --version
where codex
npm run weixin:login
npm run weixin:serve -- --cwd C:\absolute\path\to\workspace
```

If the host has multiple Codex shims on `PATH`, set the real native binary explicitly before starting the bridge:

```powershell
$env:CODEX_REAL_BIN = (Get-Command codex.exe).Source
npm run weixin:serve -- --cwd C:\absolute\path\to\workspace
```

Useful optional debug flag:

```powershell
$env:CODEXBRIDGE_DEBUG_WEIXIN = '1'
```

### What Was Hardened After the First Windows Deployment

The first Windows bring-up exposed four platform-specific issues:

1. Command discovery:
   the provider config originally assumed a Unix-style command lookup. The loader now resolves Windows executables directly and prefers a native `codex.exe` / `.com` binary over wrapper scripts when both exist.
2. Windows launch wrappers:
   if the host only exposes `codex.cmd` or `codex.bat`, the bridge now launches that wrapper through a Windows shell command line instead of failing during `spawn(...)`.
3. Startup diagnostics:
   if Codex cannot be launched, the bridge now fails with a direct `CODEX_REAL_BIN` / `codex.exe` / `codex.cmd` hint instead of leaving only a raw `spawn codex ENOENT`.
4. Thread materialization:
   transient `empty session file` reads from Codex session storage are now retried automatically instead of being treated as fatal turn failures.

### Runtime Defaults

- State directory: `~/.codexbridge`
- WeChat account files: `~/.codexbridge/weixin/accounts/`
- Serve lock file: `~/.codexbridge/runtime/weixin-serve.lock`
- Default Codex auth path: `~/.codex/auth.json`
- Default Codex instructions path: `~/.codex/AGENTS.md`

### WeChat Runtime Checklist

Binding the WeChat account is only the login step. Replies require the serve loop to stay alive.

Standard order:

1. `npm run weixin:login`
2. confirm the account file exists under `~/.codexbridge/weixin/accounts/`
3. start `npm run weixin:serve`
4. send `/h` or `/status` from WeChat as a smoke test
5. keep the process running, or install the platform service manager below

### Troubleshooting

- No reply after WeChat binding:
  confirm `weixin:serve` is still running. The QR login does not start a background worker by itself.
- `spawn codex ENOENT` or the bridge cannot start Codex:
  run `codex --version`. On Windows, set `CODEX_REAL_BIN` to the full path of `codex.exe` or `codex.cmd` if needed.
- Turn starts but no final reply is delivered:
  inspect debug logs with `CODEXBRIDGE_DEBUG_WEIXIN=1`. Transient `empty session file` reads are retried automatically in current builds.
- Need to inspect runtime state:
  account state is stored under `~/.codexbridge/weixin/accounts/`, and the current serve lock is stored under `~/.codexbridge/runtime/weixin-serve.lock`.

## Media Tooling

Image normalization and video thumbnail generation now use project-managed `ffmpeg` / `ffprobe` binaries via `ffmpeg-static` and `ffprobe-static`.

Resolution order:

- `CODEXBRIDGE_FFMPEG_PATH` / `CODEXBRIDGE_FFPROBE_PATH`
- `FFMPEG_PATH` / `FFPROBE_PATH`
- bundled binaries from project dependencies
- system `PATH` fallback

This keeps image/video media handling portable across Linux, macOS, and Windows without requiring a manual global `ffmpeg` install in the common case.

## WeChat Login

```bash
npm run weixin:login
```

Run the WeChat bridge loop:

```bash
npm run weixin:serve
```

By default the bridge uses the directory where `weixin:serve` is launched as the shared working directory for new sessions. You can override it with `--cwd` or `CODEXBRIDGE_DEFAULT_CWD`, and you can still rebind a specific chat with `/new /absolute/path/to/project`.

## i18n

The bridge now uses one unified i18n layer for user-visible runtime text.

- Supported locales:
  - `zh-CN`
  - `en`
- Default locale: `zh-CN`
- Process-wide override:
  - `CODEXBRIDGE_LOCALE=zh-CN`
  - `CODEXBRIDGE_LOCALE=en`

Example:

```bash
CODEXBRIDGE_LOCALE=en npm run weixin:serve
```

The locale currently affects:

- slash-command replies
- WeChat runtime failure messages
- CLI login / serve prompts
- bridge restart completion notifications

## Background Service

The bridge loop is `weixin:serve`. For unattended use, register it with the host service manager so it starts on login/boot and restarts after crashes.

Important limits:

- A service manager keeps CodeXBridge alive while the computer is powered on and the OS is running.
- It cannot receive messages while the host is powered off, asleep, or disconnected from the network.
- On desktop operating systems, user-level services depend on the user's login/session model. Linux `linger` and macOS `launchd` can run without an open terminal; Windows Task Scheduler below runs after user logon.

### Linux systemd User Service

Install and start the user service on Linux:

```bash
bash ./scripts/service/install-systemd-user.sh
```

Useful follow-up commands:

```bash
bash ./scripts/service/status-systemd-user.sh
bash ./scripts/service/restart-systemd-user.sh
bash ./scripts/service/logs-systemd-user.sh
bash ./scripts/service/logs-systemd-user.sh --follow
```

The installer uses `Restart=always` and attempts to enable `loginctl linger` so the user service can continue after logout. If linger cannot be enabled automatically, run:

```bash
loginctl enable-linger "$USER"
```

The installer writes a per-user environment file to:

```text
~/.config/codexbridge/weixin.service.env
```

That file is the stable place to adjust:

- `WEIXIN_ACCOUNT_ID`
- `CODEX_DEFAULT_PROVIDER_PROFILE_ID`
- optional proxy profile keys such as `CODEX_PROVIDER_*`
- `CODEXBRIDGE_DEBUG_WEIXIN`

### Windows Scheduled Task

Install and start a hidden per-user scheduled task:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\service\install-windows-task.ps1
```

Useful follow-up commands:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\service\status-windows-task.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\service\restart-windows-task.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\service\logs-windows-task.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\service\logs-windows-task.ps1 -Follow
```

The installer writes the environment file to:

```text
%APPDATA%\codexbridge\weixin.service.env
```

Logs are written under:

```text
%USERPROFILE%\.codexbridge\logs\
```

If you need the task to start at machine startup instead of user logon, pass `-AtStartup`. That mode may require elevated privileges and a user environment that can still access the Codex auth files.

### macOS launchd User Service

Install and start the launch agent:

```bash
bash ./scripts/service/install-launchd-user.sh
```

Useful follow-up commands:

```bash
bash ./scripts/service/status-launchd-user.sh
bash ./scripts/service/restart-launchd-user.sh
bash ./scripts/service/logs-launchd-user.sh
bash ./scripts/service/logs-launchd-user.sh --follow
```

The installer writes:

```text
~/Library/LaunchAgents/com.ganxing.codexbridge-weixin.plist
~/.config/codexbridge/weixin.service.env
~/.codexbridge/logs/
```

### Service Runner

Windows and macOS use `scripts/service/run-weixin-service.mjs` as a small supervisor. It loads the service env file, starts:

```bash
node --import tsx src/cli.ts weixin serve
```

and restarts it after unexpected exit. Linux relies on systemd's native `Restart=always`.

Useful environment/config values:

- `--base-url`
- `--cwd`
- `--state-dir`
- `--bot-type`
- `--timeout-sec`

The login command fetches a QR code, saves the QR image under `~/.codexbridge/weixin/login/`, prints the file path, and waits until the scan is confirmed. Credentials are then stored under `~/.codexbridge/weixin/accounts/`. Runtime scripts now execute `tsx src/cli.ts` and `tsx src/index.ts` directly.
