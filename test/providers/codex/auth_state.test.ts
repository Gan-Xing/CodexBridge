import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  readCodexAccountIdentity,
  resolveCodexAuthPath,
  writeCodexAuthFile,
} from '../../../src/providers/codex/auth_state.js';

function makeJwt(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

test('resolveCodexAuthPath respects CODEX_HOME', () => {
  const result = resolveCodexAuthPath({
    CODEX_HOME: '/tmp/codex-home-test',
  } as NodeJS.ProcessEnv);

  assert.equal(result, path.join(path.resolve('/tmp/codex-home-test'), 'auth.json'));
});

test('readCodexAccountIdentity parses identity from auth.json token payloads', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-state-'));
  const authPath = path.join(tempDir, 'auth.json');
  const idToken = makeJwt({
    email: 'bridge@example.com',
    name: 'Bridge User',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc_bridge',
      chatgpt_plan_type: 'pro',
    },
  });
  const accessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  await writeCodexAuthFile({
    authPath,
    accessToken,
    refreshToken: 'refresh-1',
    idToken,
    accountId: 'acc_bridge',
    email: 'bridge@example.com',
    now: Date.parse('2026-04-22T00:00:00.000Z'),
  });

  const identity = readCodexAccountIdentity(authPath);
  assert.deepEqual(identity, {
    email: 'bridge@example.com',
    name: 'Bridge User',
    authMode: 'chatgpt',
    accountId: 'acc_bridge',
    plan: 'pro',
    authPath,
  });
});

test('readCodexAccountIdentity prefers chatgpt_account_id from tokens over raw auth.json account_id', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-state-priority-'));
  const authPath = path.join(tempDir, 'auth.json');
  const idToken = makeJwt({
    email: 'priority@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc_token',
      chatgpt_plan_type: 'plus',
    },
  });
  const accessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc_token',
    },
  });

  await writeCodexAuthFile({
    authPath,
    accessToken,
    refreshToken: 'refresh-priority',
    idToken,
    accountId: 'acc_raw',
    email: 'priority@example.com',
    now: Date.parse('2026-04-23T00:00:00.000Z'),
  });

  const identity = readCodexAccountIdentity(authPath);
  assert.equal(identity?.accountId, 'acc_token');
  assert.equal(identity?.plan, 'plus');
});
