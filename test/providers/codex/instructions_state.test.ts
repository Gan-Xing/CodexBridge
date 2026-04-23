import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CodexInstructionsManager,
  resolveCodexInstructionsPath,
} from '../../../src/providers/codex/instructions_state.js';

test('resolveCodexInstructionsPath respects CODEX_HOME', () => {
  const resolved = resolveCodexInstructionsPath({
    CODEX_HOME: '/tmp/codex-home-test',
  } as NodeJS.ProcessEnv);

  assert.equal(resolved, path.join(path.resolve('/tmp/codex-home-test'), 'AGENTS.md'));
});

test('CodexInstructionsManager reads, writes, and clears AGENTS.md', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-agents-'));
  const filePath = path.join(rootDir, 'AGENTS.md');
  const manager = new CodexInstructionsManager({ filePath });

  const initial = await manager.readInstructions();
  assert.equal(initial.exists, false);
  assert.equal(initial.content, '');

  const saved = await manager.writeInstructions('Always explain tradeoffs first.');
  assert.equal(saved.exists, true);
  assert.equal(saved.path, filePath);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'Always explain tradeoffs first.\n');

  const loaded = await manager.readInstructions();
  assert.equal(loaded.exists, true);
  assert.equal(loaded.content, 'Always explain tradeoffs first.\n');

  const cleared = await manager.clearInstructions();
  assert.equal(cleared.exists, false);
  assert.equal(fs.existsSync(filePath), false);
});
