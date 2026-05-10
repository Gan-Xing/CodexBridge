import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  CODEX_NATIVE_API_PACKAGE_NAME,
  CODEX_NATIVE_API_PACKAGE_PHASE,
  CODEX_NATIVE_API_RELEASE_CHANNEL,
  CodexNativeApiService,
  CodexNativeApiServer,
  CodexNativeRuntime,
  InMemoryCodexNativeApiContinuationRegistry,
} from '../src/index.js';

test('package exports the first extraction metadata', () => {
  assert.equal(CODEX_NATIVE_API_PACKAGE_NAME, '@codexbridge/codex-native-api');
  assert.equal(CODEX_NATIVE_API_PACKAGE_PHASE, 'phase-5-first-extraction');
  assert.equal(CODEX_NATIVE_API_RELEASE_CHANNEL, 'internal-only');
});

test('package exports the core localhost runtime surface', () => {
  const registry = new InMemoryCodexNativeApiContinuationRegistry();
  assert.equal(registry.describe().persistence, 'in_process');
  assert.equal(typeof CodexNativeRuntime, 'function');
  assert.equal(typeof CodexNativeApiServer, 'function');
  assert.equal(typeof CodexNativeApiService, 'function');
});

test('package metadata and root entrypoint keep a stable public boundary', () => {
  const packageJsonPath = path.resolve(import.meta.dirname, '../package.json');
  const indexPath = path.resolve(import.meta.dirname, '../src/index.ts');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    private?: boolean;
    exports?: Record<string, { types?: string; default?: string } | string>;
    files?: string[];
  };
  const source = fs.readFileSync(indexPath, 'utf8');

  assert.equal(packageJson.private, true);
  assert.deepEqual(Object.keys(packageJson.exports ?? {}).sort(), ['.', './package.json']);
  assert.equal((packageJson.exports?.['.'] as { types?: string })?.types, './dist/index.d.ts');
  assert.equal((packageJson.exports?.['.'] as { default?: string })?.default, './dist/index.js');
  assert.deepEqual(packageJson.files, ['dist', 'README.md']);
  assert.equal(source.includes('export * from'), false);
  assert.match(source, /export \{\s*[\s\S]*CodexNativeRuntime/);
  assert.match(source, /export type \{\s*[\s\S]*ProviderPluginContract/);
});
