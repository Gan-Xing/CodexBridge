import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAppClient } from '../../../src/providers/codex/app_client.js';

test('CodexAppClient listThreads returns preview rows and nextCursor', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  client.request = async (method, params) => {
    assert.equal(method, 'thread/list');
    assert.equal(params.cursor, 'cursor-1');
    assert.equal(params.searchTerm, 'bridge');
    return {
      data: [{
        id: 'thread-1',
        name: 'Bridge thread',
        cwd: '/tmp/work',
        updatedAt: 123,
        preview: 'hello bridge',
      }],
      nextCursor: 'cursor-2',
    };
  };

  const result = await client.listThreads({
    limit: 5,
    cursor: 'cursor-1',
    searchTerm: 'bridge',
  });

  assert.deepEqual(result, {
    items: [{
      threadId: 'thread-1',
      title: 'Bridge thread',
      cwd: '/tmp/work',
      updatedAt: 123000,
      preview: 'hello bridge',
    }],
    nextCursor: 'cursor-2',
  });
});

test('CodexAppClient normalizes second-based thread timestamps to milliseconds', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  client.request = async (method) => {
    if (method === 'thread/read') {
      return {
        thread: {
          id: 'thread-1',
          name: 'Bridge thread',
          cwd: '/tmp/work',
          updatedAt: 1776425803,
          preview: 'hello bridge',
          turns: [],
        },
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  const result = await client.readThread('thread-1', false);

  assert.equal(result?.updatedAt, 1776425803000);
});

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

test('CodexAppClient times out individual JSON-RPC requests and clears pending state', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  client.connected = true;
  client.socket = {};
  client.send = () => {};

  await assert.rejects(
    client.request('thread/read', { threadId: 'thread-1', includeTurns: true }, { timeoutMs: 20 }),
    /Timed out waiting for Codex JSON-RPC response to thread\/read/,
  );
  assert.equal(client.pending.size, 0);
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

test('CodexAppClient retries thread reads that time out while waiting for turn completion', async () => {
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
        throw new Error('Timed out waiting for Codex JSON-RPC response to thread/read');
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

test('CodexAppClient waits for assistant output after a terminal turn initially contains no visible items', async () => {
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
              items: [],
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
            items: [{
              type: 'agentMessage',
              phase: 'final_answer',
              text: '补落盘的最终文本。',
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

  assert.equal(result.outputText, '补落盘的最终文本。');
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

test('CodexAppClient forwards final-answer progress notifications before the final answer lands in thread history', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  const progress = [];
  let readCount = 0;
  client.request = async (method) => {
    if (method === 'turn/start') {
      setTimeout(() => {
        client.emit('notification', {
          method: 'item/agentMessage/delta',
          params: {
            turnId: 'turn-1',
            itemId: 'item-1',
            phase: 'final_answer',
            delta: '先检查一下实现。',
          },
        });
      }, 10);
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
              status: 'running',
              items: [],
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
            items: [{
              type: 'agentMessage',
              phase: 'final_answer',
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
    onProgress(update) {
      progress.push(update);
    },
  });

  assert.equal(result.outputText, 'done');
  assert.deepEqual(progress, [{
    text: '先检查一下实现。',
    delta: '先检查一下实现。',
    outputKind: 'final_answer',
  }]);
});

test('CodexAppClient classifies agentMessage deltas using item/started phase metadata like the Telegram bridge', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  const progress = [];
  let readCount = 0;
  client.request = async (method) => {
    if (method === 'turn/start') {
      setTimeout(() => {
        client.emit('notification', {
          method: 'item/started',
          params: {
            turnId: 'turn-1',
            item: {
              id: 'item-1',
              type: 'agentMessage',
              phase: 'final_answer',
            },
          },
        });
        client.emit('notification', {
          method: 'item/agentMessage/delta',
          params: {
            turnId: 'turn-1',
            itemId: 'item-1',
            delta: '最终答案第一段。',
          },
        });
      }, 10);
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
              status: 'running',
              items: [],
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
            items: [{
              type: 'agentMessage',
              phase: 'final_answer',
              text: '最终答案第一段。',
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
    onProgress(update) {
      progress.push(update);
    },
  });

  assert.equal(result.outputText, '最终答案第一段。');
  assert.deepEqual(progress, [{
    text: '最终答案第一段。',
    delta: '最终答案第一段。',
    outputKind: 'final_answer',
  }]);
});

test('CodexAppClient treats agentMessage items as final output when no assistant-prefixed item type is present', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  client.request = async (method) => {
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
            items: [
              {
                type: 'userMessage',
                text: 'hello',
              },
              {
                type: 'agentMessage',
                text: '这是最终正文，不应该被吞掉。',
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

  assert.equal(result.outputText, '这是最终正文，不应该被吞掉。');
});

test('CodexAppClient treats message role assistant items as final output when Codex returns generic message items', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  client.request = async (method) => {
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
            items: [
              {
                type: 'message',
                role: 'user',
                text: 'hello',
              },
              {
                type: 'message',
                role: 'assistant',
                phase: 'final_answer',
                text: '这是从 message/assistant 结构拿到的最终正文。',
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

  assert.equal(result.outputText, '这是从 message/assistant 结构拿到的最终正文。');
});

test('CodexAppClient waits for final_answer instead of returning commentary-only agentMessage too early', async () => {
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
                  text: '我的名字你找找记忆',
                },
                {
                  type: 'agentMessage',
                  phase: 'commentary',
                  text: '我先查一下已保存记忆里有没有你的名字记录，只看现有记忆，不会做额外猜测。',
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
                text: '我的名字你找找记忆',
              },
              {
                type: 'agentMessage',
                phase: 'commentary',
                text: '我先查一下已保存记忆里有没有你的名字记录，只看现有记忆，不会做额外猜测。',
              },
              {
                type: 'agentMessage',
                phase: 'final_answer',
                text: '记忆里有你的名字记录：`甘星`。',
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
    inputText: '我的名字你找找记忆',
    model: 'gpt-5.4',
    effort: null,
    collaborationMode: 'default',
    timeoutMs: 2500,
  });

  assert.equal(result.outputText, '记忆里有你的名字记录：`甘星`。');
  assert.equal(readCount, 2);
});

test('CodexAppClient waits for final_answer when commentary and final output are both returned as message role assistant items', async () => {
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
                  type: 'message',
                  role: 'user',
                  text: '为什么微信没回复',
                },
                {
                  type: 'message',
                  role: 'assistant',
                  phase: 'commentary',
                  text: '我先对照日志和 rollout，确认是哪一段丢了。',
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
                type: 'message',
                role: 'user',
                text: '为什么微信没回复',
              },
              {
                type: 'message',
                role: 'assistant',
                phase: 'commentary',
                text: '我先对照日志和 rollout，确认是哪一段丢了。',
              },
              {
                type: 'message',
                role: 'assistant',
                phase: 'final_answer',
                text: '问题在 CodexBridge 没把最终答案从 message/assistant 结构里识别出来。',
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
    inputText: '为什么微信没回复',
    model: 'gpt-5.4',
    effort: null,
    collaborationMode: 'default',
    timeoutMs: 2500,
  });

  assert.equal(result.outputText, '问题在 CodexBridge 没把最终答案从 message/assistant 结构里识别出来。');
  assert.equal(readCount, 2);
});

test('CodexAppClient forwards final-answer progress when item notifications use message role assistant shape', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  const progress = [];
  let readCount = 0;
  client.request = async (method) => {
    if (method === 'turn/start') {
      setTimeout(() => {
        client.emit('notification', {
          method: 'item/started',
          params: {
            turnId: 'turn-1',
            item: {
              id: 'item-1',
              type: 'message',
              role: 'assistant',
              phase: 'final_answer',
            },
          },
        });
        client.emit('notification', {
          method: 'item/message/delta',
          params: {
            turnId: 'turn-1',
            itemId: 'item-1',
            delta: '这是流式最终答案。',
          },
        });
      }, 10);
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
              status: 'running',
              items: [],
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
            items: [{
              type: 'message',
              role: 'assistant',
              phase: 'final_answer',
              text: '这是流式最终答案。',
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
    onProgress(update) {
      progress.push(update);
    },
  });

  assert.equal(result.outputText, '这是流式最终答案。');
  assert.deepEqual(progress, [{
    text: '这是流式最终答案。',
    delta: '这是流式最终答案。',
    outputKind: 'final_answer',
  }]);
});


test('CodexAppClient marks thread-backed final output as complete', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  client.request = async (method) => {
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
              type: 'message',
              role: 'assistant',
              phase: 'final_answer',
              text: '完整最终答案。',
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
    timeoutMs: 100,
  });

  assert.equal(result.outputText, '完整最终答案。');
  assert.equal(result.outputState, 'complete');
  assert.equal(result.previewText, '');
  assert.equal(result.finalSource, 'thread_items');
});

test('CodexAppClient returns partial when only progress final snapshots exist after terminal settle', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  let readCount = 0;
  client.request = async (method) => {
    if (method === 'turn/start') {
      setTimeout(() => {
        client.emit('notification', {
          method: 'item/started',
          params: {
            turnId: 'turn-1',
            item: {
              id: 'item-1',
              type: 'message',
              role: 'assistant',
              phase: 'final_answer',
            },
          },
        });
        client.emit('notification', {
          method: 'item/message/delta',
          params: {
            turnId: 'turn-1',
            itemId: 'item-1',
            delta: '半截最终答案',
          },
        });
      }, 5);
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      readCount += 1;
      return {
        thread: {
          id: 'thread-1',
          name: 'Thread 1',
          turns: [{
            id: 'turn-1',
            status: 'completed',
            items: [{
              type: 'message',
              role: 'assistant',
              phase: 'commentary',
              text: '我先看一下。',
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
    timeoutMs: 12000,
  });

  assert.equal(result.outputText, '');
  assert.equal(result.outputState, 'partial');
  assert.equal(result.previewText, '半截最终答案');
  assert.equal(result.finalSource, 'progress_only');
  assert.ok(readCount >= 3);
});

test('CodexAppClient returns missing when neither thread items nor progress expose a final answer', async () => {
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
      return {
        thread: {
          id: 'thread-1',
          name: 'Thread 1',
          turns: [{
            id: 'turn-1',
            status: 'completed',
            items: [],
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
    timeoutMs: 12000,
  });

  assert.equal(result.outputText, '');
  assert.equal(result.outputState, 'missing');
  assert.equal(result.previewText, '');
  assert.equal(result.finalSource, 'none');
  assert.ok(readCount >= 3);
});

test('CodexAppClient keeps waiting and times out instead of returning missing when assistant activity exists without a final answer', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  client.request = async (method) => {
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
              type: 'message',
              role: 'assistant',
              phase: 'commentary',
              text: '我先看一下。',
            }],
          }],
        },
      };
    }
    return {};
  };

  await assert.rejects(
    client.startTurn({
      threadId: 'thread-1',
      inputText: 'hello',
      model: 'gpt-5.4',
      effort: null,
      collaborationMode: 'default',
      timeoutMs: 2500,
    }),
    /Timed out waiting for Codex turn turn-1/,
  );
});


test('CodexAppClient returns interrupted when terminal turn reports interruption without final output', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  client.request = async (method) => {
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
            status: 'interrupted',
            error: 'Conversation interrupted',
            items: [{
              type: 'message',
              role: 'assistant',
              phase: 'commentary',
              text: '我先看一下。',
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
    timeoutMs: 12000,
  });

  assert.equal(result.outputText, '');
  assert.equal(result.outputState, 'interrupted');
  assert.equal(result.previewText, '');
  assert.equal(result.finalSource, 'none');
});
