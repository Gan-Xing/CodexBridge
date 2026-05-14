import { execFileSync } from 'node:child_process';
import { createCodexCliLaunchSpec } from './cli_command.js';

export interface CodexExperimentalFeatureInfo {
  name: string;
  maturity: string;
  enabled: boolean;
}

export interface CodexExperimentalFeatureCatalogEntry {
  name: string;
  order: number;
}

interface CodexExperimentalFeaturesManagerOptions {
  execFileSyncImpl?: typeof execFileSync;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export class CodexExperimentalFeaturesManager {
  private readonly execFileSyncImpl: typeof execFileSync;

  private readonly env: NodeJS.ProcessEnv;

  private readonly platform: NodeJS.Platform;

  constructor({
    execFileSyncImpl = execFileSync,
    env = process.env,
    platform = process.platform,
  }: CodexExperimentalFeaturesManagerOptions = {}) {
    this.execFileSyncImpl = execFileSyncImpl;
    this.env = env;
    this.platform = platform;
  }

  async listFeatures({
    codexCliBin = 'codex',
  }: {
    codexCliBin?: string | null;
  } = {}): Promise<CodexExperimentalFeatureInfo[]> {
    const resolvedCliBin = normalizeCodexCliBin(codexCliBin);
    try {
      const output = this.execCodexCliSync(resolvedCliBin, ['features', 'list']);
      return parseCodexFeaturesListOutput(output);
    } catch {
      return [];
    }
  }

  async enableFeature(featureName: string, {
    codexCliBin = 'codex',
  }: {
    codexCliBin?: string | null;
  } = {}): Promise<void> {
    const resolvedCliBin = normalizeCodexCliBin(codexCliBin);
    this.execCodexCliSync(resolvedCliBin, ['features', 'enable', featureName], {
      stdio: 'pipe',
    });
  }

  async disableFeature(featureName: string, {
    codexCliBin = 'codex',
  }: {
    codexCliBin?: string | null;
  } = {}): Promise<void> {
    const resolvedCliBin = normalizeCodexCliBin(codexCliBin);
    this.execCodexCliSync(resolvedCliBin, ['features', 'disable', featureName], {
      stdio: 'pipe',
    });
  }

  private execCodexCliSync(
    codexCliBin: string,
    args: string[],
    options: { stdio?: 'pipe' } = {},
  ): string {
    const launchSpec = createCodexCliLaunchSpec({
      command: codexCliBin,
      args,
      platform: this.platform,
    });
    const execOptions = {
      encoding: 'utf8',
      env: this.env,
      ...options,
      ...launchSpec.options,
    };
    if (launchSpec.args) {
      return this.execFileSyncImpl(launchSpec.command, launchSpec.args, execOptions as any);
    }
    return (this.execFileSyncImpl as any)(launchSpec.command, execOptions);
  }
}

export function parseCodexFeaturesListOutput(output: string): CodexExperimentalFeatureInfo[] {
  return String(output ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseCodexFeatureListLine)
    .filter((entry): entry is CodexExperimentalFeatureInfo => entry !== null);
}

export function isVisibleCodexExperimentalFeature(feature: CodexExperimentalFeatureInfo): boolean {
  const maturity = normalizeCodexFeatureMaturity(feature.maturity);
  return maturity !== 'removed' && maturity !== 'deprecated';
}

const PUBLIC_CODEX_EXPERIMENTAL_FEATURES: readonly CodexExperimentalFeatureCatalogEntry[] = [
  { name: 'terminal_resize_reflow', order: 1 },
  { name: 'memories', order: 2 },
  { name: 'external_migration', order: 3 },
  { name: 'goals', order: 4 },
  { name: 'prevent_idle_sleep', order: 5 },
] as const;

const PUBLIC_CODEX_EXPERIMENTAL_FEATURE_ORDER = new Map(
  PUBLIC_CODEX_EXPERIMENTAL_FEATURES.map((feature) => [feature.name, feature.order]),
);

export function isPublicCodexExperimentalFeature(feature: CodexExperimentalFeatureInfo): boolean {
  return PUBLIC_CODEX_EXPERIMENTAL_FEATURE_ORDER.has(feature.name);
}

export function getPublicCodexExperimentalFeatures(
  features: readonly CodexExperimentalFeatureInfo[],
): CodexExperimentalFeatureInfo[] {
  return [...features]
    .filter((feature) => isVisibleCodexExperimentalFeature(feature) && isPublicCodexExperimentalFeature(feature))
    .sort((left, right) => {
      const leftOrder = PUBLIC_CODEX_EXPERIMENTAL_FEATURE_ORDER.get(left.name) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = PUBLIC_CODEX_EXPERIMENTAL_FEATURE_ORDER.get(right.name) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.name.localeCompare(right.name);
    });
}

function parseCodexFeatureListLine(line: string): CodexExperimentalFeatureInfo | null {
  const parts = line.split(/\t+|\s{2,}/u).map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 3) {
    return null;
  }
  const [name, maturity, enabled] = parts;
  if (!name) {
    return null;
  }
  return {
    name,
    maturity: maturity || 'unknown',
    enabled: enabled === 'true',
  };
}

function normalizeCodexCliBin(value: string | null | undefined): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || 'codex';
}

function normalizeCodexFeatureMaturity(value: string): string {
  return String(value ?? '').trim().toLowerCase();
}
