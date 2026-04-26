import fs from 'node:fs';
import path from 'node:path';
import type { ProviderProfile } from '../../types/provider.js';

interface CodexProviderConfig {
  cliBin: string;
  launchCommand: string | null;
  autolaunch: boolean;
  defaultModel: string | null;
  providerLabel: string;
  backendBaseUrl: string | null;
  modelCatalogPath: string | null;
  modelCatalog: unknown[];
  modelCatalogMode: 'merge' | 'overlay-only';
}

type CodexProviderProfile = ProviderProfile & {
  providerKind: string;
  config: CodexProviderConfig;
};

interface CodexProfilesConfig {
  profiles: CodexProviderProfile[];
  defaultProviderProfileId: string;
}

interface CodexConfigLoadOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function loadCodexProfilesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  {
    platform = process.platform,
    cwd = process.cwd(),
  }: CodexConfigLoadOptions = {},
): CodexProfilesConfig {
  const codexRealBin = resolveConfiguredCommand(normalizeString(env.CODEX_REAL_BIN), {
    platform,
    env,
    cwd,
  }) ?? resolveCommand('codex', {
    platform,
    env,
    cwd,
  }) ?? 'codex';
  const codexProxyBin = resolveConfiguredCommand(normalizeString(env.CODEX_CLI_BIN), {
    platform,
    env,
    cwd,
  }) ?? codexRealBin;
  const modelCatalogPath = normalizeString(env.CODEX_MODEL_CATALOG_PATH);
  const now = Date.now();
  const profiles: CodexProviderProfile[] = [
    {
      id: 'openai-default',
      providerKind: 'openai-native',
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
      createdAt: now,
      updatedAt: now,
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
      providerKind: 'minimax-via-cliproxy',
      displayName: normalizeString(env.CODEX_PROVIDER_NAME) ?? 'Codex Proxy Profile',
      config: {
        cliBin: resolveConfiguredCommand(normalizeString(env.CODEX_PROXY_BIN), {
          platform,
          env,
          cwd,
        }) ?? codexProxyBin,
        launchCommand: normalizeString(env.CODEX_APP_LAUNCH_CMD),
        autolaunch: parseBoolean(env.CODEX_APP_AUTOLAUNCH, false),
        defaultModel: normalizeString(env.CODEX_PROVIDER_DEFAULT_MODEL),
        providerLabel: normalizeString(env.CODEX_PROVIDER_ID) ?? 'cliproxyminimax',
        backendBaseUrl: normalizeString(env.CODEX_PROVIDER_BASE_URL),
        modelCatalogPath,
        modelCatalog: loadModelCatalog(modelCatalogPath),
        modelCatalogMode: 'overlay-only',
      },
      createdAt: now,
      updatedAt: now,
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

export function resolveCommand(
  command: string,
  {
    platform = process.platform,
    env = process.env,
    cwd = process.cwd(),
  }: CodexConfigLoadOptions = {},
): string | null {
  const normalizedCommand = normalizeString(command);
  if (!normalizedCommand) {
    return null;
  }
  const explicit = resolveExplicitCommandPath(normalizedCommand, {
    platform,
    env,
    cwd,
  });
  if (explicit) {
    return explicit;
  }
  if (hasPathSeparator(normalizedCommand)) {
    return null;
  }
  const pathEntries = splitPathEntries(resolvePathValue(env));
  const suffixes = resolveCommandSuffixes(platform, env, normalizedCommand);
  for (const entry of pathEntries) {
    for (const suffix of suffixes) {
      const candidate = path.join(entry, `${normalizedCommand}${suffix}`);
      if (isCommandFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function loadModelCatalog(modelCatalogPath: string | null): unknown[] {
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

function normalizeString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return String(value).trim() !== 'false' && String(value).trim() !== '0';
}

function resolveConfiguredCommand(
  command: string | null,
  options: Required<CodexConfigLoadOptions>,
): string | null {
  if (!command) {
    return null;
  }
  return resolveCommand(command, options) ?? command;
}

function resolveExplicitCommandPath(
  command: string,
  {
    platform,
    env,
    cwd,
  }: {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    cwd: string;
  },
): string | null {
  if (!hasPathSeparator(command)) {
    return null;
  }
  const hostCommand = normalizeCommandPathForHost(command, platform);
  const basePath = path.isAbsolute(hostCommand)
    ? hostCommand
    : path.resolve(cwd, hostCommand);
  for (const candidate of buildExplicitCandidates(basePath, platform, env)) {
    if (isCommandFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function normalizeCommandPathForHost(command: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32' || path.sep !== '/') {
    return command;
  }
  return command.replace(/\\/gu, '/');
}

function buildExplicitCandidates(
  filePath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  const candidates = [filePath];
  if (platform !== 'win32' || path.extname(filePath)) {
    return candidates;
  }
  for (const suffix of resolveWindowsExecutableSuffixes(env)) {
    candidates.push(`${filePath}${suffix}`);
  }
  return unique(candidates);
}

function resolveCommandSuffixes(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  command: string,
): string[] {
  if (platform !== 'win32' || path.extname(command)) {
    return [''];
  }
  return resolveWindowsExecutableSuffixes(env);
}

function resolveWindowsExecutableSuffixes(env: NodeJS.ProcessEnv): string[] {
  const raw = normalizeString(env.PATHEXT);
  const preferred = ['.exe', '.cmd', '.bat', '.com'];
  const allowed = new Set(preferred);
  const suffixes = (raw?.split(';') ?? ['.EXE', '.CMD', '.BAT', '.COM'])
    .map((value) => value.trim().toLowerCase())
    .filter((value) => allowed.has(value));
  return unique([...(preferred), ...(suffixes.length > 0 ? suffixes : preferred)]);
}

function splitPathEntries(value: string | undefined): string[] {
  return String(value ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function resolvePathValue(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? (env as NodeJS.ProcessEnv & { Path?: string }).Path ?? (env as NodeJS.ProcessEnv & { path?: string }).path;
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\') || /^[a-z]:/iu.test(value);
}

function isCommandFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
