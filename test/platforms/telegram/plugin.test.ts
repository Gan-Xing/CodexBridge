import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramPlatformPlugin } from '../../../src/platforms/telegram/plugin.js';

test('TelegramPlatformPlugin normalizes direct-message text updates', () => {
  const plugin = new TelegramPlatformPlugin();

  const event = plugin.normalizeInboundEvent({
    update_id: 1,
    message: {
      message_id: 99,
      text: 'hello from telegram',
      chat: {
        id: 123456,
        type: 'private',
      },
      from: {
        id: 42,
        username: 'ganxing',
        first_name: 'Gan',
        last_name: 'Xing',
        language_code: 'zh-CN',
      },
    },
  });

  const metadata = event?.metadata as Record<string, any> | undefined;
  assert.equal(event?.platform, 'telegram');
  assert.equal(event?.externalScopeId, '123456');
  assert.equal(event?.text, 'hello from telegram');
  assert.equal(event?.locale, 'zh-CN');
  assert.equal(metadata?.telegram?.messageId, '99');
  assert.equal(metadata?.telegram?.displayName, 'Gan Xing');
});

test('TelegramPlatformPlugin folds forum topic ids into the external scope id', () => {
  const plugin = new TelegramPlatformPlugin();

  const event = plugin.normalizeInboundEvent({
    message: {
      message_id: 100,
      text: 'topic message',
      message_thread_id: 77,
      chat: {
        id: -10012345,
        type: 'supergroup',
      },
      from: {
        id: 9,
      },
    },
  });

  assert.equal(event?.externalScopeId, '-10012345::77');
});

test('TelegramPlatformPlugin builds telegram sendMessage payloads with thread ids', () => {
  const plugin = new TelegramPlatformPlugin();

  const deliveries = plugin.buildTextDeliveries({
    externalScopeId: '-10012345::77',
    content: 'send back to topic',
  });

  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0], {
    kind: 'telegram.sendMessage',
    payload: {
      chat_id: '-10012345',
      message_thread_id: 77,
      text: 'send back to topic',
    },
  });
});

test('TelegramPlatformPlugin sendText uses the injected transport and reports success', async () => {
  const calls: any[] = [];
  const plugin = new TelegramPlatformPlugin({
    client: {
      async sendMessage(params) {
        calls.push(params);
        return {
          ok: true,
          result: {
            message_id: 555,
          },
        };
      },
    },
  });

  const result = await plugin.sendText({
    externalScopeId: '-10012345::77',
    content: 'reply from bridge',
  });

  assert.equal(result.success, true);
  assert.equal(result.deliveredCount, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    chatId: '-10012345',
    messageThreadId: 77,
    text: 'reply from bridge',
  });
});

test('TelegramPlatformPlugin sendTyping sends typing only for start events', async () => {
  const calls: any[] = [];
  const plugin = new TelegramPlatformPlugin({
    client: {
      async sendChatAction(params) {
        calls.push(params);
      },
    },
  });

  await plugin.sendTyping({
    externalScopeId: '123456',
    status: 'start',
  });
  await plugin.sendTyping({
    externalScopeId: '123456',
    status: 'stop',
  });

  assert.deepEqual(calls, [{
    chatId: '123456',
    action: 'typing',
    messageThreadId: null,
  }]);
});
