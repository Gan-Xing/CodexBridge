import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Mission } from './types.js';

export type MissionWorkspaceMode = 'isolated' | 'shared-cwd';

export interface MissionWorkspaceLayout {
  rootDir: string;
  workflowsDir: string;
  workspacesDir: string;
  artifactsDir: string;
  logsDir: string;
}

export interface MissionWorkspaceEnvironmentStamp {
  host: string;
  mode: MissionWorkspaceMode;
  cwd: string | null;
  workspacePath: string;
  artifactsPath: string;
  logPath: string;
  workflowPath: string | null;
  generatedAt: number;
}

export interface MissionWorkspaceAssignment {
  mode: MissionWorkspaceMode;
  layout: MissionWorkspaceLayout;
  workspacePath: string;
  artifactsPath: string;
  logPath: string;
  workflowPath: string | null;
  environmentStamp: MissionWorkspaceEnvironmentStamp;
}

export interface MissionWorkspaceServiceOptions {
  rootDir?: string;
  host?: string;
  now?: () => number;
}

export interface EnsureMissionWorkspaceOptions {
  readOnly?: boolean;
  allowSharedCwd?: boolean;
}

export class MissionWorkspaceService {
  private readonly rootDir: string;

  private readonly host: string;

  private readonly now: () => number;

  constructor({
    rootDir = defaultMissionWorkspaceRoot(),
    host = os.hostname(),
    now = () => Date.now(),
  }: MissionWorkspaceServiceOptions = {}) {
    this.rootDir = rootDir;
    this.host = host;
    this.now = now;
  }

  getLayout(): MissionWorkspaceLayout {
    return {
      rootDir: this.rootDir,
      workflowsDir: path.join(this.rootDir, 'workflows'),
      workspacesDir: path.join(this.rootDir, 'workspaces'),
      artifactsDir: path.join(this.rootDir, 'artifacts'),
      logsDir: path.join(this.rootDir, 'logs'),
    };
  }

  ensureWorkspace(
    mission: Mission,
    options: EnsureMissionWorkspaceOptions = {},
  ): MissionWorkspaceAssignment {
    const layout = this.getLayout();
    ensureDirectory(layout.rootDir);
    ensureDirectory(layout.workflowsDir);
    ensureDirectory(layout.workspacesDir);
    ensureDirectory(layout.artifactsDir);
    ensureDirectory(layout.logsDir);

    const mode = shouldReuseBoundCwd(mission, options) ? 'shared-cwd' : 'isolated';
    const workspacePath = mode === 'shared-cwd'
      ? mission.cwd!
      : path.join(layout.workspacesDir, sanitizePathComponent(mission.id));
    if (mode === 'isolated') {
      ensureDirectory(workspacePath);
    }

    const artifactsPath = path.join(layout.artifactsDir, sanitizePathComponent(mission.id));
    ensureDirectory(artifactsPath);

    const logPath = path.join(layout.logsDir, `${sanitizePathComponent(mission.id)}.jsonl`);

    return {
      mode,
      layout,
      workspacePath,
      artifactsPath,
      logPath,
      workflowPath: mission.workflowPath ?? null,
      environmentStamp: {
        host: this.host,
        mode,
        cwd: mission.cwd,
        workspacePath,
        artifactsPath,
        logPath,
        workflowPath: mission.workflowPath ?? null,
        generatedAt: this.now(),
      },
    };
  }
}

export function defaultMissionWorkspaceRoot(): string {
  return path.join(os.homedir(), '.codexbridge', 'mission');
}

function shouldReuseBoundCwd(
  mission: Mission,
  options: EnsureMissionWorkspaceOptions,
): boolean {
  return Boolean(options.readOnly && options.allowSharedCwd && mission.cwd);
}

function ensureDirectory(targetPath: string): void {
  fs.mkdirSync(targetPath, { recursive: true });
}

function sanitizePathComponent(value: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return 'mission';
  }
  return normalized.replace(/[^a-zA-Z0-9._-]+/g, '-');
}
