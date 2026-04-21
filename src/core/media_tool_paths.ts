import fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const FALLBACK_FFMPEG = 'ffmpeg';
const FALLBACK_FFPROBE = 'ffprobe';

const bundledFfmpegPath = resolveBundledBinaryPath('ffmpeg-static', (mod) => {
  if (typeof mod === 'string' && mod.trim()) {
    return mod;
  }
  const defaultValue = getObjectProperty(mod, 'default');
  if (typeof defaultValue === 'string' && defaultValue.trim()) {
    return defaultValue;
  }
  return null;
});

const bundledFfprobePath = resolveBundledBinaryPath('ffprobe-static', (mod) => {
  const directPath = getObjectProperty(mod, 'path');
  if (typeof directPath === 'string' && directPath.trim()) {
    return directPath;
  }
  const defaultValue = getObjectProperty(mod, 'default');
  const defaultPath = getObjectProperty(defaultValue, 'path');
  if (typeof defaultPath === 'string' && defaultPath.trim()) {
    return defaultPath;
  }
  return null;
});

export function resolveFfmpegPath(): string {
  return resolveBinaryPath({
    primaryEnvVar: 'CODEXBRIDGE_FFMPEG_PATH',
    secondaryEnvVar: 'FFMPEG_PATH',
    bundledPath: bundledFfmpegPath,
    fallbackCommand: FALLBACK_FFMPEG,
  });
}

export function resolveFfprobePath(): string {
  return resolveBinaryPath({
    primaryEnvVar: 'CODEXBRIDGE_FFPROBE_PATH',
    secondaryEnvVar: 'FFPROBE_PATH',
    bundledPath: bundledFfprobePath,
    fallbackCommand: FALLBACK_FFPROBE,
  });
}

export function hasFfmpegTools(): boolean {
  return isExecutableAvailable(resolveFfmpegPath(), ['-version'])
    && isExecutableAvailable(resolveFfprobePath(), ['-version']);
}

function resolveBinaryPath(params: {
  primaryEnvVar: string;
  secondaryEnvVar: string;
  bundledPath: string | null;
  fallbackCommand: string;
}): string {
  const envOverride = readEnvPath(params.primaryEnvVar) ?? readEnvPath(params.secondaryEnvVar);
  if (envOverride) {
    return envOverride;
  }
  if (params.bundledPath && fs.existsSync(params.bundledPath)) {
    return params.bundledPath;
  }
  return params.fallbackCommand;
}

function readEnvPath(name: string): string | null {
  const value = String(process.env[name] ?? '').trim();
  return value || null;
}

function resolveBundledBinaryPath(
  packageName: string,
  extractPath: (moduleValue: unknown) => string | null,
): string | null {
  try {
    const moduleValue = require(packageName);
    const candidate = extractPath(moduleValue);
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // Keep runtime tolerant and fall back to PATH when the package is absent.
  }
  return null;
}

function getObjectProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function isExecutableAvailable(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return result.status === 0;
}
