import assert from 'node:assert/strict';
import test from 'node:test';
import { WeixinBridgeRuntime } from '../../src/runtime/weixin_bridge_runtime.js';
import { createI18n } from '../../src/i18n/index.js';

interface RuntimeHarnessOptions {
  coordinator: any;
  automationJobs?: any;
  sendText: (payload: { externalScopeId: string; content: string }) => Promise<any> | any;
  sendMedia?: (payload: { externalScopeId: string; filePath: string; caption?: string | null }) => Promise<any> | any;
  sendTyping?: (payload: { externalScopeId: string; status: 'start' | 'stop' }) => Promise<void> | void;
  commitSyncCursor?: (syncCursor: string) => Promise<void> | void;
  previewSoftTargetBytes?: number;
  previewIntervalMs?: number;
  typingKeepaliveMs?: number;
  inboundAttachmentMergeWindowMs?: number;
  automationPollMs?: number;
  pollEvents?: any[];
}

function makeRuntime({
  coordinator,
  automationJobs = null,
  sendText,
  sendMedia,
  sendTyping,
  commitSyncCursor,
  previewSoftTargetBytes = 1,
  previewIntervalMs = 0,
  typingKeepaliveMs = 8000,
  inboundAttachmentMergeWindowMs = 3000,
  automationPollMs = 30_000,
  pollEvents = null,
}: RuntimeHarnessOptions) {
  return new WeixinBridgeRuntime({
    platformPlugin: {
      async start() {},
      async stop() {},
      async pollOnce() {
        return {
          syncCursor: 'cursor-1',
          events: pollEvents ?? [{
            platform: 'weixin',
            externalScopeId: 'wxid_1',
            text: 'hello',
          }],
        };
      },
      async commitSyncCursor(syncCursor: string) {
        await commitSyncCursor?.(syncCursor);
      },
      async sendText(payload: { externalScopeId: string; content: string }) {
        const result = await sendText(payload);
        return result ?? {
          success: true,
          deliveredCount: 1,
          deliveredText: payload.content,
          failedIndex: null,
          failedText: '',
          error: '',
        };
      },
      async sendTyping(payload: { externalScopeId: string; status: 'start' | 'stop' }) {
        await sendTyping?.(payload);
      },
      async sendMedia(payload: { externalScopeId: string; filePath: string; caption?: string | null }) {
        const result = await sendMedia?.(payload);
        return result ?? {
          success: true,
          messageId: 'media-1',
          sentPath: payload.filePath,
          sentCaption: String(payload.caption ?? '').trim(),
          error: '',
        };
      },
    },
    bridgeCoordinator: coordinator,
    automationJobs,
    previewSoftTargetBytes,
    previewIntervalMs,
    typingKeepaliveMs,
    inboundAttachmentMergeWindowMs,
    automationPollMs,
  });
}

function completeResponse(text: string) {
  return {
    type: 'message',
    messages: [{ text }],
    meta: {
      codexTurn: {
        outputState: 'complete',
        previewText: '',
        finalSource: 'thread_items',
      },
    },
  };
}

test('WeixinBridgeRuntime forwards poll events into the bridge coordinator and sends the response', async () => {
  const seen: string[] = [];
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const committed: string[] = [];
  const typing: Array<{ externalScopeId: string; status: 'start' | 'stop' }> = [];
  const runtime = makeRuntime({
    commitSyncCursor: async (syncCursor) => {
      committed.push(syncCursor);
    },
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    sendTyping: async ({ externalScopeId, status }) => {
      typing.push({ externalScopeId, status });
    },
    coordinator: {
      async handleInboundEvent(event: any, options: any = {}) {
        seen.push(event.text);
        await options.onProgress?.({
          text: '先看一下当前情况。\n\n我继续检查实现细节。',
          outputKind: 'final_answer',
        });
        return completeResponse('line 1\n\nline 2');
      },
    },
  });

  const result = await runtime.runOnce();

  assert.equal(result.events.length, 1);
  assert.deepEqual(seen, ['hello']);
  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '先看一下当前情况。' },
    { externalScopeId: 'wxid_1', content: 'line 1\n\nline 2' },
  ]);
  assert.deepEqual(typing, [
    { externalScopeId: 'wxid_1', status: 'start' },
    { externalScopeId: 'wxid_1', status: 'stop' },
  ]);
  assert.deepEqual(committed, ['cursor-1']);
});

test('WeixinBridgeRuntime keeps sending typing notifications while a long-running turn is still processing', async () => {
  const typing: Array<{ externalScopeId: string; status: 'start' | 'stop' }> = [];
  const runtime = makeRuntime({
    typingKeepaliveMs: 5,
    sendText: async () => {},
    sendTyping: async ({ externalScopeId, status }) => {
      typing.push({ externalScopeId, status });
    },
    coordinator: {
      async handleInboundEvent(_event: any) {
        await new Promise((resolve) => setTimeout(resolve, 16));
        return completeResponse('done');
      },
    },
  });

  await runtime.runOnce();

  assert.equal(typing[0]?.status, 'start');
  assert.equal(typing.at(-1)?.status, 'stop');
  assert.equal(typing.filter((entry) => entry.status === 'start').length >= 2, true);
});

test('WeixinBridgeRuntime does not deadlock when the first final preview delta has no sentence boundary', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const runtime = makeRuntime({
    previewSoftTargetBytes: 1024,
    previewIntervalMs: 1,
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(_event: any, options: any = {}) {
        await options.onProgress?.({
          text: '我',
          delta: '我',
          outputKind: 'final_answer',
        });
        await options.onProgress?.({
          text: '我已经查完了。',
          delta: '已经查完了。',
          outputKind: 'final_answer',
        });
        return completeResponse('我已经查完了。');
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '我已经查完了。' },
  ]);
});

test('WeixinBridgeRuntime runs /review in the background so the immediate progress preview can be delivered without blocking dispatch', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  let releaseReview: () => void = () => {};
  const reviewGate = new Promise<void>((resolve) => {
    releaseReview = resolve;
  });
  const runtime = makeRuntime({
    previewSoftTargetBytes: 1024,
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(_event: any, options: any = {}) {
        await options.onProgress?.({
          text: '正在运行代码审查：代码审查 | 未提交改动。',
          delta: '正在运行代码审查：代码审查 | 未提交改动。',
          outputKind: 'commentary',
        });
        await reviewGate;
        return completeResponse('代码审查 | 未提交改动\n\n最终审查结果。');
      },
    },
  });

  const outcome = await runtime.dispatchInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wxid_1',
    text: '/review',
  });

  assert.equal(outcome?.type, 'scheduled');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '正在运行代码审查：代码审查 | 未提交改动。' },
  ]);

  releaseReview();
  await runtime.waitForIdle();

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '正在运行代码审查：代码审查 | 未提交改动。' },
    { externalScopeId: 'wxid_1', content: '代码审查 | 未提交改动\n\n最终审查结果。' },
  ]);
});

test('WeixinBridgeRuntime does not queue /review behind an existing scope task', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  let releaseTurn: () => void = () => {};
  const turnGate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const runtime = makeRuntime({
    previewSoftTargetBytes: 1024,
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(event: any) {
        if (event.text === 'hello') {
          await turnGate;
          return completeResponse('final answer');
        }
        return completeResponse('当前有回复在进行中，暂时不能执行 /review。');
      },
    },
  });

  const first = await runtime.dispatchInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wxid_1',
    text: 'hello',
  });
  assert.equal(first?.type, 'scheduled');

  const second = await runtime.dispatchInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wxid_1',
    text: '/review',
  });
  assert.equal(second?.type, 'scheduled');

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '当前有回复在进行中，暂时不能执行 /review。' },
  ]);

  releaseTurn();
  await runtime.waitForIdle();

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '当前有回复在进行中，暂时不能执行 /review。' },
    { externalScopeId: 'wxid_1', content: 'final answer' },
  ]);
});

test('WeixinBridgeRuntime merges an image-only inbound message with the next text message into one Codex turn', async () => {
  const seen: Array<{ text: string; attachmentCount: number }> = [];
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const runtime = makeRuntime({
    pollEvents: [
      {
        platform: 'weixin',
        externalScopeId: 'wxid_1',
        text: '',
        attachments: [{
          kind: 'image',
          localPath: '/tmp/codexbridge-image-1.png',
        }],
      },
      {
        platform: 'weixin',
        externalScopeId: 'wxid_1',
        text: '帮我看看这张图是什么意思？',
      },
    ],
    inboundAttachmentMergeWindowMs: 5,
    previewSoftTargetBytes: 1024,
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(event: any) {
        seen.push({
          text: event.text,
          attachmentCount: Array.isArray(event.attachments) ? event.attachments.length : 0,
        });
        return completeResponse('已收到图片和问题。');
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(seen, [
    {
      text: '帮我看看这张图是什么意思？',
      attachmentCount: 1,
    },
  ]);
  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '已收到图片和问题。' },
  ]);
});

test('WeixinBridgeRuntime flushes an image-only inbound message after the merge window when no follow-up text arrives', async () => {
  const seen: Array<{ text: string; attachmentCount: number }> = [];
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const runtime = makeRuntime({
    pollEvents: [
      {
        platform: 'weixin',
        externalScopeId: 'wxid_1',
        text: '',
        attachments: [{
          kind: 'image',
          localPath: '/tmp/codexbridge-image-2.png',
        }],
      },
    ],
    inboundAttachmentMergeWindowMs: 5,
    previewSoftTargetBytes: 1024,
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(event: any) {
        seen.push({
          text: event.text,
          attachmentCount: Array.isArray(event.attachments) ? event.attachments.length : 0,
        });
        return completeResponse('已收到图片。');
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(seen, [
    {
      text: '',
      attachmentCount: 1,
    },
  ]);
  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '已收到图片。' },
  ]);
});

test('WeixinBridgeRuntime dispatches plain-text turns in the background so slash commands can run immediately', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  let releaseTurn: (value?: unknown) => void = () => {};
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(event: any) {
        if (event.text === 'hello') {
          await turnGate;
          return completeResponse('final answer');
        }
        return {
          type: 'message',
          messages: [{ text: 'stop requested' }],
        };
      },
    },
  });

  const scheduled = await runtime.dispatchInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wxid_1',
    text: 'hello',
  });
  assert.equal(scheduled.type, 'scheduled');
  assert.equal(typeof scheduled.completion?.then, 'function');
  await runtime.dispatchInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wxid_1',
    text: '/stop',
  });

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: 'stop requested' },
  ]);

  releaseTurn();
  await runtime.waitForIdle();

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: 'stop requested' },
    { externalScopeId: 'wxid_1', content: 'final answer' },
  ]);
});

test('WeixinBridgeRuntime swallows a single slash keepalive pulse without replying or forwarding to Codex', async () => {
  const seen: string[] = [];
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const typing: Array<{ externalScopeId: string; status: 'start' | 'stop' }> = [];
  const runtime = makeRuntime({
    pollEvents: [
      {
        platform: 'weixin',
        externalScopeId: 'wxid_1',
        text: '/',
      },
    ],
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    sendTyping: async ({ externalScopeId, status }) => {
      typing.push({ externalScopeId, status });
    },
    coordinator: {
      async handleInboundEvent(event: any) {
        seen.push(event.text);
        return completeResponse('should not happen');
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(seen, []);
  assert.deepEqual(sent, []);
  assert.deepEqual(typing, []);
});

test('WeixinBridgeRuntime sends a compact WeChat approval prompt when Codex requests approval mid-turn', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const seenEvents: string[] = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      renderApprovalPrompt() {
        return '审批请求 | 1 项\n回复 /allow 查看详情\n快捷回复：/allow 1、/allow 2、/deny';
      },
      async handleInboundEvent(event: any, options: any = {}) {
        seenEvents.push(event.text);
        await options.onApprovalRequest?.({
          requestId: 'approval-1',
          kind: 'command',
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          reason: 'command failed; retry without sandbox?',
        });
        return completeResponse('已继续执行。');
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(seenEvents, ['hello']);
  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '审批请求 | 1 项\n回复 /allow 查看详情\n快捷回复：/allow 1、/allow 2、/deny' },
    { externalScopeId: 'wxid_1', content: '已继续执行。' },
  ]);
});

test('WeixinBridgeRuntime queues a visible approval warning when Weixin rate-limits the approval prompt', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  let sendAttempts = 0;
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sendAttempts += 1;
      if (sendAttempts <= 2) {
        return {
          success: false,
          deliveredCount: 0,
          deliveredText: '',
          failedIndex: 0,
          failedText: content,
          error: '微信消息发送失败（scope=wxid_1, clientId=test）：: -2',
          errorCode: -2,
        };
      }
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      renderApprovalPrompt() {
        return '审批请求 | 1 项\n回复 /allow 查看详情\n快捷回复：/allow 1、/allow 2、/deny';
      },
      async handleInboundEvent(event: any, options: any = {}) {
        if (event.text === 'hello') {
          await options.onApprovalRequest?.({
            requestId: 'approval-queued-1',
            kind: 'command',
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-1',
            reason: 'command failed; retry without sandbox?',
          });
          return completeResponse('已继续执行。');
        }
        return completeResponse('后续正常回复');
      },
    },
  });

  await runtime.runOnce();
  await runtime.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wxid_1',
    text: 'next',
  });

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '微信发送频率过快（ret: -2），审批提示可能未送达。请稍后直接发送 /allow 查看详情。' },
    { externalScopeId: 'wxid_1', content: '已继续执行。' },
    { externalScopeId: 'wxid_1', content: '后续正常回复' },
  ]);
});

test('WeixinBridgeRuntime sends media-only response messages through platform sendMedia', async () => {
  const sentMedia: Array<{ externalScopeId: string; filePath: string; caption?: string | null }> = [];
  const runtime = makeRuntime({
    sendText: async () => {},
    sendMedia: async (payload) => {
      sentMedia.push(payload);
    },
    coordinator: {
      async handleInboundEvent() {
        return {
          type: 'message',
          messages: [{
            mediaPath: '/tmp/example.png',
            caption: '截图说明',
          }],
        };
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sentMedia, [
    {
      externalScopeId: 'wxid_1',
      filePath: '/tmp/example.png',
      caption: '截图说明',
    },
  ]);
});

test('WeixinBridgeRuntime runs due automation jobs against the same WeChat scope and records completion', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const typing: Array<{ externalScopeId: string; status: 'start' | 'stop' }> = [];
  const deferredCalls: Array<{ id: string; nextRunAt: number }> = [];
  const updatedCalls: Array<{ id: string; bridgeSessionId: string }> = [];
  const completedCalls: Array<{ id: string; resultPreview?: string | null; error?: string | null; deliveredAt?: number | null }> = [];
  const job = {
    id: 'auto-1',
    platform: 'weixin',
    externalScopeId: 'wxid_1',
    title: '部署巡检',
    mode: 'standalone',
    bridgeSessionId: 'session-auto-1',
    cwd: '/tmp/codexbridge-auto',
    locale: 'zh-CN',
    prompt: '检查部署是否完成',
  };
  const seenEvents: any[] = [];
  const runtime = makeRuntime({
    automationJobs: {
      claimDueJobs() {
        return [job];
      },
      updateJob(id: string, payload: any) {
        updatedCalls.push({ id, bridgeSessionId: payload.bridgeSessionId });
      },
      deferJob(id: string, nextRunAt: number) {
        deferredCalls.push({ id, nextRunAt });
      },
      completeJob(id: string, payload: any) {
        completedCalls.push({ id, ...payload });
      },
      resetRunningJobs() {},
    },
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    sendTyping: async ({ externalScopeId, status }) => {
      typing.push({ externalScopeId, status });
    },
    coordinator: {
      async reconcileActiveTurn() {
        return null;
      },
      async handleInboundEvent(event: any, options: any = {}) {
        seenEvents.push(event);
        await options.onProgress?.({
          text: '正在读取助理记录。',
          delta: '正在读取助理记录。',
          outputKind: 'commentary',
        });
        return {
          ...completeResponse('自动化执行完成。'),
          session: {
            bridgeSessionId: 'session-auto-1b',
            providerProfileId: 'openai-default',
            codexThreadId: 'thread-auto-1b',
          },
        };
      },
    },
  });

  await runtime.runAutomationSweep();
  await runtime.waitForIdle();

  assert.equal(deferredCalls.length, 0);
  assert.equal(seenEvents.length, 1);
  assert.equal(seenEvents[0]?.metadata?.codexbridge?.overrideBridgeSessionId, 'session-auto-1');
  assert.equal(seenEvents[0]?.metadata?.codexbridge?.automationJobId, 'auto-1');
  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '自动化执行完成。' },
  ]);
  assert.deepEqual(typing, []);
  assert.deepEqual(updatedCalls, [
    { id: 'auto-1', bridgeSessionId: 'session-auto-1b' },
  ]);
  assert.equal(completedCalls.length, 1);
  assert.equal(completedCalls[0]?.id, 'auto-1');
  assert.equal(completedCalls[0]?.resultPreview, '自动化执行完成。');
  assert.equal(completedCalls[0]?.error, null);
  assert.ok(typeof completedCalls[0]?.deliveredAt === 'number');
});

test('WeixinBridgeRuntime defers due automation jobs when the scope is busy', async () => {
  const deferredCalls: Array<{ id: string; nextRunAt: number }> = [];
  const job = {
    id: 'auto-2',
    platform: 'weixin',
    externalScopeId: 'wxid_1',
    title: '排障巡检',
    mode: 'standalone',
    bridgeSessionId: 'session-auto-2',
    cwd: '/tmp/codexbridge-auto',
    locale: 'zh-CN',
    prompt: '继续排查问题',
  };
  const runtime = makeRuntime({
    automationJobs: {
      claimDueJobs() {
        return [job];
      },
      deferJob(id: string, nextRunAt: number) {
        deferredCalls.push({ id, nextRunAt });
      },
      completeJob() {
        throw new Error('completeJob should not be called while scope is busy');
      },
      resetRunningJobs() {},
    },
    sendText: async () => {
      throw new Error('sendText should not be called while scope is busy');
    },
    coordinator: {
      async reconcileActiveTurn() {
        return { turnId: 'turn-live' };
      },
      async handleInboundEvent() {
        throw new Error('handleInboundEvent should not run while scope is busy');
      },
    },
  });

  await runtime.runAutomationSweep();
  await runtime.waitForIdle();

  assert.equal(deferredCalls.length, 1);
  assert.equal(deferredCalls[0]?.id, 'auto-2');
  assert.equal(typeof deferredCalls[0]?.nextRunAt, 'number');
});

test('WeixinBridgeRuntime sends artifact-based response messages through platform sendMedia', async () => {
  const sentMedia: Array<{ externalScopeId: string; filePath: string; caption?: string | null }> = [];
  const runtime = makeRuntime({
    sendText: async () => {},
    sendMedia: async (payload) => {
      sentMedia.push(payload);
    },
    coordinator: {
      async handleInboundEvent() {
        return {
          type: 'message',
          messages: [{
            artifact: {
              kind: 'file',
              path: '/tmp/example.pdf',
              displayName: 'example.pdf',
              mimeType: 'application/pdf',
              sizeBytes: 12,
              caption: 'PDF 附件',
              source: 'provider_native',
              turnId: 'turn-1',
            },
          }],
        };
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sentMedia, [
    {
      externalScopeId: 'wxid_1',
      filePath: '/tmp/example.pdf',
      caption: 'PDF 附件',
    },
  ]);
});

test('WeixinBridgeRuntime sends complete media-only Codex turns without requiring final text', async () => {
  const sentText: Array<{ externalScopeId: string; content: string }> = [];
  const sentMedia: Array<{ externalScopeId: string; filePath: string; caption?: string | null }> = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sentText.push({ externalScopeId, content });
    },
    sendMedia: async (payload) => {
      sentMedia.push(payload);
    },
    coordinator: {
      async handleInboundEvent() {
        return {
          type: 'message',
          messages: [{
            mediaPath: '/tmp/generated-dog.png',
            caption: null,
          }],
          meta: {
            codexTurn: {
              outputState: 'complete',
              previewText: '',
              finalSource: 'thread_items_media',
            },
          },
        };
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sentText, []);
  assert.deepEqual(sentMedia, [{
    externalScopeId: 'wxid_1',
    filePath: '/tmp/generated-dog.png',
    caption: null,
  }]);
});

test('WeixinBridgeRuntime reports media upload failures after Codex generates an attachment', async () => {
  const sentText: Array<{ externalScopeId: string; content: string }> = [];
  const sentMedia: Array<{ externalScopeId: string; filePath: string; caption?: string | null }> = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sentText.push({ externalScopeId, content });
    },
    sendMedia: async (payload) => {
      sentMedia.push(payload);
      return {
        success: false,
        messageId: null,
        sentPath: payload.filePath,
        sentCaption: String(payload.caption ?? '').trim(),
        error: 'CDN upload server error: status 500',
      };
    },
    coordinator: {
      async handleInboundEvent() {
        return {
          type: 'message',
          messages: [{
            mediaPath: '/tmp/generated-kitten.png',
            caption: null,
          }],
          meta: {
            codexTurn: {
              outputState: 'complete',
              previewText: '',
              finalSource: 'thread_items_media',
            },
          },
        };
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sentMedia, [{
    externalScopeId: 'wxid_1',
    filePath: '/tmp/generated-kitten.png',
    caption: null,
  }]);
  assert.deepEqual(sentText, [{
    externalScopeId: 'wxid_1',
    content: '附件已生成，但微信上传失败：CDN upload server error: status 500。可用 /retry 重试。',
  }]);
});

test('WeixinBridgeRuntime rewrites ret -2 media upload failures into a fixed retry hint', async () => {
  const sentText: Array<{ externalScopeId: string; content: string }> = [];
  const sentMedia: Array<{ externalScopeId: string; filePath: string; caption?: string | null }> = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sentText.push({ externalScopeId, content });
    },
    sendMedia: async (payload) => {
      sentMedia.push(payload);
      return {
        success: false,
        messageId: null,
        sentPath: payload.filePath,
        sentCaption: String(payload.caption ?? '').trim(),
        error: 'sendMediaItems: -2',
        errorCode: -2,
      };
    },
    coordinator: {
      async handleInboundEvent() {
        return {
          type: 'message',
          messages: [{
            mediaPath: '/tmp/generated-kitten-rate-limit.png',
            caption: null,
          }],
          meta: {
            codexTurn: {
              outputState: 'complete',
              previewText: '',
              finalSource: 'thread_items_media',
            },
          },
        };
      },
    },
  });

  await runtime.runOnce();

  assert.equal(sentMedia.length, 3);
  assert.deepEqual(sentText, [{
    externalScopeId: 'wxid_1',
    content: '附件已生成，但微信上传失败：微信发送频率过快（ret: -2）。可用 /retry 重试。',
  }]);
});

test('WeixinBridgeRuntime retries ret -2 media uploads and suppresses the failure notice after success', async () => {
  const sentText: Array<{ externalScopeId: string; content: string }> = [];
  const sentMedia: Array<{ externalScopeId: string; filePath: string; caption?: string | null }> = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sentText.push({ externalScopeId, content });
    },
    sendMedia: async (payload) => {
      sentMedia.push(payload);
      if (sentMedia.length === 1) {
        return {
          success: false,
          messageId: null,
          sentPath: payload.filePath,
          sentCaption: String(payload.caption ?? '').trim(),
          error: 'sendMediaItems: -2',
          errorCode: -2,
        };
      }
      return {
        success: true,
        messageId: 'media-ok',
        sentPath: payload.filePath,
        sentCaption: String(payload.caption ?? '').trim(),
        error: '',
      };
    },
    coordinator: {
      async handleInboundEvent() {
        return {
          type: 'message',
          messages: [{
            mediaPath: '/tmp/generated-report.docx',
            caption: '报告',
          }],
          meta: {
            codexTurn: {
              outputState: 'complete',
              previewText: '',
              finalSource: 'thread_items_media',
            },
          },
        };
      },
    },
  });

  await runtime.runOnce();

  assert.equal(sentMedia.length, 2);
  assert.deepEqual(sentText, []);
});

test('WeixinBridgeRuntime sends final text before media attachments in the same response', async () => {
  const sentText: Array<{ externalScopeId: string; content: string }> = [];
  const sentMedia: Array<{ externalScopeId: string; filePath: string; caption?: string | null }> = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sentText.push({ externalScopeId, content });
    },
    sendMedia: async (payload) => {
      sentMedia.push(payload);
    },
    coordinator: {
      async handleInboundEvent() {
        return {
          type: 'message',
          messages: [
            { text: '最终结果如下。' },
            { mediaPath: '/tmp/example.pdf', caption: '附带文件' },
          ],
          meta: {
            codexTurn: {
              outputState: 'complete',
              previewText: '',
              finalSource: 'thread_items',
            },
          },
        };
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sentText, [
    { externalScopeId: 'wxid_1', content: '最终结果如下。' },
  ]);
  assert.deepEqual(sentMedia, [
    { externalScopeId: 'wxid_1', filePath: '/tmp/example.pdf', caption: '附带文件' },
  ]);
});

test('WeixinBridgeRuntime suppresses the final send when streamed preview already matches the final content', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(_event: any, options: any = {}) {
        await options.onProgress?.({
          text: '第一段。\n\n第二段。',
          outputKind: 'final_answer',
        });
        return completeResponse('第一段。\n\n第二段。');
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '第一段。' },
    { externalScopeId: 'wxid_1', content: '第二段。' },
  ]);
});

test('WeixinBridgeRuntime sends only the trailing tail when the final response extends the streamed final text', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(_event: any, options: any = {}) {
        await options.onProgress?.({
          text: '第一段。\n\n第二段。',
          outputKind: 'final_answer',
        });
        return completeResponse('第一段。\n\n第二段。\n\n第三段。');
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '第一段。' },
    { externalScopeId: 'wxid_1', content: '第二段。\n\n第三段。' },
  ]);
});

test('WeixinBridgeRuntime merges commentary and final-answer progress into the preview stream', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    previewSoftTargetBytes: 1024,
    coordinator: {
      async handleInboundEvent(_event: any, options: any = {}) {
        await options.onProgress?.({
          text: '我先检查一下上下文。',
          delta: '我先检查一下上下文。',
          outputKind: 'commentary',
        });
        await options.onProgress?.({
          text: '最终答案第一段。\n\n最终答案第二段。',
          delta: '最终答案第一段。\n\n最终答案第二段。',
          outputKind: 'final_answer',
        });
        return completeResponse('最终答案第一段。\n\n最终答案第二段。');
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '我先检查一下上下文。' },
    { externalScopeId: 'wxid_1', content: '最终答案第一段。\n\n最终答案第二段。' },
  ]);
});

test('WeixinBridgeRuntime delays a sub-500 preview block by one extra interval for long-running turns', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const runtime = makeRuntime({
    previewIntervalMs: 20,
    previewSoftTargetBytes: 1024,
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(_event: any, options: any = {}) {
        await options.onProgress?.({
          text: '短句。',
          outputKind: 'final_answer',
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
        return completeResponse('短句。\n\n后续说明。');
      },
    },
  });

  const completion = runtime.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wxid_1',
    text: 'hello',
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(sent, []);

  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '短句。' },
  ]);

  await completion;

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '短句。' },
    { externalScopeId: 'wxid_1', content: '后续说明。' },
  ]);
});

test('WeixinBridgeRuntime does not wait for the extra small-preview delay once final delivery starts', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const runtime = makeRuntime({
    previewIntervalMs: 120,
    previewSoftTargetBytes: 1024,
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(_event: any, options: any = {}) {
        await options.onProgress?.({
          text: '短句。',
          outputKind: 'final_answer',
        });
        return completeResponse('短句。\n\n完整答复。');
      },
    },
  });

  const outcome = await Promise.race([
    runtime.runOnce().then(() => 'done'),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 60)),
  ]);

  assert.equal(outcome, 'done');
  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '短句。\n\n完整答复。' },
  ]);
});

test('WeixinBridgeRuntime sends the final response when streamed snapshots diverge', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(_event: any, options: any = {}) {
        await options.onProgress?.({
          text: '第一版答案。',
          outputKind: 'final_answer',
        });
        await options.onProgress?.({
          text: '改写后的完整答案。',
          outputKind: 'final_answer',
        });
        return completeResponse('改写后的完整答案。');
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '第一版答案。' },
    { externalScopeId: 'wxid_1', content: '改写后的完整答案。' },
  ]);});

test('WeixinBridgeRuntime stops preview after a failed chunk and resumes final delivery from the successful prefix', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  let activeSends = 0;
  let maxConcurrentSends = 0;
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      activeSends += 1;
      maxConcurrentSends = Math.max(maxConcurrentSends, activeSends);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeSends -= 1;
      sent.push({ externalScopeId, content });
      if (content === '第一段。\n\n第二段。') {
        return {
          success: false,
          deliveredCount: 0,
          deliveredText: '',
          failedIndex: 0,
          failedText: '第一段。\n\n第二段。',
          error: 'ret=-2',
        };
      }
      return {
        success: true,
        deliveredCount: 1,
        deliveredText: content,
        failedIndex: null,
        failedText: '',
        error: '',
      };
    },
    coordinator: {
      async handleInboundEvent(_event: any, options: any = {}) {
        await options.onProgress?.({
          text: '第一段。',
          outputKind: 'final_answer',
        });
        await options.onProgress?.({
          text: '第一段。\n\n第二段。',
          outputKind: 'final_answer',
        });
        return completeResponse('第一段。\n\n第二段。\n\n第三段。');
      },
    },
  });

  await runtime.runOnce();

  assert.equal(maxConcurrentSends, 1);
  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '第一段。' },
    { externalScopeId: 'wxid_1', content: '第二段。\n\n第三段。' },
  ]);});

test('WeixinBridgeRuntime sends a fixed failure message when provider marks the final as partial', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(_event: any, options: any = {}) {
        await options.onProgress?.({
          text: '半截 final。',
          outputKind: 'final_answer',
        });
        return {
          type: 'message',
          messages: [{ text: '' }],
          meta: {
            codexTurn: {
              outputState: 'partial',
              previewText: '半截 final。',
              finalSource: 'progress_only',
            },
          },
        };
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '半截 final。' },
    { externalScopeId: 'wxid_1', content: '本轮回复未完整取回，请重试。' },
  ]);
});

test('WeixinBridgeRuntime sends a fixed failure message when provider marks the final as missing', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent() {
        return {
          type: 'message',
          messages: [{ text: '' }],
          meta: {
            codexTurn: {
              outputState: 'missing',
              previewText: '',
              finalSource: 'none',
            },
          },
        };
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '本轮回复未完整取回，请重试。' },
  ]);
});

test('WeixinBridgeRuntime queues a visible retry notice when final text delivery is rate-limited', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  let sendAttempts = 0;
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sendAttempts += 1;
      if (sendAttempts <= 4) {
        return {
          success: false,
          deliveredCount: 0,
          deliveredText: '',
          failedIndex: 0,
          failedText: content,
          error: '微信消息发送失败（scope=wxid_1, clientId=test）：: -2',
          errorCode: -2,
        };
      }
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(event: any) {
        return completeResponse(event.text === 'hello' ? '第一条最终回复' : '第二条最终回复');
      },
    },
  });

  await runtime.runOnce();
  await runtime.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wxid_1',
    text: 'next',
  });

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '微信发送频率过快（ret: -2），上一条桥接消息可能未送达。请稍后重试，或发送 /retry 重试上一条请求。' },
    { externalScopeId: 'wxid_1', content: '第二条最终回复' },
  ]);
});


test('WeixinBridgeRuntime sends an interrupted message when provider marks the turn as interrupted', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent() {
        return {
          type: 'message',
          messages: [{ text: '' }],
          meta: {
            codexTurn: {
              outputState: 'interrupted',
              previewText: '',
              finalSource: 'none',
            },
          },
        };
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '本轮回复已在 Codex 侧中断。可用：/retry 重试上一条请求，/reconnect 刷新当前会话，/new 新开线程。' },
  ]);
});

test('WeixinBridgeRuntime forwards provider error details to Weixin', async () => {
  const sent = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent() {
        return {
          type: 'message',
          messages: [{ text: '' }],
          meta: {
            codexTurn: {
              outputState: 'provider_error',
              previewText: '',
              finalSource: 'none',
              errorMessage: '401 Unauthorized: refresh_token_reused',
            },
          },
        };
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: 'Codex 错误：401 Unauthorized: refresh_token_reused' },
  ]);
});

test('WeixinBridgeRuntime rewrites exhausted Codex credits into a specific user-facing message', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent() {
        return {
          type: 'message',
          messages: [{ text: '' }],
          meta: {
            codexTurn: {
              outputState: 'provider_error',
              previewText: '',
              finalSource: 'session_runtime_error',
              errorMessage: 'Codex subscription credits are exhausted (premium balance 0).',
            },
          },
        };
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sent, [
    {
      externalScopeId: 'wxid_1',
      content: 'Codex 订阅额度已用完：Codex subscription credits are exhausted (premium balance 0)。请升级套餐或等待额度恢复后重试。',
    },
  ]);
});



test('WeixinBridgeRuntime replies immediately when a second plain-text message arrives during an active scope turn', async () => {
  const sent: Array<{ externalScopeId: string; content: string }> = [];
  const started: string[] = [];
  let releaseFirst: (value?: unknown) => void = () => {};
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    coordinator: {
      async handleInboundEvent(event: any) {
        started.push(event.text);
        if (event.text === 'first') {
          await firstGate;
          return completeResponse('first answer');
        }
        return completeResponse('second answer');
      },
    },
  });

  const first = runtime.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wxid_1',
    text: 'first',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = runtime.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wxid_1',
    text: 'second',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(started, ['first']);
  await second;
  assert.deepEqual(started, ['first']);
  assert.deepEqual(sent, [
    {
      externalScopeId: 'wxid_1',
      content: '当前已有一轮回复在进行中。\n请先等待，或使用 /stop 中断。',
    },
  ]);

  releaseFirst();
  await first;

  assert.deepEqual(started, ['first']);
  assert.deepEqual(sent, [
    {
      externalScopeId: 'wxid_1',
      content: '当前已有一轮回复在进行中。\n请先等待，或使用 /stop 中断。',
    },
    { externalScopeId: 'wxid_1', content: 'first answer' },
  ]);
});

test('WeixinBridgeRuntime throws when provider marks the final complete but returns no final text', async () => {
  const runtime = makeRuntime({
    sendText: async () => {},
    coordinator: {
      async handleInboundEvent() {
        return completeResponse('');
      },
    },
  });

  const zhMsg = createI18n().t('runtime.error.finalTextMissing', { scopeId: 'wxid_1' });
  const enMsg = createI18n('en').t('runtime.error.finalTextMissing', { scopeId: 'wxid_1' });
  try {
    await runtime.runOnce();
    assert.fail('expected runtime to reject');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(
      message.includes(zhMsg) || message.includes(enMsg),
      `Expected missing-final-text message, got: ${message}`,
    );
  }
});


test('WeixinBridgeRuntime sends a timeout message when provider marks the turn as timed out', async () => {
  const sent = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent() {
        return {
          type: 'message',
          messages: [{ text: '' }],
          meta: {
            codexTurn: {
              outputState: 'timeout',
              previewText: '',
              finalSource: 'none',
            },
          },
        };
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '本轮回复等待 Codex 超时，请重试。' },
  ]);
});

test('WeixinBridgeRuntime commits partial preview text instead of sending a generic failure', async () => {
  const sent = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent() {
        return {
          type: 'message',
          messages: [{ text: '当前已整理出的修改摘要。' }],
          meta: {
            codexTurn: {
              outputState: 'partial',
              previewText: '当前已整理出的修改摘要。',
              finalSource: 'commentary_only',
            },
          },
        };
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '当前已整理出的修改摘要。' },
  ]);
});

test('WeixinBridgeRuntime sends a sticky-session recovery message when the bound thread cannot be resumed', async () => {
  const sent = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent() {
        return {
          type: 'message',
          messages: [{ text: '' }],
          meta: {
            codexTurn: {
              outputState: 'stale_session',
              previewText: '',
              finalSource: 'none',
            },
          },
        };
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '当前绑定的 Codex 会话已不可恢复。请使用 /open 重新绑定，或用 /new 新建。' },
  ]);
});


test('WeixinBridgeRuntime runs restart after the queued restart reply is delivered', async () => {
  const sent = [];
  const actions = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async restartBridge() {
        actions.push('restart');
      },
      async handleInboundEvent() {
        return {
          type: 'message',
          messages: [{ text: '桥接重启已排队。' }],
          meta: {
            codexTurn: {
              outputState: 'complete',
              previewText: '',
              finalSource: 'thread_items',
            },
            systemAction: {
              kind: 'restart_bridge',
            },
          },
        };
      },
    },
  });

  await runtime.runOnce();

  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: '桥接重启已排队。' },
  ]);
  assert.deepEqual(actions, ['restart']);
});
