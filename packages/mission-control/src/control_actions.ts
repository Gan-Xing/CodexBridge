import { createMissionRetryAggregate } from './domain_records.js';
import type { Mission } from './types.js';

const RESUMABLE_CONTROL_STATUS_SET = new Set<Mission['status']>([
  'waiting_user',
  'needs_human',
  'handoff',
  'blocked',
  'stopped',
  'failed',
]);

const RETRY_REUSE_CONTEXT_STATUS_SET = new Set<Mission['status']>([
  'waiting_user',
  'needs_human',
  'handoff',
  'blocked',
]);

export interface CreateMissionRetrySnapshotOptions {
  at?: number;
  reason?: string | null;
  bridgeSessionId?: string | null;
  codexThreadId?: string | null;
  workflowPath?: string | null;
  workspacePath?: string | null;
}

export interface CreateMissionResumeSnapshotOptions {
  at?: number;
  reason?: string | null;
}

export function createMissionRetrySnapshot(
  mission: Mission,
  options: CreateMissionRetrySnapshotOptions = {},
): Mission {
  if (mission.status === 'archived') {
    throw new Error(`mission ${mission.id} cannot be retried from status archived`);
  }
  return createMissionRetryAggregate(mission, options).mission;
}

export function createMissionResumeSnapshot(
  mission: Mission,
  options: CreateMissionResumeSnapshotOptions = {},
): Mission {
  if (!RESUMABLE_CONTROL_STATUS_SET.has(mission.status)) {
    throw new Error(`mission ${mission.id} cannot be resumed from status ${mission.status}`);
  }
  const at = options.at ?? Date.now();
  return {
    ...mission,
    status: 'queued',
    activeAttemptId: null,
    stoppedAt: null,
    lastError: null,
    statusReason: normalizeText(options.reason) ?? 'Mission queued to continue after human input.',
    pendingApproval: null,
    lease: null,
    workpad: {
      ...mission.workpad,
      latestBlocker: null,
      latestVerifierSummary: null,
      updatedAt: at,
    },
    updatedAt: at,
  };
}

export function shouldMissionRetryReuseAccumulatedContext(mission: Mission): boolean {
  return RETRY_REUSE_CONTEXT_STATUS_SET.has(mission.status);
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
