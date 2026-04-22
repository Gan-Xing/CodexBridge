import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WeixinAccountStore } from '../../../src/platforms/weixin/account_store.js';
import { loadWeixinConfig } from '../../../src/platforms/weixin/config.js';
import { _resetContextTokenStoreForTest } from '../../../src/platforms/weixin/official/context_tokens.js';
import { _resetSessionGuardForTest } from '../../../src/platforms/weixin/official/session_guard.js';
import { WeixinPlatformPlugin } from '../../../src/platforms/weixin/plugin.js';

function makeTempAccountsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-'));
}

function makePlugin(options: any) {
  return new WeixinPlatformPlugin({
    chunkIntervalMs: 0,
    ...options,
  } as any);
}

test.beforeEach(() => {
  _resetContextTokenStoreForTest();
  _resetSessionGuardForTest();
});

test('loadWeixinConfig restores token and base URL from saved account state', () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  accountStore.saveAccount({
    accountId: 'wx-account-1',
    token: 'saved-token',
    baseUrl: 'https://ilink.example.com',
    userId: 'wx-user',
  });

  const config = loadWeixinConfig({
    env: {
      WEIXIN_ACCOUNT_ID: 'wx-account-1',
      WEIXIN_ALLOWED_USERS: 'wxid_a,wxid_b',
    },
    accountStore,
    stateDir: path.dirname(path.dirname(rootDir)),
  });

  assert.equal(config.accountId, 'wx-account-1');
  assert.equal(config.token, 'saved-token');
  assert.equal(config.baseUrl, 'https://ilink.example.com');
  assert.deepEqual(config.allowFrom, ['wxid_a', 'wxid_b']);
});

test('WeixinPlatformPlugin normalizes inbound DM text and persists context token', async () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  const plugin = makePlugin({
    accountStore,
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });

  const event = await plugin.normalizeInboundEvent({
    from_user_id: 'wxid_sender',
    to_user_id: 'bot-account',
    msg_type: 0,
    message_id: 'msg-1',
    context_token: 'ctx-1',
    item_list: [{
      type: 1,
      text_item: { text: 'hello from wechat' },
    }],
  });

  assert.equal(event?.platform, 'weixin');
  assert.equal(event?.externalScopeId, 'wxid_sender');
  assert.equal(event?.text, 'hello from wechat');
  assert.equal(accountStore.getContextToken('bot-account', 'wxid_sender'), 'ctx-1');
});

test('WeixinPlatformPlugin normalizes inbound group text and persists context token for group scope', async () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  const plugin = makePlugin({
    accountStore,
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'open',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });

  const event = await plugin.normalizeInboundEvent({
    from_user_id: 'wxid_sender',
    to_user_id: 'wxid_bot',
    room_id: 'wxid_group',
    msg_type: 1,
    message_id: 'msg-group-1',
    context_token: 'ctx-group',
    item_list: [{
      type: 1,
      text_item: { text: 'group hello' },
    }],
  });

  assert.equal(event?.platform, 'weixin');
  assert.equal(event?.externalScopeId, 'wxid_group');
  assert.equal(event?.text, 'group hello');
  assert.equal(accountStore.getContextToken('bot-account', 'wxid_group'), 'ctx-group');
  assert.equal(accountStore.getContextToken('bot-account', 'wxid_sender'), 'ctx-group');
});

test('WeixinPlatformPlugin enforces DM allowlist when configured', async () => {
  const plugin = makePlugin({
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'allowlist',
      groupPolicy: 'disabled',
      allowFrom: ['wxid_allowed'],
      groupAllowFrom: [],
      stateDir: '/tmp',
      accountsDir: '/tmp',
      maxMessageLength: 4000,
    },
    accountStore: new WeixinAccountStore({ rootDir: makeTempAccountsDir() }),
  });

  const blocked = await plugin.normalizeInboundEvent({
    from_user_id: 'wxid_blocked',
    to_user_id: 'bot-account',
    msg_type: 0,
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
  });
  const allowed = await plugin.normalizeInboundEvent({
    from_user_id: 'wxid_allowed',
    to_user_id: 'bot-account',
    msg_type: 0,
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
  });

  assert.equal(blocked, null);
  assert.equal(allowed?.externalScopeId, 'wxid_allowed');
});

test('WeixinPlatformPlugin downloads inbound image messages into local attachments', async () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  const plugin = makePlugin({
    accountStore,
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input) !== 'https://cdn.example.com/image.png') {
      throw new Error(`unexpected media url: ${String(input)}`);
    }
    return new Response(Buffer.from('fake-image-content'), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
  }) as typeof globalThis.fetch;

  try {
    const event = await plugin.normalizeInboundEvent({
      from_user_id: 'wxid_sender',
      to_user_id: 'bot-account',
      msg_type: 0,
      message_id: 'msg-media-1',
      item_list: [{
        type: 2,
        image_item: {
          media: {
            full_url: 'https://cdn.example.com/image.png',
          },
        },
      }],
    });

    assert.equal(event?.externalScopeId, 'wxid_sender');
    assert.equal(event?.text, '');
    assert.equal(event?.attachments?.length, 1);
    assert.equal(event?.attachments?.[0]?.kind, 'image');
    assert.equal(fs.existsSync(String(event?.attachments?.[0]?.localPath ?? '')), true);
    assert.equal(event?.metadata?.weixin?.attachmentCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WeixinPlatformPlugin builds outbound text payloads with stored context token and chunking', () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  accountStore.saveAccount({
    accountId: 'bot-account',
    token: 'token',
    baseUrl: 'https://ilinkai.weixin.qq.com',
  });
  accountStore.setContextToken('bot-account', 'wxid_sender', 'ctx-1');

  const plugin = makePlugin({
    accountStore,
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 20,
    },
  });

  const deliveries = plugin.buildTextDeliveries({
    externalScopeId: 'wxid_sender',
    content: '# Title\n\n12345678901234567890\n\nTail',
  });

  assert.equal(deliveries.length, 3);
  assert.equal(deliveries[0]?.kind, 'weixin.sendmessage');
  assert.equal(deliveries[0]?.payload.msg.to_user_id, 'wxid_sender');
  assert.equal(deliveries[0]?.payload.msg.context_token, 'ctx-1');
  assert.ok(deliveries.some((delivery) => /【Title】/.test(delivery.payload.msg.item_list[0].text_item.text)));
});



test('WeixinPlatformPlugin aggregates short lines into delivery chunks under the 2048-byte Weixin limit', () => {
  const plugin = makePlugin({
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: '/tmp',
      accountsDir: '/tmp',
      maxMessageLength: 4000,
    },
    accountStore: new WeixinAccountStore({ rootDir: makeTempAccountsDir() }),
  });

  const deliveries = plugin.buildTextDeliveries({
    externalScopeId: 'wxid_sender',
    content: '第一句。\n第二句。\n第三句。\n第四句。\n第五句。',
  });

  assert.equal(deliveries.length, 1);
  const deliveredText = deliveries[0]?.payload.msg.item_list[0].text_item.text;
  assert.equal(deliveredText, '第一句。\n第二句。\n第三句。\n第四句。\n第五句。');
  assert.ok(Buffer.byteLength(deliveredText, 'utf8') < 2048);
});

test('WeixinPlatformPlugin builds typing payloads when a typing ticket is known', () => {
  const plugin = makePlugin({
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: '/tmp',
      accountsDir: '/tmp',
      maxMessageLength: 4000,
    },
    accountStore: new WeixinAccountStore({ rootDir: makeTempAccountsDir() }),
  });

  assert.equal(plugin.buildTypingDelivery({ externalScopeId: 'wxid_sender' }), null);
  plugin.recordTypingTicket('wxid_sender', 'ticket-1');

  const payload = plugin.buildTypingDelivery({
    externalScopeId: 'wxid_sender',
    status: 'stop',
  });

  assert.equal(payload?.kind, 'weixin.sendtyping');
  assert.deepEqual(payload?.payload, {
    ilink_user_id: 'wxid_sender',
    typing_ticket: 'ticket-1',
    status: 2,
  });
});

test('WeixinPlatformPlugin pollOnce normalizes incoming messages and defers sync cursor persistence', async () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  const plugin = makePlugin({
    accountStore,
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });
  (plugin as any).client = {
    async getUpdates({ syncCursor }) {
      assert.equal(syncCursor, '');
      return {
        get_updates_buf: 'cursor-2',
        msgs: [{
          from_user_id: 'wxid_sender',
          to_user_id: 'bot-account',
          msg_type: 0,
          context_token: 'ctx-2',
          item_list: [{ type: 1, text_item: { text: 'hello' } }],
        }],
      };
    },
    async getConfig() {
      return { typing_ticket: 'typing-1' };
    },
  };

  const result = await plugin.pollOnce();

  assert.equal(result.syncCursor, 'cursor-2');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.text, 'hello');
  assert.equal((plugin as any).typingTickets.get('wxid_sender'), 'typing-1');
  assert.equal(plugin.loadSyncCursor(), '');
  await plugin.commitSyncCursor(result.syncCursor);
  assert.equal(accountStore.loadSyncCursor('bot-account'), 'cursor-2');
  assert.equal(accountStore.getContextToken('bot-account', 'wxid_sender'), 'ctx-2');
});

test('WeixinPlatformPlugin pollOnce keeps events when typing ticket refresh fails', async () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  const plugin = makePlugin({
    accountStore,
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });
  (plugin as any).client = {
    async getUpdates() {
      return {
        get_updates_buf: 'cursor-2',
        msgs: [{
          from_user_id: 'wxid_sender',
          to_user_id: 'bot-account',
          msg_type: 0,
          item_list: [{ type: 1, text_item: { text: 'hello' } }],
        }],
      };
    },
    async getConfig() {
      throw new Error('typing unavailable');
    },
  };

  const result = await plugin.pollOnce();

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.text, 'hello');
  assert.equal((plugin as any).typingTickets.size, 0);
});

test('WeixinPlatformPlugin caches typing config through the official-compatible config manager', async () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  const plugin = makePlugin({
    accountStore,
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });

  let getConfigCalls = 0;
  (plugin as any).client = {
    async getConfig() {
      getConfigCalls += 1;
      return { typing_ticket: 'typing-1' };
    },
  };

  const first = await plugin.ensureTypingTicket('wxid_sender');
  const second = await plugin.ensureTypingTicket('wxid_sender');

  assert.equal(first, 'typing-1');
  assert.equal(second, 'typing-1');
  assert.equal(getConfigCalls, 1);
});

test('WeixinPlatformPlugin preserves numeric message ids and drops duplicate batch messages', async () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  const plugin = makePlugin({
    accountStore,
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });
  (plugin as any).client = {
    async getUpdates() {
      return {
        get_updates_buf: 'cursor-2',
        msgs: [
          {
            message_id: 7451375762940365000n,
            from_user_id: 'wxid_sender',
            to_user_id: 'bot-account',
            msg_type: 0,
            context_token: 'ctx-2',
            item_list: [{ type: 1, text_item: { text: '/restart' } }],
          },
          {
            message_id: 7451375762940365000n,
            from_user_id: 'wxid_sender',
            to_user_id: 'bot-account',
            msg_type: 0,
            context_token: 'ctx-2',
            item_list: [{ type: 1, text_item: { text: '/restart' } }],
          },
        ],
      };
    },
    async getConfig() {
      return { typing_ticket: 'typing-1' };
    },
  };

  const result = await plugin.pollOnce();

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.metadata?.weixin?.messageId, '7451375762940365000');
  assert.equal(result.events[0]?.text, '/restart');
});

test('WeixinPlatformPlugin sendText and sendTyping call the underlying iLink client', async () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  accountStore.setContextToken('bot-account', 'wxid_sender', 'ctx-1');
  const plugin = makePlugin({
    accountStore,
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });
  const sentMessages = [];
  const sentTyping = [];
  (plugin as any).client = {
    async sendMessage(payload) {
      sentMessages.push(payload);
      return { ret: 0 };
    },
    async sendTyping(payload) {
      sentTyping.push(payload);
      return { ret: 0 };
    },
  };
  plugin.recordTypingTicket('wxid_sender', 'typing-1');

  const delivery = await plugin.sendText({
    externalScopeId: 'wxid_sender',
    content: 'hello from bridge',
  });
  await plugin.sendTyping({
    externalScopeId: 'wxid_sender',
    status: 'stop',
  });

  assert.equal(delivery.success, true);
  assert.equal(delivery.deliveredText, 'hello from bridge');
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]?.toUserId, 'wxid_sender');
  assert.equal(sentMessages[0]?.contextToken, 'ctx-1');
  assert.equal(sentMessages[0]?.text, 'hello from bridge');
  assert.deepEqual(sentTyping[0], {
    toUserId: 'wxid_sender',
    typingTicket: 'typing-1',
    status: 2,
  });
});

test('WeixinPlatformPlugin sendMedia calls the underlying official transport and preserves caption/context', async () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  accountStore.setContextToken('bot-account', 'wxid_sender', 'ctx-1');
  const plugin = makePlugin({
    accountStore,
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });
  const sentMedia = [];
  (plugin as any).client = {
    async sendMediaFile(payload) {
      sentMedia.push(payload);
      return { messageId: 'media-1' };
    },
  };

  const result = await plugin.sendMedia({
    externalScopeId: 'wxid_sender',
    filePath: '/tmp/example.png',
    caption: '截图说明',
  });

  assert.equal(result.success, true);
  assert.equal(result.messageId, 'media-1');
  assert.deepEqual(sentMedia, [{
    filePath: '/tmp/example.png',
    toUserId: 'wxid_sender',
    text: '截图说明',
    contextToken: 'ctx-1',
    cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
  }]);
});

test('WeixinPlatformPlugin sendMedia returns a clear error when context token is missing', async () => {
  const rootDir = makeTempAccountsDir();
  const plugin = makePlugin({
    accountStore: new WeixinAccountStore({ rootDir }),
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });
  let sentCount = 0;
  (plugin as any).client = {
    async sendMediaFile() {
      sentCount += 1;
      return { messageId: 'media-1' };
    },
  };

  const result = await plugin.sendMedia({
    externalScopeId: 'wxid_sender',
    filePath: '/tmp/example.png',
  });

  assert.equal(result.success, false);
  assert.equal(result.messageId, null);
  assert.match(result.error, /context token/i);
  assert.equal(sentCount, 0);
});

test('WeixinPlatformPlugin sendMedia does not blindly retry failed media sends', async () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  accountStore.setContextToken('bot-account', 'wxid_sender', 'ctx-1');
  const plugin = makePlugin({
    accountStore,
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });
  let attempts = 0;
  (plugin as any).client = {
    async sendMediaFile() {
      attempts += 1;
      throw new Error('sendMediaItems: 5001');
    },
  };

  const result = await plugin.sendMedia({
    externalScopeId: 'wxid_sender',
    filePath: '/tmp/example.png',
    caption: '截图说明',
  });

  assert.equal(result.success, false);
  assert.equal(result.messageId, null);
  assert.equal(attempts, 1);
  assert.match(result.error, /5001/);
  assert.equal(result.errorCode, 5001);
});

test('WeixinPlatformPlugin sendMedia keeps media success when caption delivery fails after media send', async () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  accountStore.setContextToken('bot-account', 'wxid_sender', 'ctx-1');
  const plugin = makePlugin({
    accountStore,
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });
  (plugin as any).client = {
    async sendMediaFile() {
      return {
        messageId: 'media-1',
        captionMessageId: null,
        captionError: 'sendMessageWeixin: 5002',
        captionErrorCode: 5002,
      };
    },
  };

  const result = await plugin.sendMedia({
    externalScopeId: 'wxid_sender',
    filePath: '/tmp/example.png',
    caption: '截图说明',
  });

  assert.equal(result.success, true);
  assert.equal(result.messageId, 'media-1');
  assert.equal(result.sentCaption, '');
  assert.match(result.error, /5002/);
});

test('WeixinPlatformPlugin sendMedia pauses the session when caption delivery reports session expiry', async () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  accountStore.setContextToken('bot-account', 'wxid_sender', 'ctx-1');
  const plugin = makePlugin({
    accountStore,
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });
  (plugin as any).client = {
    async sendMediaFile() {
      return {
        messageId: 'media-1',
        captionMessageId: null,
        captionError: 'sendMessageWeixin: -14',
        captionErrorCode: -14,
      };
    },
  };

  const result = await plugin.sendMedia({
    externalScopeId: 'wxid_sender',
    filePath: '/tmp/example.png',
    caption: '截图说明',
  });

  assert.equal(result.success, true);
  assert.equal(result.messageId, 'media-1');
  assert.equal((plugin.getStatus().data as Record<string, unknown> | null)?.sessionPaused, true);
});

test('WeixinPlatformPlugin sendMedia rejects results without a message id', async () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  accountStore.setContextToken('bot-account', 'wxid_sender', 'ctx-1');
  const plugin = makePlugin({
    accountStore,
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });
  (plugin as any).client = {
    async sendMediaFile() {
      return {
        messageId: '',
        captionMessageId: null,
        captionError: null,
        captionErrorCode: null,
      };
    },
  };

  const result = await plugin.sendMedia({
    externalScopeId: 'wxid_sender',
    filePath: '/tmp/example.png',
    caption: '截图说明',
  });

  assert.equal(result.success, false);
  assert.equal(result.messageId, null);
  assert.match(result.error, /no messageId/i);
});


test('WeixinPlatformPlugin sendText returns a structured failure when iLink sendmessage keeps returning a non-zero ret code', async () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  const plugin = makePlugin({
    accountStore,
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });
  let attempts = 0;
  (plugin as any).client = {
    async sendMessage() {
      attempts += 1;
      return { ret: -2 };
    },
  };

  const result = await plugin.sendText({
    externalScopeId: 'wxid_sender',
    content: 'hello from bridge',
  });

  assert.equal(result.success, false);
  assert.equal(result.deliveredCount, 0);
  assert.equal(result.failedIndex, 0);
  assert.equal(result.failedText, 'hello from bridge');
  assert.match(result.error, /-2/);
  assert.equal(result.errorCode, -2);
  assert.equal(attempts, 4);
});

test('WeixinPlatformPlugin pauses polling after session expired and skips the next network poll', async () => {
  const rootDir = makeTempAccountsDir();
  const waits: number[] = [];
  const plugin = makePlugin({
    sleepImpl: async (ms: number) => {
      waits.push(ms);
    },
    accountStore: new WeixinAccountStore({ rootDir }),
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });
  let attempts = 0;
  (plugin as any).client = {
    async getUpdates() {
      attempts += 1;
      return attempts === 1
        ? { ret: -14, errcode: -14, errmsg: 'session expired' }
        : { ret: 0, msgs: [], get_updates_buf: 'cursor-2' };
    },
  };

  const first = await plugin.pollOnce();
  const second = await plugin.pollOnce();

  assert.equal(first.events.length, 0);
  assert.equal(second.events.length, 0);
  assert.equal(attempts, 1);
  assert.equal(waits.length, 1);
  assert.equal(waits[0], 5000);
});

test('WeixinPlatformPlugin sendText fails fast while the session is paused', async () => {
  const rootDir = makeTempAccountsDir();
  const plugin = makePlugin({
    accountStore: new WeixinAccountStore({ rootDir }),
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });
  let attempts = 0;
  (plugin as any).client = {
    async sendMessage() {
      attempts += 1;
      return { ret: -14, errcode: -14 };
    },
  };
  const pausedTrigger = await plugin.sendText({
    externalScopeId: 'wxid_sender',
    content: 'hello from bridge',
  });
  assert.equal(pausedTrigger.success, false);
  assert.match(pausedTrigger.error, /-14|session paused/i);
  const secondResult = await plugin.sendText({
    externalScopeId: 'wxid_sender',
    content: 'hello again',
  });

  assert.equal(secondResult.success, false);
  assert.match(secondResult.error, /session paused/i);
  assert.equal(attempts, 1);
});

test('WeixinPlatformPlugin sends the first message immediately and gates later sends through the same interval', async () => {
  const rootDir = makeTempAccountsDir();
  let now = 1_000;
  const waits: number[] = [];
  const sentAt: number[] = [];
  const plugin = makePlugin({
    chunkIntervalMs: 3000,
    nowFn: () => now,
    sleepImpl: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
    accountStore: new WeixinAccountStore({ rootDir }),
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 10,
    },
  });
  (plugin as any).client = {
    async sendMessage() {
      sentAt.push(now);
      return { ret: 0 };
    },
  };

  await plugin.sendText({
    externalScopeId: 'wxid_sender',
    content: '1234567890\n\nabcdef',
  });

  assert.deepEqual(waits, [3000]);
  assert.deepEqual(sentAt, [1000, 4000]);
});

test('WeixinPlatformPlugin retries failed sends through the same global interval gate', async () => {
  const rootDir = makeTempAccountsDir();
  let now = 5_000;
  const waits: number[] = [];
  const sentAt: number[] = [];
  let attempts = 0;
  const plugin = makePlugin({
    chunkIntervalMs: 3000,
    nowFn: () => now,
    sleepImpl: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
    accountStore: new WeixinAccountStore({ rootDir }),
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });
  (plugin as any).client = {
    async sendMessage() {
      attempts += 1;
      sentAt.push(now);
      return { ret: attempts < 3 ? -2 : 0 };
    },
  };

  const result = await plugin.sendText({
    externalScopeId: 'wxid_sender',
    content: 'hello from bridge',
  });

  assert.equal(result.success, true);
  assert.deepEqual(waits, [3000, 3000]);
  assert.deepEqual(sentAt, [5000, 8000, 11000]);
});

test('WeixinPlatformPlugin keeps fenced code blocks intact when splitting long text deliveries', () => {
  const rootDir = makeTempAccountsDir();
  const plugin = makePlugin({
    accountStore: new WeixinAccountStore({ rootDir }),
    config: {
      enabled: true,
      accountId: 'bot-account',
      token: 'token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      stateDir: path.dirname(path.dirname(rootDir)),
      accountsDir: rootDir,
      maxMessageLength: 4000,
    },
  });

  const deliveries = plugin.buildTextDeliveries({
    externalScopeId: 'wxid_sender',
    content: [
      '前言。',
      '',
      '```bash',
      'pnpm cmc -- mission create \\',
      '  --mission-id asp-phase1-core \\',
      '  --project agent-social-publisher \\',
      '  --cwd /home/ubuntu/dev/agent-social-publisher',
      '```',
      '',
      '收尾。',
    ].join('\n'),
  });

  const texts = deliveries.map((entry) => entry.payload.msg.item_list[0].text_item.text);
  assert.equal(texts.length, 1);
  const codeBlockChunk = texts[0];
  assert.match(codeBlockChunk, /```bash/);
  assert.match(codeBlockChunk, /--project agent-social-publisher/);
  assert.match(codeBlockChunk, /```/);
});
