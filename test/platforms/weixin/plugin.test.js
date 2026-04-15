import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WeixinAccountStore } from '../../../src/platforms/weixin/account_store.js';
import { loadWeixinConfig } from '../../../src/platforms/weixin/config.js';
import { WeixinPlatformPlugin } from '../../../src/platforms/weixin/plugin.js';

function makeTempAccountsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-'));
}

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

test('WeixinPlatformPlugin normalizes inbound DM text and persists context token', () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  const plugin = new WeixinPlatformPlugin({
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

  const event = plugin.normalizeInboundEvent({
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

test('WeixinPlatformPlugin enforces DM allowlist when configured', () => {
  const plugin = new WeixinPlatformPlugin({
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

  const blocked = plugin.normalizeInboundEvent({
    from_user_id: 'wxid_blocked',
    to_user_id: 'bot-account',
    msg_type: 0,
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
  });
  const allowed = plugin.normalizeInboundEvent({
    from_user_id: 'wxid_allowed',
    to_user_id: 'bot-account',
    msg_type: 0,
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
  });

  assert.equal(blocked, null);
  assert.equal(allowed?.externalScopeId, 'wxid_allowed');
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

  const plugin = new WeixinPlatformPlugin({
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

test('WeixinPlatformPlugin builds typing payloads when a typing ticket is known', () => {
  const plugin = new WeixinPlatformPlugin({
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

test('WeixinPlatformPlugin pollOnce normalizes incoming messages and persists sync cursor', async () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  const plugin = new WeixinPlatformPlugin({
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
  plugin.client = {
    async getUpdates() {
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
  assert.equal(plugin.typingTickets.get('wxid_sender'), 'typing-1');
  assert.equal(accountStore.loadSyncCursor('bot-account'), 'cursor-2');
  assert.equal(accountStore.getContextToken('bot-account', 'wxid_sender'), 'ctx-2');
});

test('WeixinPlatformPlugin sendText and sendTyping call the underlying iLink client', async () => {
  const rootDir = makeTempAccountsDir();
  const accountStore = new WeixinAccountStore({ rootDir });
  accountStore.setContextToken('bot-account', 'wxid_sender', 'ctx-1');
  const plugin = new WeixinPlatformPlugin({
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
  plugin.client = {
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

  await plugin.sendText({
    externalScopeId: 'wxid_sender',
    content: 'hello from bridge',
  });
  await plugin.sendTyping({
    externalScopeId: 'wxid_sender',
    status: 'stop',
  });

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
