import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexGoalManager } from '../../../src/providers/codex/goal_state.js';

test('CodexGoalManager reads, writes, and clears the global goal file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-goal-'));
  const filePath = path.join(root, 'codex-goal.txt');
  const manager = new CodexGoalManager({ filePath });

  const empty = await manager.readGoal();
  assert.equal(empty.exists, false);
  assert.equal(empty.goal, '');

  const saved = await manager.writeGoal('Keep CodexBridge stable.');
  assert.equal(saved.exists, true);
  assert.equal(saved.goal, 'Keep CodexBridge stable.');

  const reloaded = await manager.readGoal();
  assert.equal(reloaded.exists, true);
  assert.equal(reloaded.goal, 'Keep CodexBridge stable.');

  const cleared = await manager.clearGoal();
  assert.equal(cleared.exists, false);
  assert.equal(cleared.goal, '');
});
