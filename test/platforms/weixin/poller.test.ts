import assert from 'node:assert/strict';
import test from 'node:test';
import { WeixinPoller } from '../../../src/platforms/weixin/poller.js';

test('WeixinPoller forwards normalized events and stops cleanly', async () => {
  const seen = [];
  const committed = [];
  const pollSyncCursors = [];
  let pollCount = 0;
  const poller = new WeixinPoller({
    plugin: {
      loadSyncCursor() {
        return 'cursor-0';
      },
      async pollOnce({ syncCursor }) {
        pollSyncCursors.push(syncCursor);
        pollCount += 1;
        if (pollCount === 1) {
          return {
            syncCursor: 'cursor-1',
            events: [{ text: 'hello', platform: 'weixin', externalScopeId: 'wxid_1' }],
          };
        }
        poller.stop();
        return { syncCursor: 'cursor-2', events: [] };
      },
      async commitSyncCursor(syncCursor) {
        committed.push(syncCursor);
      },
    },
    onEvent: async (event: any) => {
      seen.push(event.text);
    },
    sleep: async () => {},
  } as any);

  await poller.start();

  assert.deepEqual(seen, ['hello']);
  assert.equal(pollCount, 2);
  assert.deepEqual(pollSyncCursors, ['cursor-0', 'cursor-1']);
  assert.deepEqual(committed, ['cursor-1', 'cursor-2']);
});

test('WeixinPoller backs off through onError when pollOnce throws', async () => {
  const errors = [];
  const committed = [];
  let pollCount = 0;
  const poller = new WeixinPoller({
    plugin: {
      async pollOnce() {
        pollCount += 1;
        if (pollCount === 1) {
          throw new Error('boom');
        }
        poller.stop();
        return { syncCursor: 'cursor-2', events: [] };
      },
      async commitSyncCursor(syncCursor) {
        committed.push(syncCursor);
      },
    },
    onError: async (error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
    sleep: async () => {},
  } as any);

  await poller.start();

  assert.deepEqual(errors, ['boom']);
  assert.equal(pollCount, 2);
  assert.deepEqual(committed, ['cursor-2']);
});

test('WeixinPoller commits the sync cursor before background completion settles', async () => {
  const committed = [];
  const pollSyncCursors = [];
  let releaseFirst: (value?: unknown) => void = () => {};
  const firstCompletion: Promise<void> = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let pollCount = 0;
  const poller = new WeixinPoller({
    plugin: {
      loadSyncCursor() {
        return 'cursor-0';
      },
      async pollOnce({ syncCursor }) {
        pollSyncCursors.push(syncCursor);
        pollCount += 1;
        if (pollCount === 1) {
          return {
            syncCursor: 'cursor-1',
            events: [{ text: 'hello', platform: 'weixin', externalScopeId: 'wxid_1' }],
          };
        }
        poller.stop();
        return {
          syncCursor: 'cursor-2',
          events: [],
        };
      },
      async commitSyncCursor(syncCursor) {
        committed.push(syncCursor);
      },
    },
    onEvent: async () => ({
      type: 'scheduled',
      completion: firstCompletion,
    }),
    sleep: async () => {},
  } as any);

  const run = poller.start();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  assert.ok(committed.includes('cursor-1'));

  releaseFirst();
  await run;

  assert.deepEqual(pollSyncCursors, ['cursor-0', 'cursor-1']);
  assert.deepEqual(committed, ['cursor-1', 'cursor-2']);
});

test('WeixinPoller still commits the sync cursor when background completion fails', async () => {
  const errors = [];
  const committed = [];
  let pollCount = 0;
  const poller = new WeixinPoller({
    plugin: {
      loadSyncCursor() {
        return 'cursor-0';
      },
      async pollOnce() {
        pollCount += 1;
        poller.stop();
        return {
          syncCursor: 'cursor-1',
          events: [{ text: 'hello', platform: 'weixin', externalScopeId: 'wxid_1' }],
        };
      },
      async commitSyncCursor(syncCursor) {
        committed.push(syncCursor);
      },
    },
    onEvent: async () => ({
      type: 'scheduled',
      completion: Promise.reject(new Error('handle failed')) as Promise<void>,
    }),
    onError: async (error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
    sleep: async () => {},
  } as any);

  await poller.start();

  assert.equal(pollCount, 1);
  assert.deepEqual(committed, ['cursor-1']);
  assert.deepEqual(errors, ['handle failed']);
});

test('WeixinPoller keeps only the latest /restart command per scope within one poll batch', async () => {
  const seen = [];
  const poller = new WeixinPoller({
    plugin: {
      async pollOnce() {
        poller.stop();
        return {
          syncCursor: 'cursor-1',
          events: [
            {
              text: '/restart',
              platform: 'weixin',
              externalScopeId: 'wxid_1',
              metadata: { weixin: { messageId: '100' } },
            },
            {
              text: '/restart',
              platform: 'weixin',
              externalScopeId: 'wxid_1',
              metadata: { weixin: { messageId: '101' } },
            },
            {
              text: '/status',
              platform: 'weixin',
              externalScopeId: 'wxid_1',
              metadata: { weixin: { messageId: '102' } },
            },
          ],
        };
      },
      async commitSyncCursor() {},
    },
    onEvent: async (event: any) => {
      seen.push(`${event.text}:${event.metadata?.weixin?.messageId ?? ''}`);
    },
    sleep: async () => {},
  } as any);

  await poller.start();

  assert.deepEqual(seen, ['/restart:101', '/status:102']);
});
