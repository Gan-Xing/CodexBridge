import fs from 'node:fs';
import {
  buildOpenAICompatibleExternalModelCatalog,
  buildOpenAICompatibleModelCatalog,
  getOpenAICompatibleProviderPreset,
  OPENAI_COMPATIBLE_PROFILE_PRESET_REGISTRATIONS,
  type OpenAICompatibleCapabilityPresetId,
  type OpenAICompatibleProviderPreset,
} from '../capabilities/capability_presets.js';
import {
  mergeOpenAICompatibleProviderCapabilities,
  type OpenAICompatibleProviderCapabilities,
} from '../capabilities/thinking_policy.js';
import {
  OpenAICompatibleResponsesAdapterServer,
  type OpenAICompatibleResponsesAdapterServerOptions,
} from './responses_adapter_server.js';

type EnvRecord = Record<string, string | undefined>;

export interface CodexGatewayStandaloneServerConfig extends OpenAICompatibleResponsesAdapterServerOptions {
  presetId: OpenAICompatibleCapabilityPresetId;
  modelCatalogSource: 'preset' | 'json' | 'path';
}

export function createCodexGatewayStandaloneServerConfigFromEnv(
  env: EnvRecord = process.env,
): CodexGatewayStandaloneServerConfig {
  const preset = getOpenAICompatibleProviderPreset(normalizeString(env.CODEX_GATEWAY_CAPABILITY_PRESET) || 'default');
  const registration = OPENAI_COMPATIBLE_PROFILE_PRESET_REGISTRATIONS.find((entry) => entry.presetId === preset.id) ?? null;

  const apiKey = resolveConfiguredValue(env, [
    'CODEX_GATEWAY_API_KEY',
    preset.apiKeyEnv,
    registration?.alternativeApiKeyEnv,
  ]);
  if (!apiKey) {
    throw new Error(
      `Codex Gateway standalone server requires an API key. Set CODEX_GATEWAY_API_KEY or ${[
        preset.apiKeyEnv,
        registration?.alternativeApiKeyEnv,
      ].filter(Boolean).join(' / ')}.`,
    );
  }

  const upstreamBaseUrl = resolveConfiguredValue(env, [
    'CODEX_GATEWAY_BASE_URL',
    registration ? `${registration.envPrefix}_BASE_URL` : null,
    registration?.alternativeBaseUrlEnv,
  ]) || preset.baseUrl;

  const defaultModel = resolveConfiguredValue(env, [
    'CODEX_GATEWAY_MODEL',
    registration ? `${registration.envPrefix}_MODEL` : null,
    registration?.alternativeModelEnv,
  ]) || preset.defaultModel;

  const providerName = normalizeString(env.CODEX_GATEWAY_PROVIDER_NAME) || preset.displayName;
  const providerKind = normalizeString(env.CODEX_GATEWAY_PROVIDER_KIND) || 'openai-compatible';
  const ownedBy = normalizeString(env.CODEX_GATEWAY_OWNED_BY) || preset.ownedBy;
  const host = normalizeString(env.CODEX_GATEWAY_HOST) || '127.0.0.1';
  const port = normalizePort(env.CODEX_GATEWAY_PORT);
  const upstreamChatCompletionsPath = normalizeString(env.CODEX_GATEWAY_UPSTREAM_CHAT_PATH)
    || preset.upstreamChatCompletionsPath;

  const capabilityOverrides = parseOptionalJson(
    env.CODEX_GATEWAY_CAPABILITY_OVERRIDES_JSON,
    'CODEX_GATEWAY_CAPABILITY_OVERRIDES_JSON',
  );
  let providerCapabilities = mergeOpenAICompatibleProviderCapabilities(
    preset.capabilities,
    isRecord(capabilityOverrides) ? capabilityOverrides as OpenAICompatibleProviderCapabilities : null,
  );

  const inlineModelCatalog = parseOptionalJson(
    env.CODEX_GATEWAY_MODEL_CATALOG_JSON,
    'CODEX_GATEWAY_MODEL_CATALOG_JSON',
  );
  const modelCatalogPath = normalizeString(env.CODEX_GATEWAY_MODEL_CATALOG_PATH);
  const modelCatalogFromPath = modelCatalogPath
    ? parseJsonFile(modelCatalogPath, 'CODEX_GATEWAY_MODEL_CATALOG_PATH')
    : undefined;
  const modelCatalogRaw = inlineModelCatalog !== undefined ? inlineModelCatalog : modelCatalogFromPath;

  let modelCatalogSource: CodexGatewayStandaloneServerConfig['modelCatalogSource'] = 'preset';
  let models = buildOpenAICompatibleModelCatalog({
    defaultModel,
    modelIds: preset.modelIds,
    displayName: providerName,
    capabilities: providerCapabilities,
  });

  if (modelCatalogRaw !== undefined) {
    modelCatalogSource = inlineModelCatalog !== undefined ? 'json' : 'path';
    const externalCatalog = buildOpenAICompatibleExternalModelCatalog({
      raw: modelCatalogRaw,
      defaultModel,
      displayName: providerName,
      capabilities: providerCapabilities,
    });
    if (externalCatalog.catalog.length === 0) {
      throw new Error(
        `Codex Gateway standalone server received ${modelCatalogSource === 'json'
          ? 'CODEX_GATEWAY_MODEL_CATALOG_JSON'
          : 'CODEX_GATEWAY_MODEL_CATALOG_PATH'} but it did not contain any model entries.`,
      );
    }
    providerCapabilities = externalCatalog.capabilities;
    models = externalCatalog.catalog;
  }

  return {
    presetId: preset.id,
    modelCatalogSource,
    apiKey,
    upstreamBaseUrl,
    defaultModel,
    models,
    host,
    port,
    providerKind,
    providerName,
    providerCapabilities,
    upstreamChatCompletionsPath,
    ownedBy,
  };
}

export function createCodexGatewayStandaloneServerFromEnv(
  env: EnvRecord = process.env,
): {
  config: CodexGatewayStandaloneServerConfig;
  server: OpenAICompatibleResponsesAdapterServer;
} {
  const config = createCodexGatewayStandaloneServerConfigFromEnv(env);
  return {
    config,
    server: new OpenAICompatibleResponsesAdapterServer(config),
  };
}

function resolveConfiguredValue(env: EnvRecord, keys: Array<string | null | undefined>): string {
  for (const key of keys) {
    if (!key) {
      continue;
    }
    const value = normalizeString(env[key]);
    if (value) {
      return value;
    }
  }
  return '';
}

function parseOptionalJson(value: string | undefined, fieldName: string): unknown {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }
  try {
    return JSON.parse(normalized);
  } catch (error) {
    throw new Error(`${fieldName} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonFile(filePath: string, fieldName: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${fieldName} could not be loaded from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizePort(value: string | undefined): number {
  const normalized = normalizeString(value);
  if (!normalized) {
    return 0;
  }
  const port = Number.parseInt(normalized, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`CODEX_GATEWAY_PORT must be an integer between 0 and 65535. Received: ${normalized}`);
  }
  return port;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
