import assert from 'node:assert/strict';
import test from 'node:test';
import { WeixinBridgeRuntime } from '../../src/runtime/weixin_bridge_runtime.js';

test('WeixinBridgeRuntime forwards poll events into the bridge coordinator and sends the response', async () => {
  const seen = [];
  const sent = [];
  const committed = [];
  const runtime = new WeixinBridgeRuntime({
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
        committed.push(syncCursor);
      },
      async sendText({ externalScopeId, content }) {
        sent.push({ externalScopeId, content });
      },
    },
    bridgeCoordinator: {
      async handleInboundEvent(event) {
        seen.push(event.text);
        return {
          type: 'message',
          messages: [
            { text: 'line 1' },
            { text: 'line 2' },
          ],
        };
      },
    },
  });

  const result = await runtime.runOnce();

  assert.equal(result.events.length, 1);
  assert.deepEqual(seen, ['hello']);
  assert.deepEqual(sent, [{
    externalScopeId: 'wxid_1',
    content: 'line 1\n\nline 2',
  }]);
  assert.deepEqual(committed, ['cursor-1']);
});

test('WeixinBridgeRuntime sends a fallback message when the bridge response is blank', async () => {
  const sent = [];
  const runtime = new WeixinBridgeRuntime({
    platformPlugin: {
      async start() {},
      async stop() {},
      async sendText(payload) {
        sent.push(payload);
      },
    },
    bridgeCoordinator: {
      async handleInboundEvent() {
        return {
          type: 'message',
          messages: [{ text: '   ' }],
        };
      },
    },
  });

  await runtime.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wxid_1',
    text: 'hello',
  });

  assert.match(sent[0]?.content ?? '', /without a plain-text reply/i);
});
