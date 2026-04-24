import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CodexCliReviewRunner } from '../../../src/providers/codex/review_runner.js';

test('CodexCliReviewRunner appends a locale-aware Chinese review prompt only for custom review targets', async () => {
  const seenArgs: string[][] = [];
  const runner = new CodexCliReviewRunner({
    spawnImpl: ((command: string, args: string[]) => {
      seenArgs.push([command, ...args]);
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.kill = () => {
        child.exitCode = 0;
      };
      setImmediate(() => {
        child.stdout.end('未发现明确问题。');
        child.stderr.end('');
        child.emit('close', 0, null);
      });
      return child;
    }) as any,
  });

  const result = await runner.start({
    codexCliBin: 'codex',
    cwd: '/tmp/work',
    model: 'gpt-5.4',
    effort: 'medium',
    serviceTier: 'fast',
    target: {
      type: 'custom',
      instructions: '只审查测试目录里的改动。',
    },
    locale: 'zh-CN',
  });

  assert.equal(result.outputState, 'complete');
  assert.equal(result.outputText, '未发现明确问题。');
  assert.equal(seenArgs.length, 1);
  assert.deepEqual(seenArgs[0]?.slice(0, 10), [
    'codex',
    '-C',
    '/tmp/work',
    '-s',
    'read-only',
    '-a',
    'never',
    '-m',
    'gpt-5.4',
    '-c',
  ]);
  assert.ok(seenArgs[0]?.includes('review'));
  assert.ok(seenArgs[0]?.includes('只审查测试目录里的改动。\n\n请使用简体中文输出代码审查结果。 先给出按严重程度排序的 findings，再补充说明。 如果没有明确问题，请明确写“未发现明确问题”。'));
});

test('CodexCliReviewRunner aborts before spawn when interrupted during onTurnStarted', async () => {
  let spawnCount = 0;
  const runner = new CodexCliReviewRunner({
    spawnImpl: (() => {
      spawnCount += 1;
      throw new Error('spawn should not be reached');
    }) as any,
  });

  const result = await runner.start({
    codexCliBin: 'codex',
    cwd: '/tmp/work',
    target: {
      type: 'uncommittedChanges',
    },
    onTurnStarted: async ({ turnId }) => {
      await runner.interrupt(turnId);
    },
  });

  assert.equal(spawnCount, 0);
  assert.equal(result.outputState, 'interrupted');
  assert.equal(result.finalSource, 'codex_review_cli_interrupted');
});
