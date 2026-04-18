import assert from 'node:assert/strict';
import test from 'node:test';
import { WeixinBridgeRuntime } from '../../src/runtime/weixin_bridge_runtime.js';

function makeRuntime({
  coordinator,
  sendText,
  sendTyping,
  commitSyncCursor,
  previewSoftTargetBytes = 1,
  previewIntervalMs = 0,
}) {
  return new WeixinBridgeRuntime({
    platformPlugin: {
      async start() {},
      async stop() {},
      async pollOnce() {
        return {
          syncCursor: 'cursor-1',
          events: [{
            platform: 'weixin',
            externalScopeId: 'wxid_1',
            text: 'hello',
          }],
        };
      },
      async commitSyncCursor(syncCursor) {
        await commitSyncCursor?.(syncCursor);
      },
      async sendText(payload) {
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
      async sendTyping(payload) {
        await sendTyping?.(payload);
      },
    },
    bridgeCoordinator: coordinator,
    previewSoftTargetBytes,
    previewIntervalMs,
  });
}

function completeResponse(text) {
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
  const seen = [];
  const sent = [];
  const committed = [];
  const typing = [];
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
      async handleInboundEvent(event, options = {}) {
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

test('WeixinBridgeRuntime dispatches plain-text turns in the background so slash commands can run immediately', async () => {
  const sent = [];
  let releaseTurn;
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(event) {
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

  await runtime.dispatchInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wxid_1',
    text: 'hello',
  });
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

test('WeixinBridgeRuntime suppresses the final send when streamed preview already matches the final content', async () => {
  const sent = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(_event, options = {}) {
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
  ]);});

test('WeixinBridgeRuntime sends only the trailing tail when the final response extends the streamed final text', async () => {
  const sent = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(_event, options = {}) {
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
  ]);});

test('WeixinBridgeRuntime merges commentary and final-answer progress into the preview stream', async () => {
  const sent = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    previewSoftTargetBytes: 1024,
    coordinator: {
      async handleInboundEvent(_event, options = {}) {
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
    { externalScopeId: 'wxid_1', content: '最终答案第一段。\n\n最终答案第二段。' },
  ]);});

test('WeixinBridgeRuntime sends the final response when streamed snapshots diverge', async () => {
  const sent = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(_event, options = {}) {
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
  const sent = [];
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
      async handleInboundEvent(_event, options = {}) {
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
  const sent = [];
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
    },
    coordinator: {
      async handleInboundEvent(_event, options = {}) {
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


test('WeixinBridgeRuntime sends an interrupted message when provider marks the turn as interrupted', async () => {
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
    { externalScopeId: 'wxid_1', content: '本轮回复已在 Codex 侧中断，请重试或继续。' },
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



test('WeixinBridgeRuntime serializes replies per scope so a second message waits for the first delivery to finish', async () => {
  const sent = [];
  const started = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstFinished = false;
  const runtime = makeRuntime({
    sendText: async ({ externalScopeId, content }) => {
      sent.push({ externalScopeId, content });
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    coordinator: {
      async handleInboundEvent(event) {
        started.push(event.text);
        if (event.text === 'first') {
          await firstGate;
          firstFinished = true;
          return completeResponse('first answer');
        }
        assert.equal(firstFinished, true);
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
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(started, ['first', 'second']);
  assert.deepEqual(sent, [
    { externalScopeId: 'wxid_1', content: 'first answer' },
    { externalScopeId: 'wxid_1', content: 'second answer' },
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

  await assert.rejects(runtime.runOnce(), /could not resolve final text/);
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
