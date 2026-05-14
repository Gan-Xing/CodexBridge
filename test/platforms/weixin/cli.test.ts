import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireServeLock,
  codexLoginStateDir,
  createWeixinServeCodexAuthManager,
  enqueuePendingRestartNotification,
  flushPendingRestartNotifications,
  materializeQrArtifact,
  pendingRestartNotificationsFile,
  parseCodexCleanupInternalThreadsArgs,
  parseCodexNativeApiServeArgs,
  parseWeixinClearContextArgs,
  parseWeixinLoginArgs,
  parseWeixinServeArgs,
  readPendingRestartNotifications,
  resolveEmbeddedCodexNativeApiOptions,
  resolveClearContextAccountId,
} from '../../../src/cli.js';

test('parseWeixinLoginArgs reads supported CLI flags', () => {
  const parsed = parseWeixinLoginArgs([
    '--base-url', 'https://ilink.example.com',
    '--state-dir', '/tmp/codexbridge-state',
    '--bot-type', '7',
    '--timeout-sec', '120',
  ]);

  assert.equal(parsed.baseUrl, 'https://ilink.example.com');
  assert.equal(parsed.stateDir, '/tmp/codexbridge-state');
  assert.equal(parsed.botType, '7');
  assert.equal(parsed.timeoutSeconds, 120);
});

test('materializeQrArtifact stores data-url qr images on disk', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-cli-'));
  const pngBody = Buffer.from('fake-png-body');
  const result = await materializeQrArtifact({
    stateDir: tmpDir,
    qrcode: 'qr-123',
    qrcodeImageContent: `data:image/png;base64,${pngBody.toString('base64')}`,
  });

  assert.ok(result.filePath);
  assert.equal(fs.existsSync(result.filePath), true);
  assert.deepEqual(fs.readFileSync(result.filePath), pngBody);
  assert.equal(result.sourceUrl, null);
});

test('materializeQrArtifact renders URL qr content into a real png', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-cli-'));
  const result = await materializeQrArtifact({
    stateDir: tmpDir,
    qrcode: 'qr-url-123',
    qrcodeImageContent: 'https://liteapp.weixin.qq.com/q/?qrcode=abc&bot_type=3',
  });

  assert.ok(result.filePath);
  assert.equal(fs.existsSync(result.filePath), true);
  assert.equal(result.sourceUrl, 'https://liteapp.weixin.qq.com/q/?qrcode=abc&bot_type=3');
  assert.deepEqual(
    fs.readFileSync(result.filePath).subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
});

test('parseWeixinServeArgs reads state-dir flag', () => {
  const parsed = parseWeixinServeArgs([
    '--state-dir', '/tmp/codexbridge-state',
    '--cwd', '/tmp/project',
  ]);

  assert.equal(parsed.stateDir, '/tmp/codexbridge-state');
  assert.equal(parsed.cwd, '/tmp/project');
});

test('createWeixinServeCodexAuthManager stores account data under runtime/codex-login', () => {
  const manager = createWeixinServeCodexAuthManager('/tmp/codexbridge-state');

  assert.equal(manager.rootDir, codexLoginStateDir('/tmp/codexbridge-state'));
  assert.equal(manager.poolPath, path.join(codexLoginStateDir('/tmp/codexbridge-state'), 'accounts.json'));
});

test('parseWeixinClearContextArgs reads state-dir and account-id flags', () => {
  const parsed = parseWeixinClearContextArgs([
    '--state-dir', '/tmp/codexbridge-state',
    '--account-id', 'bot-account',
  ]);

  assert.equal(parsed.stateDir, '/tmp/codexbridge-state');
  assert.equal(parsed.accountId, 'bot-account');
});

test('parseCodexCleanupInternalThreadsArgs defaults to dry-run and reads apply flags', () => {
  assert.deepEqual(parseCodexCleanupInternalThreadsArgs([]), {
    stateDir: null,
    cwd: null,
    dryRun: true,
    limit: 100_000,
  });

  assert.deepEqual(parseCodexCleanupInternalThreadsArgs([
    '--state-dir', '/tmp/codexbridge-state',
    '--cwd', '/tmp/project',
    '--limit', '250',
    '--apply',
  ]), {
    stateDir: '/tmp/codexbridge-state',
    cwd: '/tmp/project',
    dryRun: false,
    limit: 250,
  });

  assert.equal(parseCodexCleanupInternalThreadsArgs(['--apply', '--dry-run']).dryRun, true);
});

test('parseCodexNativeApiServeArgs reads standalone native-api flags', () => {
  assert.deepEqual(parseCodexNativeApiServeArgs([]), {
    stateDir: null,
    cwd: null,
    host: null,
    port: null,
    providerProfileId: null,
  });

  assert.deepEqual(parseCodexNativeApiServeArgs([
    '--state-dir', '/tmp/codexbridge-state',
    '--cwd', '/tmp/project',
    '--host', '127.0.0.1',
    '--port', '43182',
    '--provider-profile', 'openai-default',
  ]), {
    stateDir: '/tmp/codexbridge-state',
    cwd: '/tmp/project',
    host: '127.0.0.1',
    port: 43182,
    providerProfileId: 'openai-default',
  });
});

test('resolveEmbeddedCodexNativeApiOptions defaults native-api startup to the Codex path', () => {
  const options = resolveEmbeddedCodexNativeApiOptions({
    env: {
      CODEX_NATIVE_API_AUTH_TOKEN: 'native-secret',
    } as NodeJS.ProcessEnv,
    defaultProviderProfileId: 'qwen',
  });

  assert.deepEqual(options, {
    enabled: true,
    host: '127.0.0.1',
    port: 43182,
    providerProfileId: 'openai-default',
    authToken: 'native-secret',
    defaultModel: null,
    requestTitlePrefix: null,
  });
});

test('resolveEmbeddedCodexNativeApiOptions allows explicit native-api opt-out', () => {
  const options = resolveEmbeddedCodexNativeApiOptions({
    env: {
      CODEX_NATIVE_API_ENABLE: '0',
      CODEX_NATIVE_API_AUTH_TOKEN: 'native-secret',
    } as NodeJS.ProcessEnv,
    defaultProviderProfileId: 'openai-default',
  });

  assert.equal(options.enabled, false);
});

test('resolveEmbeddedCodexNativeApiOptions keeps embedded native-api on the Codex path while honoring host/port/model overrides', () => {
  const options = resolveEmbeddedCodexNativeApiOptions({
    env: {
      CODEX_NATIVE_API_ENABLE: 'true',
      CODEX_NATIVE_API_HOST: '127.0.0.2',
      CODEX_NATIVE_API_PORT: '53182',
      CODEX_NATIVE_API_PROVIDER_PROFILE_ID: 'qwen',
      CODEX_NATIVE_API_DEFAULT_MODEL: 'gpt-5.4',
      CODEX_NATIVE_API_TITLE_PREFIX: 'Bridge Native API',
    } as NodeJS.ProcessEnv,
    defaultProviderProfileId: 'openai-default',
  });

  assert.deepEqual(options, {
    enabled: true,
    host: '127.0.0.2',
    port: 53182,
    providerProfileId: 'openai-default',
    authToken: null,
    defaultModel: 'gpt-5.4',
    requestTitlePrefix: 'Bridge Native API',
  });
});

test('resolveClearContextAccountId infers the only saved account', () => {
  assert.equal(resolveClearContextAccountId({
    requestedAccountId: null,
    allAccounts: ['bot-account'],
  }), 'bot-account');
  assert.equal(resolveClearContextAccountId({
    requestedAccountId: null,
    allAccounts: ['bot-a', 'bot-b'],
  }), null);
  assert.equal(resolveClearContextAccountId({
    requestedAccountId: 'bot-b',
    allAccounts: ['bot-a', 'bot-b'],
  }), 'bot-b');
});

test('acquireServeLock prevents duplicate weixin serve processes for the same state dir', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-lock-'));
  const lockPath = path.join(tmpDir, 'runtime', 'weixin-serve.lock');
  const first = await acquireServeLock(lockPath);

  await assert.rejects(
    () => acquireServeLock(lockPath),
    /already running/i,
  );

  await first.release();
});

test('acquireServeLock recovers a stale lock file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-lock-'));
  const lockPath = path.join(tmpDir, 'runtime', 'weixin-serve.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 999999,
    startedAt: new Date().toISOString(),
    cwd: '/tmp/stale',
  }));

  const lock = await acquireServeLock(lockPath);
  const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

  assert.equal(payload.pid, process.pid);

  await lock.release();
});

test('restart notifications are persisted and flushed after startup', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-restart-'));
  const sent: Array<{ externalScopeId: string; content: string }> = [];

  await enqueuePendingRestartNotification({
    stateDir: tmpDir,
    externalScopeId: 'wxid_sender',
    content: '桥接已重启完成。\n现在可以继续发消息了。',
  });

  assert.deepEqual(
    readPendingRestartNotifications(pendingRestartNotificationsFile(tmpDir)).map((item) => item.externalScopeId),
    ['wxid_sender'],
  );

  await flushPendingRestartNotifications({
    stateDir: tmpDir,
    platformPlugin: {
      async start() {},
      async sendText({ externalScopeId, content }) {
        sent.push({ externalScopeId, content });
        return {
          success: true,
          deliveredCount: 1,
          deliveredText: content,
          failedIndex: null,
          failedText: '',
          error: '',
        };
      },
    } as any,
  });

  assert.deepEqual(sent, [
    {
      externalScopeId: 'wxid_sender',
      content: '桥接已重启完成。\n现在可以继续发消息了。',
    },
  ]);
  assert.deepEqual(readPendingRestartNotifications(pendingRestartNotificationsFile(tmpDir)), []);
});
