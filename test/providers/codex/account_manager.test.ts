import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexAccountManager, readCodexAccountIdentity } from '../../../src/providers/codex/account_manager.js';
import { writeCodexAuthFile } from '../../../src/providers/codex/auth_state.js';

function makeJwt(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

function createJsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function createQueuedFetch(queue: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const next = queue.shift();
    if (!next) {
      throw new Error('Unexpected fetch call');
    }
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? '');
    calls.push({
      url: String(input),
      body,
    });
    return next();
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

function createLoginClientFactory(queue: Array<() => any | Promise<any>>) {
  const calls: Array<{ method: string; params: any }> = [];
  const clientStates: Array<{
    connected: boolean;
    startCount: number;
    stopCount: number;
    requestCalls: Array<{ method: string; params: any }>;
  }> = [];
  return {
    calls,
    clientStates,
    loginClientFactory: () => {
      const state = {
        connected: false,
        startCount: 0,
        stopCount: 0,
        requestCalls: [] as Array<{ method: string; params: any }>,
      };
      clientStates.push(state);
      return {
        isConnected() {
          return state.connected;
        },
        async start() {
          state.connected = true;
          state.startCount += 1;
        },
        async stop() {
          state.connected = false;
          state.stopCount += 1;
        },
        async request(method: string, params: any) {
          state.requestCalls.push({ method, params });
          calls.push({ method, params });
          const next = queue.shift();
          if (!next) {
            throw new Error(`Unexpected login RPC: ${method}`);
          }
          return await next();
        },
      };
    },
  };
}

function createSecretToolRunner() {
  const stored = new Map<string, string>();
  const calls: Array<{ command: string; args: string[]; input: string | undefined }> = [];
  const commandRunner = (command: string, args: string[], options: Record<string, unknown> = {}) => {
    const input = typeof options.input === 'string' ? options.input : undefined;
    calls.push({ command, args, input });
    const accountId = String(args[args.length - 1] ?? '');
    if (args[0] === 'lookup') {
      if (accountId === '__codexbridge_probe__') {
        return {
          pid: 1,
          output: ['', '', ''],
          stdout: '',
          stderr: '',
          status: 1,
          signal: null,
        };
      }
      return {
        pid: 1,
        output: ['', stored.get(accountId) ?? '', ''],
        stdout: stored.get(accountId) ?? '',
        stderr: '',
        status: stored.has(accountId) ? 0 : 1,
        signal: null,
      };
    }
    if (args[0] === 'store') {
      stored.set(accountId, input ?? '');
      return {
        pid: 1,
        output: ['', '', ''],
        stdout: '',
        stderr: '',
        status: 0,
        signal: null,
      };
    }
    if (args[0] === 'clear') {
      stored.delete(accountId);
      return {
        pid: 1,
        output: ['', '', ''],
        stdout: '',
        stderr: '',
        status: 0,
        signal: null,
      };
    }
    throw new Error(`Unexpected secret-tool command: ${args.join(' ')}`);
  };
  return {
    commandRunner: commandRunner as any,
    calls,
  };
}

test('CodexAccountManager persists device login, polls pending status, and finalizes into the encrypted account pool', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-account-manager-'));
  const authPath = path.join(tempDir, 'codex-home', 'auth.json');
  let now = Date.parse('2026-04-22T10:00:00.000Z');
  const idToken = makeJwt({
    email: 'device@example.com',
    name: 'Device User',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc_device',
      chatgpt_plan_type: 'plus',
    },
  });
  const accessToken = makeJwt({
    email: 'device@example.com',
    exp: Math.floor((now + 3_600_000) / 1000),
  });
  const { calls, clientStates, loginClientFactory } = createLoginClientFactory([
    () => ({
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    }),
  ]);
  const manager = new CodexAccountManager({
    rootDir: path.join(tempDir, 'manager'),
    authPath,
    platform: 'darwin',
    now: () => now,
    loginClientFactory,
  });

  const pending = await manager.startDeviceLogin({
    requestedByScope: 'wx:scope-1',
  });
  assert.equal(pending.userCode, 'ABCD-EFGH');
  assert.equal(pending.requestedByScope, 'wx:scope-1');
  assert.equal(clientStates[0]?.startCount, 1);
  assert.equal(clientStates[0]?.stopCount, 0);
  assert.equal(clientStates[0]?.connected, true);

  now += 5_000;
  const pendingRefresh = await manager.refreshPendingLogin();
  assert.deepEqual(pendingRefresh?.status, 'pending');
  assert.equal((pendingRefresh as any).pendingLogin.requestedByScope, 'wx:scope-1');
  assert.equal(clientStates[0]?.stopCount, 0);
  assert.equal(clientStates[0]?.connected, true);

  now += 5_000;
  await writeCodexAuthFile({
    authPath,
    accessToken,
    refreshToken: 'refresh-device',
    idToken,
    accountId: 'acc_device',
    email: 'device@example.com',
    now,
  });
  const completed = await manager.refreshPendingLogin();
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.account.email, 'device@example.com');
  assert.equal(completed?.account.isActive, true);
  assert.equal(completed?.account.credentialStore, 'encrypted-file');
  assert.equal(completed?.authPath, authPath);
  assert.equal(clientStates[0]?.stopCount, 1);
  assert.equal(clientStates[0]?.connected, false);

  const listed = await manager.listAccounts();
  assert.equal(listed.activeAccountId, completed?.account.id ?? null);
  assert.equal(listed.accounts.length, 1);
  assert.equal(listed.pendingLogin, null);

  const identity = readCodexAccountIdentity(authPath);
  assert.equal(identity?.email, 'device@example.com');
  assert.equal(identity?.accountId, 'acc_device');
  assert.equal(identity?.plan, 'plus');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'account/login/start');
});

test('CodexAccountManager replaces a persisted pending login when the original login session is no longer alive', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-account-stale-login-'));
  const authPath = path.join(tempDir, 'codex-home', 'auth.json');
  const now = Date.parse('2026-04-22T10:30:00.000Z');
  const first = createLoginClientFactory([
    () => ({
      type: 'chatgptDeviceCode',
      loginId: 'login-old',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'OLD1-CODE',
    }),
  ]);
  const manager1 = new CodexAccountManager({
    rootDir: path.join(tempDir, 'manager'),
    authPath,
    platform: 'darwin',
    now: () => now,
    loginClientFactory: first.loginClientFactory,
  });
  await manager1.startDeviceLogin();

  const second = createLoginClientFactory([
    () => ({
      type: 'chatgptDeviceCode',
      loginId: 'login-new',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'NEW2-CODE',
    }),
  ]);
  const manager2 = new CodexAccountManager({
    rootDir: path.join(tempDir, 'manager'),
    authPath,
    platform: 'darwin',
    now: () => now,
    loginClientFactory: second.loginClientFactory,
  });

  const pending = await manager2.startDeviceLogin();
  assert.equal(pending.userCode, 'NEW2-CODE');

  const pool = JSON.parse(fs.readFileSync(path.join(tempDir, 'manager', 'accounts.json'), 'utf8'));
  assert.equal(pool.pendingLogin.loginId, 'login-new');
  assert.equal(pool.pendingLogin.userCode, 'NEW2-CODE');
  assert.equal(second.calls.length, 1);
  assert.equal(second.calls[0]?.method, 'account/login/start');
});

test('CodexAccountManager refreshes expired tokens when switching accounts by index', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-account-switch-'));
  const authPath = path.join(tempDir, 'codex-home', 'auth.json');
  let now = Date.parse('2026-04-22T12:00:00.000Z');
  const login1IdToken = makeJwt({
    email: 'one@example.com',
    name: 'One',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc_one',
      chatgpt_plan_type: 'pro',
    },
  });
  const login1AccessToken = makeJwt({
    email: 'one@example.com',
    exp: Math.floor((now + 1_000) / 1000),
  });
  const login2IdToken = makeJwt({
    email: 'two@example.com',
    name: 'Two',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc_two',
      chatgpt_plan_type: 'team',
    },
  });
  const login2AccessToken = makeJwt({
    email: 'two@example.com',
    exp: Math.floor((now + 86_400_000) / 1000),
  });
  const refreshedAccessToken = makeJwt({
    email: 'one@example.com',
    exp: Math.floor((now + 86_400_000) / 1000),
  });
  const refreshedIdToken = makeJwt({
    email: 'one@example.com',
    name: 'One Refreshed',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc_one',
      chatgpt_plan_type: 'enterprise',
    },
  });
  const { fetchImpl } = createQueuedFetch([
    () => createJsonResponse(200, {
      access_token: refreshedAccessToken,
      refresh_token: 'refresh-one-next',
      id_token: refreshedIdToken,
      expires_in: 86400,
      token_type: 'Bearer',
      scope: 'openid profile email offline_access',
    }),
  ]);
  const { loginClientFactory } = createLoginClientFactory([
    () => ({
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: '1111-AAAA',
    }),
    () => ({
      type: 'chatgptDeviceCode',
      loginId: 'login-2',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: '2222-BBBB',
    }),
  ]);
  const manager = new CodexAccountManager({
    rootDir: path.join(tempDir, 'manager'),
    authPath,
    platform: 'darwin',
    fetchImpl,
    now: () => now,
    loginClientFactory,
  });

  await manager.startDeviceLogin();
  now += 1_000;
  await writeCodexAuthFile({
    authPath,
    accessToken: login1AccessToken,
    refreshToken: 'refresh-one',
    idToken: login1IdToken,
    accountId: 'acc_one',
    email: 'one@example.com',
    now,
  });
  await manager.refreshPendingLogin();

  await manager.startDeviceLogin();
  now += 1_000;
  await writeCodexAuthFile({
    authPath,
    accessToken: login2AccessToken,
    refreshToken: 'refresh-two',
    idToken: login2IdToken,
    accountId: 'acc_two',
    email: 'two@example.com',
    now,
  });
  await manager.refreshPendingLogin();

  now += 10_000;
  const switched = await manager.switchAccountByIndex(1);
  assert.equal(switched.refreshed, true);
  assert.equal(switched.account.email, 'one@example.com');
  assert.equal(switched.account.plan, 'enterprise');
  assert.equal(switched.account.isActive, true);

  const activeIdentity = readCodexAccountIdentity(authPath);
  assert.equal(activeIdentity?.email, 'one@example.com');
  assert.equal(activeIdentity?.plan, 'enterprise');
});

test('CodexAccountManager absorbs an existing host auth.json into the local account pool on list', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-account-import-'));
  const authPath = path.join(tempDir, 'codex-home', 'auth.json');
  const now = Date.parse('2026-04-22T13:00:00.000Z');
  const idToken = makeJwt({
    email: 'host@example.com',
    name: 'Host User',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc_host',
      chatgpt_plan_type: 'pro',
    },
  });
  const accessToken = makeJwt({
    email: 'host@example.com',
    exp: Math.floor((now + 3_600_000) / 1000),
  });
  await writeCodexAuthFile({
    authPath,
    accessToken,
    refreshToken: 'refresh-host',
    idToken,
    accountId: 'acc_host',
    email: 'host@example.com',
    now,
  });

  const manager = new CodexAccountManager({
    rootDir: path.join(tempDir, 'manager'),
    authPath,
    platform: 'darwin',
    now: () => now,
  });

  const listing = await manager.listAccounts();

  assert.equal(listing.accounts.length, 1);
  assert.equal(listing.accounts[0]?.email, 'host@example.com');
  assert.equal(listing.accounts[0]?.planType, 'pro');
  assert.equal(listing.accounts[0]?.isActive, true);
  assert.ok(fs.existsSync(path.join(tempDir, 'manager', 'accounts.json')));
});

test('CodexAccountManager consolidates duplicate same-email accounts when host auth resolves to one canonical account id', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-account-dedupe-'));
  const managerRoot = path.join(tempDir, 'manager');
  const authPath = path.join(tempDir, 'codex-home', 'auth.json');
  const now = Date.parse('2026-04-23T08:00:00.000Z');
  fs.mkdirSync(managerRoot, { recursive: true });
  fs.writeFileSync(path.join(managerRoot, 'accounts.json'), `${JSON.stringify({
    version: 1,
    activeAccountId: 'acc-old-id',
    pendingLogin: null,
    accounts: [
      {
        id: 'acc-old-id',
        label: 'old@example.com',
        email: 'same@example.com',
        name: 'Same User',
        accountId: 'acc_raw',
        plan: 'plus',
        credentialStore: 'encrypted-file',
        addedAt: now - 10_000,
        lastUsedAt: now - 5_000,
      },
      {
        id: 'acc-new-id',
        label: 'same@example.com',
        email: 'same@example.com',
        name: 'Same User',
        accountId: 'acc_token',
        plan: 'plus',
        credentialStore: 'encrypted-file',
        addedAt: now - 2_000,
        lastUsedAt: now - 1_000,
      },
    ],
  }, null, 2)}\n`);

  const idToken = makeJwt({
    email: 'same@example.com',
    name: 'Same User',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc_token',
      chatgpt_plan_type: 'plus',
    },
  });
  const accessToken = makeJwt({
    email: 'same@example.com',
    exp: Math.floor((now + 3_600_000) / 1000),
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc_token',
    },
  });
  await writeCodexAuthFile({
    authPath,
    accessToken,
    refreshToken: 'refresh-same',
    idToken,
    accountId: 'acc_raw',
    email: 'same@example.com',
    now,
  });

  const manager = new CodexAccountManager({
    rootDir: managerRoot,
    authPath,
    platform: 'darwin',
    now: () => now,
  });

  const listing = await manager.listAccounts();
  assert.equal(listing.accounts.length, 1);
  assert.equal(listing.accounts[0]?.email, 'same@example.com');
  assert.equal(listing.accounts[0]?.accountId, 'acc_token');
  assert.equal(listing.accounts[0]?.isActive, true);

  const persisted = JSON.parse(fs.readFileSync(path.join(managerRoot, 'accounts.json'), 'utf8'));
  assert.equal(persisted.accounts.length, 1);
  assert.equal(persisted.accounts[0]?.accountId, 'acc_token');
});

test('CodexAccountManager prefers secret-tool storage on Linux when it is available', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-account-secret-tool-'));
  const authPath = path.join(tempDir, 'codex-home', 'auth.json');
  let now = Date.parse('2026-04-22T14:00:00.000Z');
  const { commandRunner, calls } = createSecretToolRunner();
  const { loginClientFactory } = createLoginClientFactory([
    () => ({
      type: 'chatgptDeviceCode',
      loginId: 'login-secret',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'SECR-ET12',
    }),
  ]);
  const manager = new CodexAccountManager({
    rootDir: path.join(tempDir, 'manager'),
    authPath,
    platform: 'linux',
    commandRunner,
    now: () => now,
    loginClientFactory,
  });

  await manager.startDeviceLogin();
  now += 1_000;
  await writeCodexAuthFile({
    authPath,
    accessToken: makeJwt({
      email: 'secret@example.com',
      exp: Math.floor((now + 3_600_000) / 1000),
    }),
    refreshToken: 'refresh-secret',
    idToken: makeJwt({
      email: 'secret@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acc_secret',
        chatgpt_plan_type: 'pro',
      },
    }),
    accountId: 'acc_secret',
    email: 'secret@example.com',
    now,
  });
  const completed = await manager.refreshPendingLogin();

  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.account.credentialStore, 'secret-tool');
  assert.ok(calls.some((call) => call.args[0] === 'store'));
});
