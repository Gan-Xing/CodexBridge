import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCodexGatewayStandaloneServerConfigFromEnv,
  createCodexGatewayStandaloneServerFromEnv,
} from '../src/index.js';

test('standalone server config resolves preset aliases and capability overrides from env', () => {
  const config = createCodexGatewayStandaloneServerConfigFromEnv({
    CODEX_GATEWAY_CAPABILITY_PRESET: 'qwen',
    DASHSCOPE_API_KEY: 'dashscope-key',
    DASHSCOPE_BASE_URL: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    DASHSCOPE_MODEL: 'qwen-plus-latest',
    CODEX_GATEWAY_CAPABILITY_OVERRIDES_JSON: JSON.stringify({
      supportsBuiltinWebSearchTool: true,
    }),
  });

  assert.equal(config.presetId, 'qwen');
  assert.equal(config.apiKey, 'dashscope-key');
  assert.equal(config.upstreamBaseUrl, 'https://dashscope-us.aliyuncs.com/compatible-mode/v1');
  assert.equal(config.defaultModel, 'qwen-plus-latest');
  assert.equal(config.providerName, 'Qwen');
  assert.equal(config.modelCatalogSource, 'preset');
  assert.equal(config.providerCapabilities?.supportsBuiltinWebSearchTool, true);
});

test('standalone server config loads inline external model catalogs from env JSON', async () => {
  const { config, server } = createCodexGatewayStandaloneServerFromEnv({
    CODEX_GATEWAY_CAPABILITY_PRESET: 'openrouter',
    OPENROUTER_API_KEY: 'openrouter-key',
    CODEX_GATEWAY_MODEL: 'openai/gpt-4.1-mini',
    CODEX_GATEWAY_MODEL_CATALOG_JSON: JSON.stringify({
      openrouter: [{
        id: 'openai/gpt-4.1-mini',
        display_name: 'OpenAI GPT-4.1 Mini',
        max_completion_tokens: 12345,
      }],
    }),
  });

  assert.equal(config.modelCatalogSource, 'json');
  assert.equal(config.models[0]?.id, 'openai/gpt-4.1-mini');
  assert.equal(config.providerCapabilities?.modelCapabilities?.['openai/gpt-4.1-mini']?.maxOutputTokens, 12345);

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/models`);
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.data[0].id, 'openai/gpt-4.1-mini');
    assert.equal(body.data[0].displayName, 'OpenAI GPT-4.1 Mini');
  } finally {
    await server.stop();
  }
});

test('standalone server config rejects empty external model catalogs', () => {
  assert.throws(
    () => createCodexGatewayStandaloneServerConfigFromEnv({
      CODEX_GATEWAY_CAPABILITY_PRESET: 'openrouter',
      OPENROUTER_API_KEY: 'openrouter-key',
      CODEX_GATEWAY_MODEL_CATALOG_JSON: JSON.stringify({ openrouter: [] }),
    }),
    /did not contain any model entries/,
  );
});
