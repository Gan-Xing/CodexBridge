import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  assert.equal(MISSION_CONTROL_PACKAGE_PHASE, 'phase-9v-checklist-refinement-gates');
  assert.equal(MISSION_CYCLE_RESULT_SCHEMA_VERSION, 'mission-cycle/v1');
  assert.ok(MISSION_CONTROL_OWNS.includes('mission-domain-model'));
  assert.ok(MISSION_CONTROL_OWNS.includes('provider-abstraction'));
  assert.ok(MISSION_CONTROL_OWNS.includes('host-adapter-contract'));
  assert.ok(MISSION_CONTROL_OWNS.includes('work-item-source-contract'));
  assert.ok(MISSION_CONTROL_OWNS.includes('source-backed-mission-creation'));
  assert.ok(MISSION_CONTROL_OWNS.includes('progress-sink-contract'));
  assert.ok(MISSION_CONTROL_OWNS.includes('supervision-foundation'));
  assert.ok(MISSION_CONTROL_OWNS.includes('persisted-stop-intents'));
  assert.ok(MISSION_CONTROL_OWNS.includes('environment-stamp-checkpoint-persistence'));
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

test('mission control package metadata and build layout stay aligned', () => {
  const packageJsonPath = path.resolve(import.meta.dirname, '../package.json');
  const tsconfigPath = path.resolve(import.meta.dirname, '../tsconfig.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    private?: boolean;
    exports?: Record<string, { types?: string; default?: string } | string>;
    files?: string[];
  };
  const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8')) as {
    compilerOptions?: { outDir?: string; rootDir?: string };
  };

  assert.equal(packageJson.private, true);
  assert.deepEqual(Object.keys(packageJson.exports ?? {}).sort(), ['.', './package.json']);
  assert.equal((packageJson.exports?.['.'] as { types?: string })?.types, './dist/index.d.ts');
  assert.equal((packageJson.exports?.['.'] as { default?: string })?.default, './dist/index.js');
  assert.deepEqual(packageJson.files, ['dist', 'README.md']);
  assert.equal(tsconfig.compilerOptions?.rootDir, 'src');
  assert.equal(tsconfig.compilerOptions?.outDir, 'dist');
});

test('mission control root entrypoint uses explicit public exports', () => {
  const indexPath = path.resolve(import.meta.dirname, '../src/index.ts');
  const source = fs.readFileSync(indexPath, 'utf8');

  assert.equal(source.includes('export * from'), false);
  assert.match(source, /export \{\s*[\s\S]*DirectMissionControlApi/);
  assert.match(source, /export type \{\s*[\s\S]*MissionControlApi/);
  assert.match(source, /export type \{\s*[\s\S]*MissionRepository/);
});
