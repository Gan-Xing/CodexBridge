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
  parseWeixinClearContextArgs,
  parseWeixinLoginArgs,
  parseWeixinServeArgs,
  readPendingRestartNotifications,
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
