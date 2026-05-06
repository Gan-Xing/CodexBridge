import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MISSION_CONTROL_DOES_NOT_OWN,
  MISSION_CONTROL_OWNS,
  MISSION_CONTROL_PACKAGE_NAME,
  MISSION_CONTROL_PACKAGE_PHASE,
} from '../src/index.js';

test('mission control package exposes the package boundary contract', () => {
  assert.equal(MISSION_CONTROL_PACKAGE_NAME, '@codexbridge/mission-control');
  assert.equal(MISSION_CONTROL_PACKAGE_PHASE, 'phase-4-provider-foundations');
  assert.ok(MISSION_CONTROL_OWNS.includes('mission-domain-model'));
  assert.ok(MISSION_CONTROL_OWNS.includes('provider-abstraction'));
  assert.ok(MISSION_CONTROL_DOES_NOT_OWN.includes('wechat-transport'));
  assert.ok(MISSION_CONTROL_DOES_NOT_OWN.includes('assistant-records'));
});
