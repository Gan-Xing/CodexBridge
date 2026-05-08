# Mission Control Loop Prompt

This document tracks the canonical prompt used by the external
`loop.sh`-based Mission Control work loop.

Current mirror target:

- `.codexbridge/mission/mission-control.prompt.md`

The tracked document is the reviewable source of truth.
The git-ignored mirror exists so local loop tooling can execute the same prompt
without forcing `.codexbridge/` runtime assets into version control.

This document currently preserves the last pre-`Phase 10` loop prompt as
reviewable history while `Phase 10` service exposure becomes the next active
execution scope.

Current status:

- phases `0-9v` now remain validated
- `Phase 10` service exposure is now the next unfinished execution phase
- later providers/sources remain deferred
- `/auto` is out of scope
- `CodexBridge` integration cleanup around `/agent` remains a validated part
  of the closed `Phase 9v` baseline, not a hidden side effect

Current re-entry rules:

- use the `Phase 9v` prompt below as archived reference, not as the active
  execution scope
- the next live loop prompt should be rewritten for `Phase 10` service
  exposure instead of reopening closed `Phase 9v` work
- later providers/sources still require an explicit scope reopen

## Archived `Phase 9v` Prompt

```md
# Mission Control Loop Prompt

请继续推进 `@codexbridge/mission-control` 的工作。

不可变目标：
CodexBridge 的目标是通过微信稳定暴露 Codex 原生能力，并在桥接层扩展微信命令和个人助理工作流；`@codexbridge/mission-control` 的目标是做成一个通用的、面向 agent 的长期任务运行时，使一个目标能够持续执行直到完成、明确失败或需要人工介入。当前以 Codex 作为第一真实 provider，以 CodexBridge 作为第一 host / control surface；`openai-agents-js` 是后续 provider 方向，不是当前主线。

优先工作分支：
- `track/mission-control`

当前循环范围：
1. 继续推进 `docs/todo/mission-control.md` 中尚未完成的核心任务。
2. 当前重新打开 `Phase 9v`，在进入 `Phase 10` 之前先收口以下高优先级缺口：
   - `/agent` 显式子命令优先的固定路由 + 自然语言 intake 的受约束大模型路由
   - 仅针对 add/create 意图的专用 create-flow pipeline
   - 代码任务的 repo-aware 固定 prompt 模板
   - 非代码任务的通用模板
   - 过宽目标的澄清/收窄机制
   - 每轮循环后的 authoritative checklist/TODO 状态更新
   - AI 对 checklist 细化/修改建议的自主判断
   - workpad 内部子步骤与正式 checklist 变更的边界
3. `Phase 10` service exposure 只有在这些 `Phase 9v` 项完成后才进入。
4. 暂不扩展：
   - 真实 GitHub / Linear source 接入
   - `OpenAIAgentsMissionProvider`
   - 可选 Web host / dashboard
   - 纯服务暴露包装之外的 later providers / sources
5. 当前 loop 不只是补 package core，也要继续收敛 `CodexBridge` 作为第一 host 的集成边界。
6. 代码/通用 draft 模板、bounded routing 规则、状态驱动循环要求，以
   `docs/architecture/agent-draft-templates.md` 为审查基线。
7. 若需实现或收紧 `/agent` draft 路由/模板，请同时参考：
   - `skills/agent-draft-router/SKILL.md`

先阅读并遵守：
- `docs/architecture/agent-draft-templates.md`
- `skills/agent-draft-router/SKILL.md`
- `docs/architecture/codexbridge-core-architecture.md`
- `docs/architecture/mission-control.md`
- `docs/architecture/mission-control-codexbridge-integration.md`
- `docs/architecture/mission-control-loop-prompt.md`
- `docs/todo/roadmap.md`
- `docs/todo/mission-control.md`

开始前必须做：
1. 检查 `git status`，保护已有未提交改动，不要覆盖用户改动。
2. 对比代码、测试、文档和 checklist，判断当前 Mission Control phase 是否准确。
3. 先以 `mission-control.md` 和 `mission-control-codexbridge-integration.md` 锁定目标边界，再决定下一步改动。
4. 如果文档和代码不一致，以代码、测试和 git 状态为准，先修正文档或提出最小修正方案。
5. 如果为了达成不可变目标必须新增需求项，优先补充到 `docs/todo/mission-control.md`；只有真正跨工作流的事项才改 `docs/todo/roadmap.md`。
6. 默认推进到“可验证的最小完整阶段”，不要只停留在分析。
7. 不要重复做已完成阶段；根据当前代码、测试和 checklist 自动选择下一个未完成阶段。

当前集成重点：
1. `/agent` 仍然是 Mission v0 host surface；不要引入新的 `/mission` 命令来绕过集成收口。
2. `/agent` 显式子命令必须保持程序优先的固定路由；裸自然语言与 `/agent add` 可以使用大模型/skill，但只能在受约束的 action schema 下做意图判断。
3. 只有当路由结果明确落到 add/create 时，后续才允许进入任务类型判断、scope 澄清、checklist 草案、immutable prompt 草案、loop policy 草案的 create-flow。
4. 代码任务草案必须优先产出 repo-aware checklist 和固定 prompt scaffold，不能退回通用“分析/设计/开发/测试/部署”模板。
5. 非代码任务可以使用较轻的通用模板，但仍必须给出正式 checklist、immutable prompt、loop policy。
6. 每轮循环都必须显式判断并更新：
   - 当前 checklist item 状态
   - overall completion
   - next step
   - latest blocker
   - latest progress summary
7. 如果 AI 判断 checklist 本身需要细化或调整，必须：
   - 先区分内部 substeps 和正式 checklist 变更
   - 对正式 checklist 变更产出显式建议 / `PlanChangeRequest`
   - 不得静默改写用户已确认的正式 checklist

当前工作策略：
1. 优先修改：
   - `packages/mission-control/**`
   - `src/core/bridge_coordinator.ts`
   - `src/core/agent_job_service.ts`
   - `src/core/mission_control_agent_job_adapter.ts`
   - `docs/command-skills/agent.md`
   - `docs/architecture/agent-draft-templates.md`
   - `skills/agent-draft-router/SKILL.md`
   - `docs/architecture/mission-control.md`
   - `docs/architecture/mission-control-codexbridge-integration.md`
   - `docs/architecture/mission-control-loop-prompt.md`
   - `docs/todo/mission-control.md`
2. 除非改动确实跨切面，否则尽量少动：
   - `docs/todo/roadmap.md`
   - `README.md`
   - root `package.json`
3. 当前优先级始终是：
   - bounded model-assisted `/agent` natural-language routing
   - dedicated add/create-flow intake pipeline
   - first-host task-type-aware draft templates
   - code-task repo-aware immutable prompt scaffolding
   - broad-scope clarification before confirmation
   - authoritative checklist/TODO status updates after every cycle
   - autonomous checklist refinement suggestions with explicit change gates
   - workpad substeps vs formal checklist mutation boundary

自动循环约束：
1. 每一轮只做一个“可验证的最小完整阶段”或一个清晰的子阶段。
2. 完成后必须更新 `docs/todo/mission-control.md`。
3. 如果本轮完成了一个可验证的最小完整阶段并且验证通过，必须在当前分支自动提交，但不要 push。
4. 如果本轮本应提交但无法安全提交，必须停止并进入 `NEEDS_HUMAN`，不要带着未提交改动继续下一轮。
5. 如果遇到产品边界不清、需要新增不可逆行为、需要人工决策、或连续失败超预算，停止并进入 `NEEDS_HUMAN`。
6. 只有当 `docs/todo/mission-control.md` 当前循环范围内的 checklist 全部完成，并且上述 `Phase 9v` 任务已完成时，才可进入 `DONE`。

验证要求：
1. 能跑验证就跑验证。
2. 不能跑要明确说明阻塞点。
3. 每完成一个阶段必须给出可验证结果：`typecheck` / `tests` / `build`，或说明为什么暂时不能跑。

最终输出协议：
1. 正常回复后，最后必须单独输出一行：
   - `LOOP_STATUS: CONTINUE`
   - 或 `LOOP_STATUS: DONE`
   - 或 `LOOP_STATUS: NEEDS_HUMAN`
   - 或 `LOOP_STATUS: FAILED`
2. 紧接着再单独输出一行：
   - `LOOP_REASON: <一句话原因>`
3. 紧接着再单独输出这些机器可读字段：
   - `LOOP_PHASE: <当前完成的 phase 或子阶段>`
   - `LOOP_PROGRESS: <当前做到哪一步的简短摘要>`
   - `LOOP_NEXT: <下一步最合理的推进项>`
   - `LOOP_OVERALL_PROGRESS: <0-100% 或 x/y 的整体完成进度估算>`
   - `LOOP_COMMIT: <本轮产生的 commit hash；如果没有则写 none>`
4. 如果 `LOOP_STATUS: CONTINUE`，则 `LOOP_COMMIT` 不能是 `none`。
5. 在 `LOOP_STATUS` 之前，正常说明：
   - 本次完成了哪个 phase 或最小阶段
   - 修改了哪些代码、文档、checklist
   - 是否发现新增需求项或边界调整
   - 跑了哪些验证
   - 下一步最合理的推进项是什么
```

## Historical Pre-`Phase 10` Prompt

```md
# Mission Control Loop Prompt

请继续推进 `@codexbridge/mission-control` 的工作。

不可变目标：
CodexBridge 的目标是通过微信稳定暴露 Codex 原生能力，并在桥接层扩展微信命令和个人助理工作流；`@codexbridge/mission-control` 的目标是做成一个通用的、面向 agent 的长期任务运行时，使一个目标能够持续执行直到完成、明确失败或需要人工介入。当前以 Codex 作为第一真实 provider，以 CodexBridge 作为第一 host / control surface；`openai-agents-js` 是后续 provider 方向，不是当前主线。

优先工作分支：
- `track/mission-control`

当前循环范围：
1. 继续推进 `docs/todo/mission-control.md` 中尚未完成的核心任务。
2. 当前优先完成 `Phase 7`、`Phase 8`、`Phase 9`。
   `Phase 9` 只有在以下首个 host 产品化缺口也完成后才算真正收口：
   - `immutablePrompt` 确认流
   - 初版 checklist 确认流
   - `PlanChangeRequest` / `waiting_user` / `needs_human` 的宿主处理流
   - package-backed loop snapshot / progress UX
   - persisted `MissionEnvironmentStamp`
   - persisted `MissionCheckpoint`
   - 不依赖外部 `loop.sh` 作为主要用户体验的 checklist-backed looping UX
3. 暂不扩展：
   - 真实 GitHub / Linear source 接入
   - `OpenAIAgentsMissionProvider`
   - 可选 Web host / dashboard
   - 纯服务暴露包装之外的 later providers / sources
4. 如果更早 phase 中还有未完成但又阻塞主线的项，可以先补齐。
5. 当前 loop 不只是补 package core，也要继续收敛 `CodexBridge` 作为第一 host 的集成边界。

先阅读并遵守：
- `docs/architecture/codexbridge-core-architecture.md`
- `docs/architecture/mission-control.md`
- `docs/architecture/mission-control-codexbridge-integration.md`
- `docs/architecture/mission-control-loop-prompt.md`
- `docs/todo/roadmap.md`
- `docs/todo/mission-control.md`

开始前必须做：
1. 检查 `git status`，保护已有未提交改动，不要覆盖用户改动。
2. 对比代码、测试、文档和 checklist，判断当前 Mission Control phase 是否准确。
3. 先以 `mission-control.md` 和 `mission-control-codexbridge-integration.md`
   锁定目标边界，再决定下一步改动。
4. 如果文档和代码不一致，以代码、测试和 git 状态为准，先修正文档或提出最小修正方案。
5. 如果为了达成不可变目标必须新增需求项，优先补充到 `docs/todo/mission-control.md`；只有真正跨工作流的事项才改 `docs/todo/roadmap.md`。
6. 默认推进到“可验证的最小完整阶段”，不要只停留在分析。
7. 不要重复做已完成阶段；根据当前代码、测试和 checklist 自动选择下一个未完成阶段。

Mission Control 必须保留的核心方向：
1. Mission Control 必须学习 Symphony 的精髓，而不只是引用它：
   - `WORKFLOW.md` 是主要运行策略来源
   - orchestrator 是生命周期权威
   - verifier 才是完成权威
   - continuation after normal exit 必须成立
   - `waiting_user` / `needs_human` / `handoff` 是第一类状态
   - workspace identity 必须稳定
   - WeChat / Telegram / CLI / Web / API 只是状态与控制面，不是运行时状态所有者
2. prompt 只是单次 attempt 的执行契约，不是运行时本体。
3. “完成”不等于 provider 返回 completed，而等于 acceptance criteria 通过验证。
4. 第一版先以 Codex 为唯一真实 provider；`openai-agents-js` 是后续 provider，不是当前主线。
5. Mission Control 不是 dashboard，不是聊天框架，不是多 agent 平台；它首先是一个 goal-driven durable runtime。
6. Mission Control 是通用 agent runtime；CodexBridge 只是当前第一 host，不是产品边界本身。
7. 当前主线不是“只把 package 做漂亮”，而是让 package 核心与 CodexBridge 集成边界同时收敛到正式 spec。

严格边界：
1. CodexBridge 继续负责微信、Telegram、slash commands、session/thread 绑定、审批、retry/reconnect、SendGate、助理记录、自动化和用户交互。
2. `@codexbridge/mission-control` 只负责：
   - mission domain model
   - mission state machine
   - `WorkItem` / checklist / generation / loop protocol
   - workflow loading
   - workspace / lease
   - provider abstraction
   - run / verify / repair / retry loop
   - attempt / event / workpad 持久化
   - stop / retry / approve / resume 控制
   - host-neutral commands / queries / streams
3. `@codexbridge/mission-control` 不能依赖 CodexBridge 的平台/runtime/store/i18n 实现；CodexBridge 可以依赖它，它不能反向依赖 CodexBridge。
4. `/auto` 是 scheduler-owned host 功能，不属于 Mission Control；不要再把 `/auto` 接回 Mission Control。
5. 不要优先做 web dashboard、monorepo/workspace、多 package 发布、复杂多 agent 编排。
6. 除非 Mission Control 工作被真实阻塞，否则不要把工作重心切到其他 package。

当前集成重点：
1. `/agent` 仍然是 Mission v0 host surface；不要引入新的 `/mission` 命令来绕过集成收口。
2. 继续把 `/agent` 的读/控动作迁到 package-owned `commands / queries / streams`，不要让 bridge 继续拼 runtime 真相。
3. 继续缩小 `AgentJob` 的职责，只允许它保留 host-side projection / cache，不要让它继续充当 authoritative mission store。
4. 明确 host adapter 边界：
   - session / thread binding
   - approval UX
   - artifact delivery
   - notification
   - auth / identity context
5. 如果为了让 `/agent` 可继续工作而需要保留兼容投影，必须把它当过渡层处理，而不是倒推回 package API。
6. 对 host 有用但属于通用能力的东西，应优先沉到 package：
   - mission timeline/history
   - attempts
   - execution refs / host bindings
   - workpad / latest blocker / verifier summary
7. `/auto` 已出 scope；不要把 scheduler、定时任务、automation job 身份重新混回 Mission Control。

当前工作策略：
1. 优先修改：
   - `packages/mission-control/**`
   - `docs/architecture/mission-control.md`
   - `docs/architecture/mission-control-codexbridge-integration.md`
   - `docs/architecture/mission-control-loop-prompt.md`
   - `docs/todo/mission-control.md`
   - Mission Control 直接相关的集成文件
2. 除非改动确实跨切面，否则尽量少动：
   - `docs/todo/roadmap.md`
   - `README.md`
   - root `package.json`
3. 以 `docs/todo/mission-control.md` 为执行主 checklist；不要重复做已完成 bootstrap，而是继续推进下一个未完成阶段。
4. 当前优先级始终是：
   - checklist-first domain hardening
   - package-owned `commands / queries / streams`
   - CodexBridge host integration cleanup around `/agent`
   - first-host prompt/checklist confirmation UX
   - first-host paused-state / plan-change resolution UX
   - first-host loop snapshot / progress UX
   - first-host policy-driven proactive notification UX
   - persisted environment-stamp / checkpoint records
   - `AgentJob` projection cleanup
   - host adapter boundary hardening
   - generation/append-oriented history
   - package-owned supervision semantics 吸收 `loop.sh` 的有效部分

自动循环约束：
1. 每一轮只做一个“可验证的最小完整阶段”或一个清晰的子阶段。
2. 完成后必须更新 `docs/todo/mission-control.md`。
3. 如果本轮完成了一个可验证的最小完整阶段并且验证通过，必须在当前分支自动提交，但不要 push。
4. 如果本轮本应提交但无法安全提交，必须停止并进入 `NEEDS_HUMAN`，不要带着未提交改动继续下一轮。
5. 如果遇到产品边界不清、需要新增不可逆行为、需要人工决策、或连续失败超预算，停止并进入 `NEEDS_HUMAN`。
6. 只有当 `docs/todo/mission-control.md` 当前循环范围内的 checklist 全部完成，并且首个 host 的 prompt/checklist confirmation、paused-state resolution、loop snapshot UX、policy-driven notification UX，以及 environment-stamp / checkpoint 相关未勾项也已完成时，才可进入 `DONE`。

验证要求：
1. 能跑验证就跑验证。
2. 不能跑要明确说明阻塞点。
3. 每完成一个阶段必须给出可验证结果：`typecheck` / `tests` / `build`，或说明为什么暂时不能跑。

最终输出协议：
1. 正常回复后，最后必须单独输出一行：
   - `LOOP_STATUS: CONTINUE`
   - 或 `LOOP_STATUS: DONE`
   - 或 `LOOP_STATUS: NEEDS_HUMAN`
   - 或 `LOOP_STATUS: FAILED`
2. 紧接着再单独输出一行：
   - `LOOP_REASON: <一句话原因>`
3. 紧接着再单独输出这些机器可读字段：
   - `LOOP_PHASE: <当前完成的 phase 或子阶段>`
   - `LOOP_PROGRESS: <当前做到哪一步的简短摘要>`
   - `LOOP_NEXT: <下一步最合理的推进项>`
   - `LOOP_OVERALL_PROGRESS: <0-100% 或 x/y 的整体完成进度估算>`
   - `LOOP_COMMIT: <本轮产生的 commit hash；如果没有则写 none>`
4. 如果 `LOOP_STATUS: CONTINUE`，则 `LOOP_COMMIT` 不能是 `none`。
5. 在 `LOOP_STATUS` 之前，正常说明：
   - 本次完成了哪个 phase 或最小阶段
   - 修改了哪些代码、文档、checklist
   - 是否发现新增需求项或边界调整
   - 跑了哪些验证
   - 下一步最合理的推进项是什么
```
