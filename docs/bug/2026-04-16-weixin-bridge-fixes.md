# CodexBridge Bug Fix Record - 2026-04-16

## 背景

本次记录对应 `CodexBridge` 当前工作区内尚未提交的一组桥接修复，重点集中在微信桥接可观测性、Codex 会话恢复、最终答案流式转发，以及 Linux `systemd --user` 部署支持。

## 本次修改概览

- 为微信桥接新增 `systemd --user` 安装、状态、重启、日志脚本，并补充 README 使用说明。
- 为微信平台插件增加详细调试日志，便于定位“消息收到了但看起来没反应”的问题。
- 为 `BridgeCoordinator` 增加对 Codex rollout/session 文件损坏场景的重试恢复逻辑。
- 为 Codex provider / app client 增加 `onProgress` 透传，支持将 `final_answer` 进度往上游传递。
- 为微信运行时增加 typing 状态、分段流式发送、尾段补发、重复内容抑制和发送重试。
- 为上述行为补齐单元测试。

## 详细记录

### 1. Linux 用户态服务化支持

目标：
- 让微信桥接可以稳定以 `systemd --user` 服务运行，而不是手工启动。

修改：
- 在 `README.md` 中新增 `systemd user service` 使用说明。
- 新增环境文件模板 `config/examples/weixin.service.env.example`。
- 新增 systemd 单元模板 `ops/systemd/com.ganxing.codexbridge-weixin.service.template`。
- 新增服务脚本：
  - `scripts/service/install-systemd-user.sh`
  - `scripts/service/status-systemd-user.sh`
  - `scripts/service/restart-systemd-user.sh`
  - `scripts/service/logs-systemd-user.sh`
  - `scripts/service/_common.sh`

作用：
- 固化微信桥接部署方式。
- 将运行参数沉淀到 `~/.config/codexbridge/weixin.service.env`。
- 降低“进程挂了但没人发现”或“手工启动环境不一致”的风险。

### 2. 微信桥接调试日志增强

目标：
- 排查“桥接没反应”“消息到底有没有进来”“发送是否失败”等问题。

修改文件：
- `src/platforms/weixin/plugin.js`

修改内容：
- 为入站消息增加 `drop_message` 调试日志，明确区分：
  - `missing_sender`
  - `self_message`
  - `scope_not_allowed`
  - `no_text`
- 为正常接收消息增加 `accept_message` 日志。
- 为出站消息增加：
  - `send_text`
  - `send_text_result`
  - `send_text_failed`
- 通过环境变量 `CODEXBRIDGE_DEBUG_WEIXIN=1` 控制输出。

作用：
- 可以直接从日志判断消息在哪一层被丢弃或卡住。
- 能确认微信侧是否已收到桥接返回内容。

### 3. Codex 会话损坏恢复与重试

目标：
- 修复 Codex 线程仍有效，但 rollout/session 文件临时损坏时，桥接直接失败的问题。

修改文件：
- `src/core/bridge_coordinator.js`

修改内容：
- `handleInboundEvent` / `handleConversationTurn` / `startTurnOnSession` 增加 `options` 参数透传。
- 在 `startTurnWithRecovery` 中新增对以下错误的识别：
  - `failed to load rollout`
  - `empty session file`
- 对上述错误走“同一 session 最多重试 3 次”的恢复逻辑。
- 原有 stale thread 场景仍保持“重建 scope session”的逻辑。

作用：
- 减少因为临时 rollout 文件异常导致的整段对话失效。
- 避免把本来还能继续使用的 session 过早切换成新线程。

### 4. Codex 进度事件透传

目标：
- 让运行时能够在最终答案完成前，收到 `final_answer` 进度并提前推送。

修改文件：
- `src/providers/codex/plugin.js`
- `src/providers/codex/app_client.js`

修改内容：
- provider `startTurn()` 新增 `onProgress` 参数。
- `CodexAppClient` 改为继承 `EventEmitter`。
- `startTurn()` 支持接收 `onProgress`。
- 对 `turn/start`、`thread/read`、`thread/list`、`models/list`、`turn/interrupt` 等请求补充超时控制。
- 增强 app client 对 `agentMessage` / `phase` / `final_answer` / commentary 的识别。
- 支持在 thread history 最终落盘前，先从事件流中提取最终答案增量。

作用：
- 缩短微信侧首段回复等待时间。
- 避免把 commentary 误当成最终答案。

### 5. 微信最终答案流式转发

目标：
- 修复桥接长回复时“长时间无输出、最后一次性返回”的体验问题。

修改文件：
- `src/runtime/weixin_bridge_runtime.js`

修改内容：
- 处理入站事件时，先发送 typing start，结束时发送 typing stop。
- 仅处理 `final_answer` 类型的 progress。
- 将增长中的最终答案按段切分后逐段发送。
- 对未形成完整段落的尾部文本做暂存与最终补发。
- 当流式内容与最终落盘内容一致时，抑制重复发送。
- 当最终内容比已流式内容更长时，仅补发尾段。
- 当 progress 快照发生分叉时，回退到最终答案整体发送。
- 对微信发送增加一次失败后的重试。

作用：
- 用户能更早看到结果，不再长期“没反应”。
- 减少流式发送与最终结果重复刷屏的问题。

### 6. 测试补齐

修改文件：
- `test/core/bridge_coordinator.test.js`
- `test/providers/codex/app_client.test.js`
- `test/runtime/weixin_bridge_runtime.test.js`

新增覆盖：
- rollout 文件损坏后的重试恢复。
- 持续损坏时保持原 session 绑定不被错误改写。
- `final_answer` 进度上报。
- `agentMessage` 在不同 phase 下的分类。
- commentary 不应被误识别为最终答案。
- 微信运行时的分段发送、尾段补发、typing 状态、重复抑制、分叉回退。

### 7. 微信已收消息但未回包的补充问题

状态：
- 已修复

现象：
- 微信侧能看到 bot 进入 typing，但收不到正文回复。
- 桥接日志里能看到 `accept_message`，说明微信消息已经进入 `CodexBridge`。
- 同时也能通过直接调用 iLink `sendmessage` 主动给同一用户发测试消息，说明 `CodexBridge -> 微信` 的出站链路可用。

已确认的链路结论：
- `微信 -> CodexBridge`：可用
- `CodexBridge -> Codex`：可用，Codex 实际产出了最终答案
- `CodexBridge -> 微信`：可用
- 真正异常点在 `Codex -> CodexBridge` 的结果识别适配层

根因定位：
- `src/providers/codex/app_client.js` 在 `mapTurnItem()` 中没有保留 `role` 信息。
- 同文件的 `extractTurnOutputText()` / `turnContainsOnlyNonFinalVisibleItems()` 只识别：
  - `agentMessage`
  - `assistant_message`
- 但真实 `Codex` 落盘结果里，最终答案可能是：
  - `type: "message"`
  - `role: "assistant"`
  - `phase: "final_answer"`
- 这类 item 被误判后，`waitForTurnResult()` 会返回空字符串，导致微信运行时只发 typing，不发正文。

复现证据：
- 用户在微信发送：`还没干么？`
- 桥接日志中出现 `accept_message`
- 对应 Codex rollout 中存在 `phase: "final_answer"` 的 assistant 消息
- 但微信日志中没有对应的 `send_text`

修复计划：
- 在 `app_client` 中保留 turn item 的 `role`
- 将 `message + role=assistant` 视为有效 assistant 输出
- 将 `message + role=user` 视为用户可见输入，避免终态判断提前返回空结果
- 补充单元测试覆盖这类真实返回结构

已完成修改：
- `src/providers/codex/app_client.js`
  - `mapTurnItem()` 新增保留 `role`
  - turn 终态提取逻辑不再只识别 `agentMessage` / `assistant_message`
  - 现在会同时识别 `message + role=assistant`
  - 用户消息判断也兼容 `message + role=user`
  - 进度通知额外兼容 `item/message/delta` 以及 `message + role=assistant` 形态
- `test/providers/codex/app_client.test.js`
  - 新增 `message + role=assistant` 最终答案识别测试
  - 新增 commentary -> final_answer 等待测试
  - 新增 `item/message/delta` 流式进度识别测试

验证结果：
- `node --test test/providers/codex/app_client.test.js`
- `node --test test/runtime/weixin_bridge_runtime.test.js`
- 上述测试均通过

## 本次涉及的已修改文件

- `README.md`
- `src/core/bridge_coordinator.js`
- `src/platforms/weixin/plugin.js`
- `src/providers/codex/app_client.js`
- `src/providers/codex/plugin.js`
- `src/runtime/weixin_bridge_runtime.js`
- `test/core/bridge_coordinator.test.js`
- `test/providers/codex/app_client.test.js`
- `test/runtime/weixin_bridge_runtime.test.js`
- `config/examples/weixin.service.env.example`
- `ops/systemd/com.ganxing.codexbridge-weixin.service.template`
- `scripts/service/_common.sh`
- `scripts/service/install-systemd-user.sh`
- `scripts/service/status-systemd-user.sh`
- `scripts/service/restart-systemd-user.sh`
- `scripts/service/logs-systemd-user.sh`

## 备注

- 当前仓库里还有未跟踪目录 `.telegram-inbox/` 和 `.codex`，这两项更像运行产物或本地工具目录，不纳入本次 bug 修复记录主体。
- 本文档只记录当前工作区中可见的未提交修改，不代表这些修改已经完成提交或发布。
