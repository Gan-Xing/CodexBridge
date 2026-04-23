import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexAppClient } from '../../../src/providers/codex/app_client.js';
import type { CodexTurnInput } from '../../../src/providers/codex/app_client.js';

function expectedProviderNativeImageArtifact(imagePath: string, sizeBytes: number) {
  return {
    kind: 'image',
    path: imagePath,
    displayName: path.basename(imagePath),
    mimeType: 'image/png',
    sizeBytes,
    caption: null,
    source: 'provider_native' as const,
    turnId: null,
  };
}

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
  assert.equal(turnStart.personality, null);
});

test('CodexAppClient startTurn forwards explicit local-image input arrays unchanged', async () => {
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

  const input: CodexTurnInput[] = [
    { type: 'text', text: 'inspect attachment', text_elements: [] },
    { type: 'localImage', path: '/tmp/example.png' },
  ];

  await client.startTurn({
    threadId: 'thread-1',
    inputText: 'hello',
    input,
    model: 'gpt-5.4',
    effort: 'medium',
    collaborationMode: 'default',
    timeoutMs: 10,
  });

  const turnStart = calls.find(([method]) => method === 'turn/start')?.[1];
  assert.deepEqual(turnStart.input, input);
});

test('CodexAppClient startServer enables image generation when spawning app-server', async () => {
  const calls = [];
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    exitCode: number | null;
  };
  child.stderr = new EventEmitter();
  child.exitCode = 0;

  const client = new CodexAppClient({
    codexCliBin: 'codex',
    spawnImpl: ((command, args, options) => {
      calls.push({ command, args, options });
      return child as any;
    }) as any,
  });

  client.connectWebSocket = async () => {
    client.connected = true;
  };
  client.initialize = async () => {};

  await client.startServer();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, 'codex');
  assert.equal(calls[0]?.args?.[0], 'app-server');
  assert.deepEqual(calls[0]?.args?.slice(1, 4), ['--enable', 'image_generation', '--listen']);
  assert.match(String(calls[0]?.args?.[4]), /^ws:\/\/127\.0\.0\.1:\d+$/);
});

test('CodexAppClient startServer wraps Windows cmd launchers through cmd.exe', async () => {
  const calls = [];
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    exitCode: number | null;
  };
  child.stderr = new EventEmitter();
  child.exitCode = 0;

  const client = new CodexAppClient({
    codexCliBin: 'C:\\Program Files\\Codex\\codex.cmd',
    platform: 'win32',
    spawnImpl: ((command, argsOrOptions, maybeOptions) => {
      calls.push({
        command,
        args: Array.isArray(argsOrOptions) ? argsOrOptions : null,
        options: Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions,
      });
      return child as any;
    }) as any,
  });

  client.connectWebSocket = async () => {
    client.connected = true;
  };
  client.initialize = async () => {};

  await client.startServer();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.args, null);
  assert.equal(calls[0]?.options?.shell, true);
  assert.equal(calls[0]?.options?.windowsHide, true);
  assert.match(String(calls[0]?.command), /^"C:\\Program Files\\Codex\\codex\.cmd" app-server --enable image_generation --listen ws:\/\/127\.0\.0\.1:\d+$/);
});

test('CodexAppClient startServer surfaces a helpful Windows Codex ENOENT error', async () => {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    exitCode: number | null;
  };
  child.stderr = new EventEmitter();
  child.exitCode = null;

  const client = new CodexAppClient({
    codexCliBin: 'codex',
    platform: 'win32',
    spawnImpl: (() => {
      setImmediate(() => {
        const error = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
        child.emit('error', error);
      });
      return child as any;
    }) as any,
  });

  client.connectWebSocket = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    throw client.childStartError ?? new Error('missing child start error');
  };
  client.initialize = async () => {};

  await assert.rejects(
    client.startServer(),
    /Failed to launch Codex app-server with "codex": command not found\..*CODEX_REAL_BIN.*codex\.exe/u,
  );
});

test('CodexAppClient stores command approval requests emitted by the app-server', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });
  const seen: any[] = [];
  client.on('approval_request', (request) => {
    seen.push(request);
  });

  client.handleMessage(JSON.stringify({
    jsonrpc: '2.0',
    id: 'approval-rpc-1',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      reason: 'command failed; retry without sandbox?',
      command: 'npm run build',
      cwd: '/home/ubuntu/dev/CodexBridge',
      availableDecisions: ['accept', 'acceptForSession', 'decline'],
    },
  }));

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    requestId: 'approval-rpc-1',
    kind: 'command',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    reason: 'command failed; retry without sandbox?',
    command: 'npm run build',
    cwd: '/home/ubuntu/dev/CodexBridge',
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
    execPolicyAmendment: null,
    networkPermission: null,
    fileReadPermissions: [],
    fileWritePermissions: [],
  });
});

test('CodexAppClient responds to remembered command approvals with acceptForSession', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });
  const sent: any[] = [];
  client.send = (payload: any) => {
    sent.push(payload);
  };

  client.handleMessage(JSON.stringify({
    jsonrpc: '2.0',
    id: 'approval-rpc-2',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-2',
      turnId: 'turn-2',
      itemId: 'item-2',
      reason: 'command failed; retry without sandbox?',
      command: 'npm run build',
      cwd: '/home/ubuntu/dev/CodexBridge',
      availableDecisions: ['accept', 'acceptForSession', 'decline'],
    },
  }));

  await client.respondToApproval({
    requestId: 'approval-rpc-2',
    option: 2,
  });

  assert.deepEqual(sent, [{
    jsonrpc: '2.0',
    id: 'approval-rpc-2',
    result: {
      decision: 'acceptForSession',
    },
  }]);
});

test('CodexAppClient keeps waiting past the nominal timeout while an approval request is pending', async () => {
  let now = 0;
  let approvalSent = false;
  const client = new CodexAppClient({
    codexCliBin: 'codex',
    turnPollNow: () => now,
    turnPollSleep: async (ms) => {
      now += ms;
    },
  });

  client.request = async (method) => {
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      if (!approvalSent) {
        approvalSent = true;
        queueMicrotask(() => {
          client.handleMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: 'approval-rpc-3',
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'item-3',
              reason: 'command failed; retry without sandbox?',
              command: 'npm run build',
              availableDecisions: ['accept', 'decline'],
            },
          }));
        });
      }
      const completed = now >= 150;
      return {
        thread: {
          id: 'thread-1',
          name: 'Thread 1',
          turns: [{
            id: 'turn-1',
            status: completed ? 'completed' : 'running',
            items: completed
              ? [{ type: 'assistant_message', text: 'done after approval wait' }]
              : [],
          }],
        },
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  const result = await client.startTurn({
    threadId: 'thread-1',
    inputText: 'hello',
    timeoutMs: 100,
  });

  assert.equal(result.outputText, 'done after approval wait');
  assert.equal(client.getPendingApprovals({ threadId: 'thread-1', turnId: 'turn-1' }).length, 1);
});

test('CodexAppClient fails when an accepted approval produces no follow-up signal for minutes', async () => {
  let now = 0;
  let approvalSent = false;
  const sent: any[] = [];
  const client = new CodexAppClient({
    codexCliBin: 'codex',
    turnPollNow: () => now,
    turnPollSleep: async (ms) => {
      now += ms;
    },
  });
  client.send = (payload: any) => {
    sent.push(payload);
  };

  client.request = async (method) => {
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      if (!approvalSent) {
        approvalSent = true;
        queueMicrotask(async () => {
          client.handleMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: 'approval-rpc-4',
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'item-4',
              reason: 'retry without sandbox?',
              command: 'node resend-file.js',
              availableDecisions: ['accept', 'decline'],
            },
          }));
          await client.respondToApproval({
            requestId: 'approval-rpc-4',
            option: 1,
          });
        });
      }
      return {
        thread: {
          id: 'thread-1',
          name: 'Thread 1',
          turns: [{
            id: 'turn-1',
            status: 'inProgress',
            items: [{
              type: 'message',
              role: 'assistant',
              phase: 'commentary',
              text: 'waiting for the approved command to resume',
            }],
          }],
        },
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  await assert.rejects(
    client.startTurn({
      threadId: 'thread-1',
      inputText: 'hello',
      timeoutMs: 900_000,
    }),
    /Approval was accepted, but the approved command \(node resend-file\.js\) produced no follow-up signal/,
  );

  assert.deepEqual(sent, [{
    jsonrpc: '2.0',
    id: 'approval-rpc-4',
    result: {
      decision: 'accept',
    },
  }]);
  assert.ok(now >= 300_000);
  assert.ok(now < 900_000);
});

test('CodexAppClient does not fail slow approved commands before the idle limit elapses', async () => {
  let now = 0;
  let approvalSent = false;
  let completionNotified = false;
  const sent: any[] = [];
  const client = new CodexAppClient({
    codexCliBin: 'codex',
    turnPollNow: () => now,
    turnPollSleep: async (ms) => {
      now += ms;
    },
  });
  client.send = (payload: any) => {
    sent.push(payload);
  };

  client.request = async (method) => {
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      if (!approvalSent) {
        approvalSent = true;
        queueMicrotask(async () => {
          client.handleMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: 'approval-rpc-5',
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'item-5',
              reason: 'retry without sandbox?',
              command: 'node resend-file.js',
              availableDecisions: ['accept', 'decline'],
            },
          }));
          await client.respondToApproval({
            requestId: 'approval-rpc-5',
            option: 1,
          });
        });
      }
      if (now >= 240_000 && !completionNotified) {
        completionNotified = true;
        queueMicrotask(() => {
          client.handleMessage(JSON.stringify({
            jsonrpc: '2.0',
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: {
                id: 'item-5',
              },
            },
          }));
        });
      }
      const completed = now >= 241_000;
      return {
        thread: {
          id: 'thread-1',
          name: 'Thread 1',
          turns: [{
            id: 'turn-1',
            status: completed ? 'completed' : 'inProgress',
            items: completed
              ? [{
                type: 'assistant_message',
                text: 'done after slow approved command',
              }]
              : [{
                type: 'message',
                role: 'assistant',
                phase: 'commentary',
                text: 'slow command still running',
              }],
          }],
        },
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  const result = await client.startTurn({
    threadId: 'thread-1',
    inputText: 'hello',
    timeoutMs: 900_000,
  });

  assert.equal(result.outputText, 'done after slow approved command');
  assert.deepEqual(sent, [{
    jsonrpc: '2.0',
    id: 'approval-rpc-5',
    result: {
      decision: 'accept',
    },
  }]);
  assert.ok(now >= 241_000);
  assert.ok(now < 300_000);
});

test('CodexAppClient startTurn returns generated image outputs when thread items include saved paths', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  const imagePath = path.join(os.tmpdir(), `codexbridge-generated-${Date.now()}.png`);
  fs.writeFileSync(imagePath, 'png');

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
                type: 'assistant_message',
                text: '小狗图片已生成。',
              },
              {
                type: 'imageGeneration',
                savedPath: imagePath,
                result: 'https://cdn.example.com/generated-dog.png',
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
    inputText: '画一只小狗',
    timeoutMs: 10,
  });

  assert.equal(result.outputText, '小狗图片已生成。');
  assert.deepEqual(result.outputArtifacts, [
    expectedProviderNativeImageArtifact(imagePath, 3),
  ]);
  assert.deepEqual(result.outputMedia, [
    expectedProviderNativeImageArtifact(imagePath, 3),
  ]);

  fs.unlinkSync(imagePath);
});

test('CodexAppClient startTurn materializes inline image payloads to the saved path when the file is not present yet', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  const imagePath = path.join(os.tmpdir(), `codexbridge-inline-generated-${Date.now()}.png`);
  const inlinePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=';

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
              type: 'imageGeneration',
              savedPath: imagePath,
              result: inlinePngBase64,
            }],
          }],
        },
      };
    }
    return {};
  };

  const result = await client.startTurn({
    threadId: 'thread-1',
    inputText: '画一只小狗',
    timeoutMs: 10,
  });

  assert.equal(fs.existsSync(imagePath), true);
  assert.deepEqual(result.outputArtifacts, [
    expectedProviderNativeImageArtifact(imagePath, 68),
  ]);
  assert.deepEqual(result.outputMedia, [
    expectedProviderNativeImageArtifact(imagePath, 68),
  ]);

  fs.unlinkSync(imagePath);
});

test('CodexAppClient startTurn returns provider-native file artifacts when thread items expose saved paths', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  const reportPath = path.join(os.tmpdir(), `codexbridge-generated-report-${Date.now()}.pdf`);
  fs.writeFileSync(reportPath, 'pdf-output');

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
                type: 'assistant_message',
                text: '报告已生成。',
              },
              {
                type: 'output_file',
                savedPath: reportPath,
              },
            ],
          }],
        },
      };
    }
    return {};
  };

  try {
    const result = await client.startTurn({
      threadId: 'thread-1',
      inputText: '导出 PDF',
      timeoutMs: 10,
    });

    assert.equal(result.outputText, '报告已生成。');
    assert.deepEqual(result.outputArtifacts, [
      {
        kind: 'file',
        path: reportPath,
        displayName: path.basename(reportPath),
        mimeType: 'application/pdf',
        sizeBytes: 10,
        caption: null,
        source: 'provider_native',
        turnId: null,
      },
    ]);
    assert.deepEqual(result.outputMedia, []);
  } finally {
    fs.unlinkSync(reportPath);
  }
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

test('CodexAppClient forwards personality into turn/start payload', async () => {
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
    personality: 'none',
    collaborationMode: 'default',
    timeoutMs: 10,
  });

  const turnStart = calls.find(([method]) => method === 'turn/start')?.[1];
  assert.equal(turnStart.personality, 'none');
});

test('CodexAppClient notifies onTurnStarted before waiting for turn completion', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });
  const seen = [];

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
    onTurnStarted: async (meta) => {
      seen.push(meta);
    },
    timeoutMs: 10,
  });

  assert.equal(result.turnId, 'turn-1');
  assert.deepEqual(seen, [{
    turnId: 'turn-1',
    threadId: 'thread-1',
  }]);
});

test('CodexAppClient times out individual JSON-RPC requests and clears pending state', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });

  client.connected = true;
  client.socket = {} as unknown as WebSocket;
  client.send = (() => {}) as any;

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

test('CodexAppClient waits through transient empty session file errors before reading turn output', async () => {
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
        throw new Error('failed to load rollout `rollout.jsonl` for thread thread-1: empty session file');
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
  assert.equal(result.outputState, 'complete');
  assert.equal(result.finalSource, 'session_task_complete');
});

test('CodexAppClient falls back to session-log image generation artifacts when thread output stays empty', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-session-log-image-'));
  const sessionPath = path.join(sessionDir, 'rollout.jsonl');
  const imagePath = path.join(sessionDir, 'generated-dog.png');
  fs.writeFileSync(imagePath, 'png');
  fs.writeFileSync(sessionPath, [
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: 'turn-1',
      },
    }),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'image_generation_end',
        call_id: 'ig-1',
        status: 'generating',
        revised_prompt: 'a cute dog',
        result: 'inline-image',
        saved_path: imagePath,
      },
    }),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-1',
        last_agent_message: null,
      },
    }),
  ].join('\n') + '\n', 'utf8');

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
            items: [{
              type: 'userMessage',
              text: '给我一张小狗图',
            }],
          }],
        },
      };
    }
    return {};
  };

  const result = await client.startTurn({
    threadId: 'thread-1',
    inputText: '给我一张小狗图',
    model: 'gpt-5.4',
    effort: null,
    collaborationMode: 'default',
    timeoutMs: 2500,
  });

  assert.equal(result.outputText, '');
  assert.equal(result.outputState, 'complete');
  assert.equal(result.finalSource, 'session_task_complete_media');
  assert.deepEqual(result.outputMedia, [expectedProviderNativeImageArtifact(imagePath, 3)]);
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
  assert.equal(result.outputState, 'complete');
  assert.equal(readCount, 4);
});

test('CodexAppClient keeps waiting for imageGeneration after task_complete lands without final text', async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-session-log-'));
  const sessionPath = path.join(sessionDir, 'rollout.jsonl');
  fs.writeFileSync(sessionPath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: 'turn-1',
    },
  })}\n`, 'utf8');

  const imagePath = path.join(sessionDir, 'generated-dog.png');
  fs.writeFileSync(imagePath, 'png');

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
      if (readCount < 4) {
        return {
          thread: {
            id: 'thread-1',
            name: 'Thread 1',
            path: sessionPath,
            turns: [{
              id: 'turn-1',
              status: 'completed',
              items: [{
                type: 'userMessage',
                text: '画一只小狗',
              }],
            }],
          },
        };
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
                text: '画一只小狗',
              },
              {
                type: 'imageGeneration',
                savedPath: imagePath,
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
    inputText: '画一只小狗',
    model: 'gpt-5.4',
    effort: null,
    collaborationMode: 'default',
    timeoutMs: 120_000,
  });

  assert.equal(result.outputText, '');
  assert.equal(result.outputState, 'complete');
  assert.equal(result.finalSource, 'thread_items_media');
  assert.deepEqual(result.outputMedia, [expectedProviderNativeImageArtifact(imagePath, 3)]);
  assert.equal(readCount, 4);
});

test('CodexAppClient keeps waiting for imageGeneration after task_complete lands with preview text', async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-session-log-preview-image-'));
  const sessionPath = path.join(sessionDir, 'rollout.jsonl');
  fs.writeFileSync(sessionPath, '', 'utf8');

  const imagePath = path.join(sessionDir, 'generated-dog.png');
  fs.writeFileSync(imagePath, 'png');

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
      if (readCount === 1) {
        fs.writeFileSync(sessionPath, `${JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-1',
            last_agent_message: '继续生成一张新的可爱小狗图片。',
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
            items: readCount >= 4
              ? [
                {
                  type: 'userMessage',
                  text: '画一只小狗',
                },
                {
                  type: 'imageGeneration',
                  savedPath: imagePath,
                },
              ]
              : [
                {
                  type: 'userMessage',
                  text: '画一只小狗',
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
    inputText: '画一只小狗',
    model: 'gpt-5.4',
    effort: null,
    collaborationMode: 'default',
    timeoutMs: 120_000,
  });

  assert.equal(result.outputText, '');
  assert.equal(result.outputState, 'complete');
  assert.equal(result.finalSource, 'thread_items_media');
  assert.deepEqual(result.outputMedia, [expectedProviderNativeImageArtifact(imagePath, 3)]);
  assert.equal(readCount, 4);
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

test('CodexAppClient waits for task_complete before returning missing for terminal turns backed by a session log', async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-session-log-missing-wait-'));
  const sessionPath = path.join(sessionDir, 'rollout.jsonl');
  fs.writeFileSync(sessionPath, '', 'utf8');

  let nowMs = 0;
  let readCount = 0;
  const client = new CodexAppClient({
    codexCliBin: 'codex',
    turnPollNow: () => nowMs,
    turnPollSleep: async () => {
      nowMs += 1000;
    },
  });

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
          path: sessionPath,
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

  assert.ok(readCount >= 2);
});

test('CodexAppClient does not treat inProgress turns as terminal task_complete waits', async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-session-log-inprogress-'));
  const sessionPath = path.join(sessionDir, 'rollout.jsonl');
  fs.writeFileSync(sessionPath, '', 'utf8');

  let nowMs = 0;
  let commentarySent = false;
  const debugEntries: string[] = [];
  const client = new CodexAppClient({
    codexCliBin: 'codex',
    logger: {
      debug(message) {
        debugEntries.push(String(message));
      },
    },
    turnPollNow: () => nowMs,
    turnPollSleep: async () => {
      nowMs += 1000;
    },
  });

  client.request = async (method) => {
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'thread/read') {
      if (!commentarySent) {
        commentarySent = true;
        queueMicrotask(() => {
          client.handleMessage(JSON.stringify({
            jsonrpc: '2.0',
            method: 'item/agentMessage/delta',
            params: {
              turnId: 'turn-1',
              itemId: 'item-1',
              phase: 'commentary',
              delta: 'still working',
            },
          }));
        });
      }
      return {
        thread: {
          id: 'thread-1',
          name: 'Thread 1',
          path: sessionPath,
          turns: [{
            id: 'turn-1',
            status: 'inProgress',
            items: [{
              type: 'message',
              role: 'assistant',
              phase: 'commentary',
              text: 'still working',
            }],
          }],
        },
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  };

  const result = await client.startTurn({
    threadId: 'thread-1',
    inputText: 'hello',
    model: 'gpt-5.4',
    effort: null,
    collaborationMode: 'default',
    timeoutMs: 2500,
  });

  assert.equal(result.outputText, '');
  assert.equal(result.outputState, 'partial');
  assert.equal(result.previewText, 'still working');
  assert.equal(result.finalSource, 'commentary_only');
  assert.equal(debugEntries.some((entry) => entry.includes('turn_terminal_state')), false);
  assert.equal(debugEntries.some((entry) => entry.includes('waiting_for_session_task_complete')), false);
});

test('CodexAppClient returns missing only after session task_complete lands without final text or artifacts', async () => {
  const client = new CodexAppClient({
    codexCliBin: 'codex',
  });
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-session-log-empty-complete-'));
  const sessionPath = path.join(sessionDir, 'rollout.jsonl');
  fs.writeFileSync(sessionPath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: 'turn-1',
      last_agent_message: null,
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
            items: [{
              type: 'userMessage',
              text: 'hello',
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

  assert.equal(result.outputText, '');
  assert.equal(result.outputState, 'missing');
  assert.equal(result.previewText, '');
  assert.equal(result.finalSource, 'session_task_complete_empty');
});

test('CodexAppClient returns partial commentary instead of timing out when assistant activity exists without a final answer', async () => {
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

  const result = await client.startTurn({
    threadId: 'thread-1',
    inputText: 'hello',
    model: 'gpt-5.4',
    effort: null,
    collaborationMode: 'default',
    timeoutMs: 2500,
  });

  assert.equal(result.outputText, '');
  assert.equal(result.outputState, 'partial');
  assert.equal(result.previewText, '我先看一下。');
  assert.equal(result.finalSource, 'commentary_only');
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
