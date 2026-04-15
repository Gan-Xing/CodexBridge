import assert from 'node:assert/strict';
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
