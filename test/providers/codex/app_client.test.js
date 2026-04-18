import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexAppClient } from '../../../src/providers/codex/app_client.js';

test('CodexAppClient startTurn sends explicit default collaboration settings payload', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  const calls = [];
  client.request = async (method, params) => {
    calls.push([method, params]);
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: 'thread-1',
          name: 'Thread 1',
          turns: [{
            id: 'turn-1',
            status: 'completed',
            items: [{
              type: 'assistant_message',
              text: 'done',
            }],
          }],
        },
      };
    }
    return {};
  };

  const result = await client.startTurn({
    threadId: 'thread-1',
    inputText: 'hello',
    model: 'gpt-5.4',
    effort: 'medium',
    collaborationMode: 'default',
    timeoutMs: 10,
  });

  assert.equal(result.outputText, 'done');
  const turnStart = calls.find(([method]) => method === 'turn/start')?.[1];
  assert.deepEqual(turnStart.collaborationMode, {
    mode: 'default',
    settings: {
      model: 'gpt-5.4',
      reasoning_effort: 'medium',
      developer_instructions: '',
    },
  });
  assert.deepEqual(turnStart.input, [{
    type: 'text',
    text: 'hello',
    text_elements: [],
  }]);
});

test('CodexAppClient omits null reasoning effort from default collaboration settings', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  const calls = [];
  client.request = async (method, params) => {
    calls.push([method, params]);
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: 'thread-1',
          name: 'Thread 1',
          turns: [{
            id: 'turn-1',
            status: 'completed',
            items: [{
              type: 'assistant_message',
              text: 'done',
            }],
          }],
        },
      };
    }
    return {};
  };

  await client.startTurn({
    threadId: 'thread-1',
    inputText: 'hello',
    model: 'gpt-5.4',
    effort: null,
    collaborationMode: 'default',
    timeoutMs: 10,
  });

  const turnStart = calls.find(([method]) => method === 'turn/start')?.[1];
  assert.deepEqual(turnStart.collaborationMode, {
    mode: 'default',
    settings: {
      model: 'gpt-5.4',
      developer_instructions: '',
    },
  });
});

test('CodexAppClient forwards custom developer instructions into collaboration settings', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  const calls = [];
  client.request = async (method, params) => {
    calls.push([method, params]);
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: 'thread-1',
          name: 'Thread 1',
          turns: [{
            id: 'turn-1',
            status: 'completed',
            items: [{
              type: 'assistant_message',
              text: 'done',
            }],
          }],
        },
      };
    }
    return {};
  };

  await client.startTurn({
    threadId: 'thread-1',
    inputText: 'hello',
    model: 'gpt-5.4',
    effort: null,
    collaborationMode: 'default',
    developerInstructions: 'Always inspect the workspace.',
    timeoutMs: 10,
  });

  const turnStart = calls.find(([method]) => method === 'turn/start')?.[1];
  assert.equal(
    turnStart.collaborationMode?.settings?.developer_instructions,
    'Always inspect the workspace.',
  );
});

test('CodexAppClient waits through thread materialization errors before reading turn output', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  let readCount = 0;
  client.request = async (method) => {
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      readCount += 1;
      if (readCount === 1) {
        throw new Error('thread thread-1 is not materialized yet; includeTurns is unavailable before first user message');
      }
      return {
        thread: {
          id: 'thread-1',
          name: 'Thread 1',
          turns: [{
            id: 'turn-1',
            status: 'completed',
            items: [{
              type: 'assistant_message',
              text: 'done',
            }],
          }],
        },
      };
    }
    return {};
  };

  const result = await client.startTurn({
    threadId: 'thread-1',
    inputText: 'hello',
    model: 'gpt-5.4',
    effort: null,
    collaborationMode: 'default',
    timeoutMs: 2500,
  });

  assert.equal(result.outputText, 'done');
  assert.equal(readCount, 2);
});

test('CodexAppClient waits for assistant output after a terminal turn initially contains only the user message', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  let readCount = 0;
  client.request = async (method) => {
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      readCount += 1;
      if (readCount === 1) {
        return {
          thread: {
            id: 'thread-1',
            name: 'Thread 1',
            turns: [{
              id: 'turn-1',
              status: 'completed',
              items: [{
                type: 'userMessage',
                text: 'hello',
              }],
            }],
          },
        };
      }
      return {
        thread: {
          id: 'thread-1',
          name: 'Thread 1',
          turns: [{
            id: 'turn-1',
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                text: 'hello',
              },
              {
                type: 'agentMessage',
                phase: 'final_answer',
                text: 'done',
              },
            ],
          }],
        },
      };
    }
    return {};
  };

  const result = await client.startTurn({
    threadId: 'thread-1',
    inputText: 'hello',
    model: 'gpt-5.4',
    effort: null,
    collaborationMode: 'default',
    timeoutMs: 2500,
  });

  assert.equal(result.outputText, 'done');
  assert.equal(readCount, 2);
});

test('CodexAppClient waits for final output after a terminal turn initially contains commentary only', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  let readCount = 0;
  client.request = async (method) => {
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      readCount += 1;
      if (readCount === 1) {
        return {
          thread: {
            id: 'thread-1',
            name: 'Thread 1',
            turns: [{
              id: 'turn-1',
              status: 'completed',
              items: [
                {
                  type: 'userMessage',
                  text: 'hello',
                },
                {
                  type: 'agentMessage',
                  phase: 'commentary',
                  text: 'running command',
                },
              ],
            }],
          },
        };
      }
      return {
        thread: {
          id: 'thread-1',
          name: 'Thread 1',
          turns: [{
            id: 'turn-1',
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                text: 'hello',
              },
              {
                type: 'agentMessage',
                phase: 'commentary',
                text: 'running command',
              },
              {
                type: 'agentMessage',
                phase: 'final_answer',
                text: '598 lines',
              },
            ],
          }],
        },
      };
    }
    return {};
  };

  const result = await client.startTurn({
    threadId: 'thread-1',
    inputText: 'hello',
    model: 'gpt-5.4',
    effort: null,
    collaborationMode: 'default',
    timeoutMs: 2500,
  });

  assert.equal(result.outputText, '598 lines');
  assert.equal(readCount, 2);
});

test('CodexAppClient falls back to the session log task_complete message when thread output is still empty', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-session-log-'));
  const sessionPath = path.join(sessionDir, 'rollout.jsonl');
  fs.writeFileSync(sessionPath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: 'turn-1',
      last_agent_message: '`611 /tmp/file`',
    },
  })}\n`, 'utf8');

  client.request = async (method) => {
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: 'thread-1',
          name: 'Thread 1',
          path: sessionPath,
          turns: [{
            id: 'turn-1',
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                text: 'hello',
              },
              {
                type: 'agentMessage',
                phase: 'commentary',
                text: 'running command',
              },
            ],
          }],
        },
      };
    }
    return {};
  };

  const result = await client.startTurn({
    threadId: 'thread-1',
    inputText: 'hello',
    model: 'gpt-5.4',
    effort: null,
    collaborationMode: 'default',
    timeoutMs: 2500,
  });

  assert.equal(result.outputText, '`611 /tmp/file`');
});

test('CodexAppClient keeps waiting for task_complete when turn status is completed early', async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-session-log-'));
  const sessionPath = path.join(sessionDir, 'rollout.jsonl');
  fs.writeFileSync(sessionPath, '', 'utf8');

  let nowMs = 0;
  let readCount = 0;
  const client = new CodexAppClient({
    codexCliBin: 'codex',
    turnPollNow: () => nowMs,
    turnPollSleep: async () => {
      nowMs += 15_000;
    },
  });

  client.request = async (method) => {
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      readCount += 1;
      if (readCount === 4) {
        fs.writeFileSync(sessionPath, `${JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-1',
            last_agent_message: '1395 data files',
          },
        })}\n`, 'utf8');
      }
      return {
        thread: {
          id: 'thread-1',
          name: 'Thread 1',
          path: sessionPath,
          turns: [{
            id: 'turn-1',
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                text: 'hello',
              },
              {
                type: 'agentMessage',
                phase: 'commentary',
                text: 'still working',
              },
            ],
          }],
        },
      };
    }
    return {};
  };

  const result = await client.startTurn({
    threadId: 'thread-1',
    inputText: 'hello',
    model: 'gpt-5.4',
    effort: null,
    collaborationMode: 'default',
    timeoutMs: 120_000,
  });

  assert.equal(result.outputText, '1395 data files');
  assert.equal(readCount, 4);
});
