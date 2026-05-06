import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESPONSES_ADAPTER_DOES_NOT_OWN,
  RESPONSES_ADAPTER_OWNS,
  RESPONSES_ADAPTER_PACKAGE_NAME,
  RESPONSES_ADAPTER_PACKAGE_PHASE,
} from '../src/index.js';

test('responses adapter package exposes the migration boundary contract', () => {
  assert.equal(RESPONSES_ADAPTER_PACKAGE_NAME, '@codexbridge/responses-adapter');
  assert.equal(RESPONSES_ADAPTER_PACKAGE_PHASE, 'phase-3-server');
  assert.ok(RESPONSES_ADAPTER_OWNS.includes('responses-to-chat-conversion'));
  assert.ok(RESPONSES_ADAPTER_OWNS.includes('local-responses-adapter-server'));
  assert.ok(RESPONSES_ADAPTER_DOES_NOT_OWN.includes('wechat-transport'));
  assert.ok(RESPONSES_ADAPTER_DOES_NOT_OWN.includes('assistant-records'));
});
