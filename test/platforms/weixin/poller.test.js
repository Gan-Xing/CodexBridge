import assert from 'node:assert/strict';
import test from 'node:test';
import { WeixinPoller } from '../../../src/platforms/weixin/poller.js';

test('WeixinPoller forwards normalized events and stops cleanly', async () => {
  const seen = [];
  let pollCount = 0;
  const poller = new WeixinPoller({
    plugin: {
      async pollOnce() {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            events: [{ text: 'hello', platform: 'weixin', externalScopeId: 'wxid_1' }],
          };
        }
        poller.stop();
        return { events: [] };
      },
    },
    onEvent: async (event) => {
      seen.push(event.text);
    },
    sleep: async () => {},
  });

  await poller.start();

  assert.deepEqual(seen, ['hello']);
  assert.equal(pollCount, 2);
});

test('WeixinPoller backs off through onError when pollOnce throws', async () => {
  const errors = [];
  let pollCount = 0;
  const poller = new WeixinPoller({
    plugin: {
      async pollOnce() {
        pollCount += 1;
        if (pollCount === 1) {
          throw new Error('boom');
        }
        poller.stop();
        return { events: [] };
      },
    },
    onError: async (error) => {
      errors.push(error.message);
    },
    sleep: async () => {},
  });

  await poller.start();

  assert.deepEqual(errors, ['boom']);
  assert.equal(pollCount, 2);
});
