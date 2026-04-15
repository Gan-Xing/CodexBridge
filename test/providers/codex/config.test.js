import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCodexProfilesFromEnv } from '../../../src/providers/codex/config.js';

test('loadCodexProfilesFromEnv keeps Codex OpenAI as the default profile', () => {
  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '/usr/bin/codex',
    CODEX_CLI_BIN: '/usr/bin/codex-via-proxy',
    CODEX_PROVIDER_ID: 'cliproxyminimax',
    CODEX_PROVIDER_NAME: 'CLIProxy MiniMax',
    CODEX_PROVIDER_DEFAULT_MODEL: 'MiniMax-M2.7',
  });

  assert.equal(result.defaultProviderProfileId, 'openai-default');
  assert.equal(result.profiles[0]?.providerKind, 'codex');
  assert.equal(result.profiles[0]?.config.cliBin, '/usr/bin/codex');
  assert.equal(result.profiles[1]?.id, 'cliproxyminimax');
  assert.equal(result.profiles[1]?.providerKind, 'codex');
  assert.equal(result.profiles[1]?.config.defaultModel, 'MiniMax-M2.7');
});
