# Weixin Delivery Best Practice

## Problem Statement

CodexBridge 当前的微信出站问题，不是单一的 `final` 识别 bug，而是整条发送链路没有把“消息交付”当成一个独立、可恢复的事务。

已确认的真实故障形态有两类：

1. Codex 已经产出完整 final，但桥接层过早拿不到 final，于是只发 typing 或误发失败提示。
2. 微信分段发送进行到中途时，某一段 `sendmessage` 返回 `ret=-2`，后续内容全部中断，甚至直接导致进程异常退出。

这两类问题里，第二类是当前微信长回复缺失、代码块半截、最后尾段丢失的主因。

## Evidence

以 `Code Mission Control是如何使用的？` 这轮为例：

- Codex rollout 中存在完整 final。
- 微信实际前两段发送成功。
- 第三段 `sendmessage` 连续返回 `ret=-2`。
- 当前运行时在该错误后没有把本轮剩余内容作为一个可恢复的 delivery transaction 继续处理，导致整轮后续内容中断。

## Hermes Comparison

Hermes 可以借鉴的点：

1. 平台 adapter 负责“尝试发送”，通用层负责重试和降级。
2. 流式消费者维护“用户已经看到了什么前缀”，失败后补 continuation，而不是盲目全量重发。
3. 微信文本切块遵循 Markdown/代码块边界，不在 fenced code block 中间乱切。

Hermes 不能直接照抄的点：

1. Hermes 的 Weixin `_send_message()` 本身没有像 CodexBridge 一样严格断言 `ret != 0`。
2. CodexBridge 必须继续保留“业务 ret 非 0 就算失败”的严格语义。

## Final Design

目标只有一个：

**任何一轮微信回复，都必须作为一个“可恢复的发送事务”处理。**

### 1. Provider and delivery stay separate

- Provider 负责拿到完整 final 文本。
- Weixin runtime 负责把这份 final 文本可靠送达。
- 不再把 delivery 故障误诊成 provider/final 识别故障。

### 2. Weixin chunking must be structure-aware

微信分块规则必须满足：

- fenced code block 作为整体 delivery unit，不能在三反引号内部切开。
- 顶层段落、列表项、缩进行为一个 unit。
- 超长 unit 再做二次拆分。
- chunk join 后必须能重构原文本前缀。

### 3. Base sending follows byte-and-time gates

基础发送逻辑按以下规则执行：

1. 第一条回复立即发出。
2. 后续回复若在 3 秒内累计内容超过 600 字节，则进入分段处理。
3. 进入分段处理后，本次仅发送 600 字节，避免单次发送过多内容。
4. 发送后等待 3 秒再次检查：
   - 若剩余内容仍超过 600 字节，则继续按 600 字节发送下一段。
   - 若剩余内容未超过 600 字节，则将剩余内容一次性全部发出。
5. 核心原则是字节长度与时间的双重限制：
   - 长度门槛：600 字节
   - 时间门槛：3 秒

也就是说，运行时不能只看长度，也不能只看时间，而是必须同时受这两个条件约束。

### 4. Final preempts preview, but ordering still holds

在 preview 发送过程中，如果收到 final 信号，应立即切换到 final 交付流程：

1. 直接下发 final 内容，不再继续按照 preview 规则安排新的 preview 发送。
2. final 内容的发送同样必须遵守时间顺序，不能出现后到内容先发、先到内容后发。
3. final 的单次长度上限放宽到 2048 字节。

这里的含义不是“preview 作废后整轮重来”，而是：

- 已经成功送达的 preview 前缀保持有效。
- 后续交付由 final 接管。
- final 的优先级高于尚未发出的 preview。

### 5. Platform send returns a delivery result, not a fatal exception

平台发送层应返回结构化结果：

- `success`
- `deliveredChunks`
- `deliveredText`
- `failedChunkIndex`
- `failedChunkText`
- `error`

单个 chunk 连续失败后，允许本轮发送失败，但不允许把整个 gateway 进程直接打崩。

### 6. Retry happens per chunk, not by resending the whole content blindly

对于每个 chunk：

- 先做有限次重试
- 使用退避等待
- 仍失败时返回失败结果

禁止“某一段失败后，把整份 content 从头再发一遍”，因为这会造成前缀重复和状态混乱。

### 7. Final delivery is continuation-aware

运行时需要维护本轮已经成功送达给微信的可见文本前缀。

当 final 发送中途失败时：

- 只重试“尚未成功送达的 continuation”
- 不重发已经成功到达用户的前缀
- 只有所有 final continuation 都完成发送，这轮才算真正结束
- final continuation 的单次发送上限按 2048 字节处理，而不是沿用 preview 的 600 字节门槛

### 8. Preview failure must not crash the turn

如果 preview 某一段发送失败：

- 立即停止后续 preview
- 保留已经成功送达的 preview 前缀
- turn 继续跑
- 最后由 final delivery transaction 接管收尾

### 9. Final failure must not crash the process

如果 final 某一段连续失败：

- 本轮标记 delivery failed
- 记录最后成功前缀和失败段
- 不中断整个 bridge 进程
- 允许后续消息继续处理

## Implementation Order

1. 先替换 Weixin 文本分块逻辑，借鉴 Hermes 的结构感知切块。
2. 在运行时落实基础发送的 600 字节 + 3 秒双门槛。
3. 在运行时落实 preview 过程中 final 信号的接管，并将 final 单次上限放宽到 2048 字节。
4. 平台发送改为返回 delivery result，而不是在 chunk 失败时直接把整轮炸掉。
5. 运行时改成 continuation-aware final delivery。
6. preview 发送失败只停 preview，不影响整轮和进程。
7. 用测试覆盖：
   - fenced code block 不被切坏
   - 第一条回复立即发出
   - 后续回复遵守 600 字节 + 3 秒门槛
   - preview 过程中收到 final 时，由 final 接管，且 final 按 2048 字节上限发送
   - 中途 chunk `ret=-2` 时可以续发后续 final
   - 单次发送失败不会导致进程级异常

## Success Criteria

修复完成后，应满足：

1. Codex 完整 final 存在时，微信不会因为中途某个 chunk `ret=-2` 就永久丢掉后续内容。
2. 回复不会在代码块或明显的 Markdown 结构中间断裂。
3. 第一条回复立即可见，后续回复必须遵守 600 字节 + 3 秒双门槛。
4. preview 过程中收到 final 时，final 会按时序接管，并按 2048 字节上限发送。
5. 单轮发送失败不会导致微信 bridge 进程退出。
6. 运行时日志能明确看出：成功前缀、失败 chunk、补发 continuation。
