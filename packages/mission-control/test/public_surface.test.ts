import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MISSION_CYCLE_RESULT_SCHEMA_VERSION,
  MISSION_CONTROL_DOES_NOT_OWN,
  MISSION_CONTROL_OWNS,
  MISSION_CONTROL_PACKAGE_NAME,
  MISSION_CONTROL_PACKAGE_PHASE,
  createNoopMissionHostAdapter,
} from '../src/index.js';

test('mission control package exposes the package boundary contract', () => {
  assert.equal(MISSION_CONTROL_PACKAGE_NAME, '@codexbridge/mission-control');
  assert.equal(MISSION_CONTROL_PACKAGE_PHASE, 'phase-9q-paused-approval-resolution');
  assert.equal(MISSION_CYCLE_RESULT_SCHEMA_VERSION, 'mission-cycle/v1');
  assert.ok(MISSION_CONTROL_OWNS.includes('mission-domain-model'));
  assert.ok(MISSION_CONTROL_OWNS.includes('provider-abstraction'));
  assert.ok(MISSION_CONTROL_OWNS.includes('host-adapter-contract'));
  assert.ok(MISSION_CONTROL_OWNS.includes('work-item-source-contract'));
  assert.ok(MISSION_CONTROL_OWNS.includes('source-backed-mission-creation'));
  assert.ok(MISSION_CONTROL_OWNS.includes('progress-sink-contract'));
  assert.ok(MISSION_CONTROL_OWNS.includes('supervision-foundation'));
  assert.ok(MISSION_CONTROL_OWNS.includes('persisted-stop-intents'));
  assert.ok(MISSION_CONTROL_DOES_NOT_OWN.includes('wechat-transport'));
  assert.ok(MISSION_CONTROL_DOES_NOT_OWN.includes('assistant-records'));
});

test('mission control package exposes a no-op host adapter baseline', async () => {
  const adapter = createNoopMissionHostAdapter();
  const context = await adapter.getContext('mission-host-1');
  assert.equal(context.missionId, 'mission-host-1');
  assert.equal(context.platform, 'manual');
  assert.equal(context.hostSessionId, null);
  assert.equal(context.bridgeSessionId, null);
  await adapter.bindProviderThread({
    missionId: 'mission-host-1',
    hostSessionId: null,
    bridgeSessionId: null,
    providerThreadId: null,
  });
});
