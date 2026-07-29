import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  readWeixinConnectionStatus,
  weixinConnectionStatusFile,
  writeWeixinConnectionStatus,
} from '../../../src/platforms/weixin/connection_status.js';

test('Weixin connection status persists a non-sensitive reauthorization signal', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-weixin-status-'));

  writeWeixinConnectionStatus({
    stateDir,
    accountId: 'bot-account',
    state: 'reauthorization_required',
    errorCode: -14,
  });

  assert.deepEqual(readWeixinConnectionStatus(stateDir), {
    accountId: 'bot-account',
    state: 'reauthorization_required',
    updatedAt: readWeixinConnectionStatus(stateDir)?.updatedAt,
    errorCode: -14,
  });
  assert.equal(fs.existsSync(weixinConnectionStatusFile(stateDir)), true);
});
