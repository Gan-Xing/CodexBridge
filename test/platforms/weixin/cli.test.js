import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { materializeQrArtifact, parseWeixinLoginArgs, parseWeixinServeArgs } from '../../../src/cli.js';

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
