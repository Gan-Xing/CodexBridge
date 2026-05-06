import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OpenAICompatibleResponsesAdapterServer,
  reserveLocalPort,
} from '../src/index.js';

function createEventStreamResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
}

function parseSseText(text: string): Array<{ event: string; data: any }> {
  const blocks = text.split('\n\n').map((entry) => entry.trim()).filter(Boolean);
  const parsed: Array<{ event: string; data: any }> = [];
  for (const block of blocks) {
    const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    if (!eventLine || !dataLine) {
      continue;
    }
    parsed.push({
      event: eventLine.slice(7).trim(),
      data: JSON.parse(dataLine.slice(6)),
    });
  }
  return parsed;
}

test('adapter server is available from the package boundary', async () => {
  let fetchCalls = 0;
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    fetchImpl: (async () => {
      fetchCalls += 1;
      return new Response('{}');
    }) as typeof fetch,
    providerCapabilities: {
      supportsResponsesCompact: false,
      usage: {
        estimateWhenMissing: true,
      },
    },
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses/compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'example-model',
        input: 'hello',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(fetchCalls, 0);
    assert.equal(body.object, 'response.compaction');
    assert.equal(body.output[0].content[0].text, 'hello');
  } finally {
    await server.stop();
  }
});

test('adapter server exposes model metadata from package boundary', async () => {
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    models: [{
      id: 'example-model',
      capabilities: {
        tools: true,
        vision: false,
      },
    }],
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/models`);
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.data[0].id, 'example-model');
    assert.deepEqual(body.data[0].capabilities, {
      tools: true,
      vision: false,
    });
  } finally {
    await server.stop();
  }
});

test('reserveLocalPort is exported from the package boundary', async () => {
  const port = await reserveLocalPort();
  assert.equal(Number.isInteger(port), true);
  assert.equal(port > 0, true);
});

test('adapter server preserves previous_response_id in non-streaming responses', async () => {
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    fetchImpl: (async () => new Response(JSON.stringify({
      id: 'chatcmpl_prev_turn',
      created: 1_700_000_101,
      model: 'example-model',
      choices: [{
        message: {
          content: 'follow-up answer',
        },
      }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 4,
        total_tokens: 9,
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'example-model',
        previous_response_id: 'resp_parent_123',
        input: 'continue',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.previous_response_id, 'resp_parent_123');
    assert.equal(body.output[0].content[0].text, 'follow-up answer');
  } finally {
    await server.stop();
  }
});

test('adapter server streams codex-proxy style event ordering and keeps previous_response_id', async () => {
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    fetchImpl: (async () => createEventStreamResponse([
      {
        id: 'chatcmpl_stream_prev_turn',
        created: 1_700_000_102,
        model: 'stream-model',
        choices: [{
          index: 0,
          delta: {
            content: 'hello',
          },
        }],
      },
      {
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_stream_prev_1',
              function: {
                name: 'lookup',
                arguments: '{"q"',
              },
            }],
          },
        }],
      },
      {
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: {
                arguments: ':"x"}',
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 3,
          total_tokens: 7,
        },
      },
    ])) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'stream-model',
        previous_response_id: 'resp_parent_stream_1',
        input: 'continue stream',
        stream: true,
      }),
    });
    const text = await response.text();
    const events = parseSseText(text);
    const eventTypes = events.map((entry) => entry.event);

    const createdIndex = eventTypes.indexOf('response.created');
    const completedIndex = eventTypes.lastIndexOf('response.completed');
    const textDeltaIndex = eventTypes.indexOf('response.output_text.delta');
    const functionDeltaIndices = eventTypes
      .map((event, index) => event === 'response.function_call_arguments.delta' ? index : -1)
      .filter((index) => index >= 0);
    const outputDoneIndex = eventTypes.lastIndexOf('response.output_item.done');

    assert.equal(response.status, 200);
    assert.equal(createdIndex >= 0, true);
    assert.equal(textDeltaIndex > createdIndex, true);
    assert.equal(functionDeltaIndices.length >= 2, true);
    assert.equal(functionDeltaIndices[0] > textDeltaIndex, true);
    assert.equal(outputDoneIndex > functionDeltaIndices.at(-1), true);
    assert.equal(completedIndex > outputDoneIndex, true);

    const completedEvent = events.at(-1)?.data;
    assert.equal(completedEvent.response.previous_response_id, 'resp_parent_stream_1');
    assert.equal(completedEvent.response.output[1].type, 'function_call');
    assert.equal(completedEvent.response.output[1].arguments, '{"q":"x"}');
  } finally {
    await server.stop();
  }
});
