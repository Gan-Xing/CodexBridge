import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadCodexProfilesFromEnv, resolveCommand } from '../../../src/providers/codex/config.js';

test('loadCodexProfilesFromEnv keeps Codex OpenAI as the default profile', () => {
  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '/usr/bin/codex',
    CODEX_CLI_BIN: '/usr/bin/codex-via-proxy',
    CODEX_PROVIDER_ID: 'cliproxyminimax',
    CODEX_PROVIDER_NAME: 'CLIProxy MiniMax',
    CODEX_PROVIDER_DEFAULT_MODEL: 'MiniMax-M2.7',
  });

  assert.equal(result.defaultProviderProfileId, 'openai-default');
  assert.equal(result.profiles[0]?.providerKind, 'openai-native');
  assert.equal(result.profiles[0]?.config.cliBin, '/usr/bin/codex');
  assert.equal(result.profiles[1]?.id, 'cliproxyminimax');
  assert.equal(result.profiles[1]?.providerKind, 'minimax-via-cliproxy');
  assert.equal(result.profiles[1]?.config.defaultModel, 'MiniMax-M2.7');
});

test('resolveCommand prefers codex.exe before wrapper scripts on Windows', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-config-win-path-'));
  fs.writeFileSync(path.join(tempDir, 'codex.cmd'), '@echo off\r\n');
  fs.writeFileSync(path.join(tempDir, 'codex.exe'), 'binary');

  const resolved = resolveCommand('codex', {
    platform: 'win32',
    env: {
      PATH: tempDir,
      PATHEXT: '.CMD;.EXE',
    } as NodeJS.ProcessEnv,
    cwd: tempDir,
  });

  assert.equal(resolved, path.join(tempDir, 'codex.exe'));
});

test('resolveCommand falls back to codex.cmd on Windows when no native executable is present', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-config-win-cmd-'));
  fs.writeFileSync(path.join(tempDir, 'codex.cmd'), '@echo off\r\n');

  const resolved = resolveCommand('codex', {
    platform: 'win32',
    env: {
      PATH: tempDir,
      PATHEXT: '.CMD;.BAT',
    } as NodeJS.ProcessEnv,
    cwd: tempDir,
  });

  assert.equal(resolved, path.join(tempDir, 'codex.cmd'));
});

test('loadCodexProfilesFromEnv resolves explicit Windows command overrides without requiring the extension', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-config-win-override-'));
  const toolDir = path.join(tempDir, 'tools');
  fs.mkdirSync(toolDir, { recursive: true });
  fs.writeFileSync(path.join(toolDir, 'codex.cmd'), '@echo off\r\n');

  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '.\\tools\\codex',
  } as NodeJS.ProcessEnv, {
    platform: 'win32',
    cwd: tempDir,
  });

  assert.equal(result.profiles[0]?.config.cliBin, path.join(toolDir, 'codex.cmd'));
});
