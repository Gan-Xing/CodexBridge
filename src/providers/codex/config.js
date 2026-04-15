import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function loadCodexProfilesFromEnv(env = process.env) {
  const codexRealBin = normalizeString(env.CODEX_REAL_BIN) ?? resolveCommand('codex') ?? 'codex';
  const codexProxyBin = normalizeString(env.CODEX_CLI_BIN) ?? codexRealBin;
  const modelCatalogPath = normalizeString(env.CODEX_MODEL_CATALOG_PATH);
  const profiles = [
    {
      id: 'openai-default',
      providerKind: 'codex',
      displayName: 'Codex OpenAI',
      config: {
        cliBin: codexRealBin,
        launchCommand: normalizeString(env.CODEX_APP_LAUNCH_CMD),
        autolaunch: parseBoolean(env.CODEX_APP_AUTOLAUNCH, false),
        defaultModel: null,
        providerLabel: 'openai',
        backendBaseUrl: null,
        modelCatalogPath: null,
        modelCatalog: [],
        modelCatalogMode: 'merge',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];

  const shouldExposeProxyProfile = Boolean(
    normalizeString(env.CODEX_PROXY_BIN)
    || normalizeString(env.CODEX_PROVIDER_ID)
    || normalizeString(env.CODEX_PROVIDER_BASE_URL)
    || normalizeString(env.CODEX_PROVIDER_DEFAULT_MODEL)
    || modelCatalogPath
    || codexProxyBin !== codexRealBin,
  );

  if (shouldExposeProxyProfile) {
    profiles.push({
      id: normalizeString(env.CODEX_PROVIDER_ID) ?? 'cliproxyminimax',
      providerKind: 'codex',
      displayName: normalizeString(env.CODEX_PROVIDER_NAME) ?? 'Codex Proxy Profile',
      config: {
        cliBin: normalizeString(env.CODEX_PROXY_BIN) ?? codexProxyBin,
        launchCommand: normalizeString(env.CODEX_APP_LAUNCH_CMD),
        autolaunch: parseBoolean(env.CODEX_APP_AUTOLAUNCH, false),
        defaultModel: normalizeString(env.CODEX_PROVIDER_DEFAULT_MODEL),
        providerLabel: normalizeString(env.CODEX_PROVIDER_ID) ?? 'cliproxyminimax',
        backendBaseUrl: normalizeString(env.CODEX_PROVIDER_BASE_URL),
        modelCatalogPath,
        modelCatalog: loadModelCatalog(modelCatalogPath),
        modelCatalogMode: 'overlay-only',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  const requestedDefaultId = normalizeString(env.CODEX_DEFAULT_PROVIDER_PROFILE_ID);
  const defaultProviderProfileId = profiles.some((profile) => profile.id === requestedDefaultId)
    ? requestedDefaultId
    : profiles[0]?.id
      ?? 'openai-default';

  return {
    profiles,
    defaultProviderProfileId,
  };
}

export function resolveCommand(command) {
  const lookup = spawnSync('which', [command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (lookup.status !== 0) {
    return null;
  }
  const resolved = lookup.stdout.trim();
  return resolved || null;
}

function loadModelCatalog(modelCatalogPath) {
  if (!modelCatalogPath) {
    return [];
  }
  try {
    const resolvedPath = path.resolve(modelCatalogPath);
    if (!fs.existsSync(resolvedPath)) {
      return [];
    }
    const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function normalizeString(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  return String(value).trim() !== 'false' && String(value).trim() !== '0';
}
