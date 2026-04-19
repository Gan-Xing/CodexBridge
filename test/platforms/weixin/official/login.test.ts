import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WeixinAccountStore } from '../../../../src/platforms/weixin/account_store.js';
import { officialQrLogin } from '../../../../src/platforms/weixin/official/login.js';

interface FetchMockStep {
  body?: unknown;
  status?: number;
  error?: Error;
}

function createFetchMock(sequence: FetchMockStep[]) {
  return async (url: string): Promise<Response> => {
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
}

test('officialQrLogin follows confirmed QR flow and persists credentials', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-login-'));
  const accountStore = new WeixinAccountStore({ rootDir: tmpDir });
  accountStore.setContextToken('bot-account', 'wxid_sender', 'stale-ctx');
  const fetchImpl = createFetchMock([
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

  const credentials = await officialQrLogin({
    accountStore,
    accountsDir: tmpDir,
    fetchImpl,
    timeoutSeconds: 1,
    sleep: async () => {},
  });

  assert.equal(credentials?.account_id, 'bot-account');
  assert.equal(accountStore.loadAccount('bot-account')?.token, 'bot-token');
  assert.equal(accountStore.getContextToken('bot-account', 'wxid_sender'), null);
});
