import assert from 'node:assert/strict';
import test from 'node:test';
import { WeixinIlinkClient, qrLogin } from '../../../src/platforms/weixin/client.js';
import { WeixinAccountStore } from '../../../src/platforms/weixin/account_store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface FetchMockStep {
  body?: unknown;
  ok?: boolean;
  status?: number;
  error?: Error;
}

function createFetchMock(sequence: FetchMockStep[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url, init });
    const next = sequence.shift();
    if (!next) {
      throw new Error(`Unexpected fetch call: ${url}`);
    }
    if (next.error) {
      throw next.error;
    }
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

test('WeixinIlinkClient.getUpdates posts iLink payload with authorization', async () => {
  const { fetchImpl, calls } = createFetchMock([{
    body: {
      ret: 0,
      msgs: [],
      get_updates_buf: 'next-cursor',
    },
  }]);
  const client = new WeixinIlinkClient({
    baseUrl: 'https://ilink.example.com',
    token: 'bot-token',
    fetchImpl,
  });

  const response = await client.getUpdates({ syncCursor: 'cursor-1', timeoutMs: 1234 });

  assert.equal(response.get_updates_buf, 'next-cursor');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ilink.example.com/ilink/bot/getupdates');
  assert.equal(calls[0].init.method, 'POST');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.match(headers.Authorization, /^Bearer bot-token$/);
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.get_updates_buf, 'cursor-1');
  assert.equal(body.base_info.channel_version, '2.2.0');
});

test('WeixinIlinkClient.sendMessage and getConfig use Hermes-compatible payload fields', async () => {
  const { fetchImpl, calls } = createFetchMock([
    { body: { ret: 0 } },
    { body: { typing_ticket: 'typing-1' } },
  ]);
  const client = new WeixinIlinkClient({
    baseUrl: 'https://ilink.example.com',
    token: 'bot-token',
    fetchImpl,
  });

  await client.sendMessage({
    toUserId: 'wxid_sender',
    text: 'hello',
    contextToken: 'ctx-1',
    clientId: 'client-1',
  });
  const config = await client.getConfig({
    userId: 'wxid_sender',
    contextToken: 'ctx-1',
  });

  assert.equal((config as { typing_ticket?: string }).typing_ticket, 'typing-1');
  const sendBody = JSON.parse(String(calls[0].init.body));
  assert.equal(sendBody.msg.to_user_id, 'wxid_sender');
  assert.equal(sendBody.msg.context_token, 'ctx-1');
  assert.equal(sendBody.msg.item_list[0].text_item.text, 'hello');

  const configBody = JSON.parse(String(calls[1].init.body));
  assert.equal(configBody.ilink_user_id, 'wxid_sender');
  assert.equal(configBody.context_token, 'ctx-1');
});

test('qrLogin follows confirmed QR flow and persists credentials', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-client-'));
  const accountStore = new WeixinAccountStore({ rootDir: tmpDir });
  const { fetchImpl } = createFetchMock([
    { body: { qrcode: 'qr-1', qrcode_img_content: 'https://qr.example.com' } },
    {
      body: {
        status: 'confirmed',
        ilink_bot_id: 'bot-account',
        bot_token: 'bot-token',
        baseurl: 'https://ilink.example.com',
        ilink_user_id: 'wx-user',
      },
    },
  ]);
  const client = new WeixinIlinkClient({
    baseUrl: 'https://ilink.example.com',
    fetchImpl,
  });

  const credentials = await qrLogin({
    client,
    accountStore,
    timeoutSeconds: 1,
    sleep: async () => {},
  });

  assert.equal(credentials?.account_id, 'bot-account');
  assert.equal(accountStore.loadAccount('bot-account')?.token, 'bot-token');
});
