import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OpenAICompatibleResponsesAdapterServer,
  reserveLocalPort,
} from '../src/index.js';

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
