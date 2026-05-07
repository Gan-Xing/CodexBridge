import { createMissionRetryAggregate } from './domain_records.js';
import { transitionMission } from './state_machine.js';
import type { Mission, MissionStopRequest } from './types.js';

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

const IMMEDIATE_STOP_STATUS_SET = new Set<Mission['status']>([
  'draft',
  'awaiting_checklist_confirm',
  'awaiting_prompt_confirm',
  'queued',
  'waiting_user',
  'needs_human',
  'scope_change_pending',
  'handoff',
  'blocked',
]);

const STOP_REQUESTABLE_STATUS_SET = new Set<Mission['status']>([
  'draft',
  'awaiting_checklist_confirm',
  'awaiting_prompt_confirm',
  'queued',
  'planning',
  'running',
  'verifying',
  'repairing',
  'waiting_user',
  'needs_human',
  'scope_change_pending',
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
  responseText?: string | null;
}

export interface CreateMissionStopRequestOptions {
  at?: number;
  requestId?: string | null;
  actorId?: string | null;
  actorType?: MissionStopRequest['actorType'] | null;
  reason?: string | null;
}

export interface MaterializeMissionStopOptions {
  at?: number;
  reason?: string | null;
  lastError?: string | null;
  activeAttemptId?: string | null;
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
  const responseText = normalizeText(options.responseText);
  const responseNote = responseText ? `Human response: ${responseText}` : null;
  const workpadNotes = [...mission.workpad.notes];
  if (responseNote && workpadNotes[workpadNotes.length - 1] !== responseNote) {
    workpadNotes.push(responseNote);
  }
  return {
    ...mission,
    status: 'queued',
    activeAttemptId: null,
    stoppedAt: null,
    lastError: null,
    statusReason: normalizeText(options.reason) ?? 'Mission queued to continue after human input.',
    stopRequest: null,
    pendingApproval: null,
    lease: null,
    workpad: {
      ...mission.workpad,
      summary: responseText ? 'Mission queued after human response.' : mission.workpad.summary,
      latestBlocker: null,
      latestVerifierSummary: null,
      notes: workpadNotes,
      updatedAt: at,
    },
    updatedAt: at,
  };
}

export function shouldMissionRetryReuseAccumulatedContext(mission: Mission): boolean {
  return RETRY_REUSE_CONTEXT_STATUS_SET.has(mission.status);
}

export function canMissionRequestStop(mission: Mission): boolean {
  return STOP_REQUESTABLE_STATUS_SET.has(mission.status);
}

export function shouldMissionStopImmediately(mission: Mission): boolean {
  return IMMEDIATE_STOP_STATUS_SET.has(mission.status);
}

export function createMissionStopRequest(
  mission: Mission,
  options: CreateMissionStopRequestOptions = {},
): Mission {
  if (!canMissionRequestStop(mission)) {
    return mission;
  }
  const at = options.at ?? Date.now();
  const stopRequest: MissionStopRequest = {
    requestId: normalizeText(options.requestId) ?? null,
    actorId: normalizeText(options.actorId) ?? null,
    actorType: options.actorType === 'user' || options.actorType === 'host' || options.actorType === 'system'
      ? options.actorType
      : 'system',
    reason: normalizeText(options.reason) ?? 'Mission stop requested.',
    requestedAt: at,
  };
  return {
    ...mission,
    stopRequest,
    updatedAt: at,
  };
}

export function materializeMissionStop(
  mission: Mission,
  options: MaterializeMissionStopOptions = {},
): Mission {
  if (mission.status === 'stopped') {
    const at = options.at ?? Date.now();
    const reason = normalizeText(options.reason) ?? resolveMissionStopReason(mission);
    return {
      ...mission,
      stopRequest: null,
      statusReason: reason,
      lastError: options.lastError !== undefined ? options.lastError : (mission.lastError ?? reason),
      activeAttemptId: options.activeAttemptId !== undefined ? options.activeAttemptId : mission.activeAttemptId,
      updatedAt: at,
    };
  }
  const reason = normalizeText(options.reason) ?? resolveMissionStopReason(mission);
  return transitionMission(mission, 'stopped', {
    at: options.at,
    reason,
    stopRequest: null,
    activeAttemptId: options.activeAttemptId !== undefined ? options.activeAttemptId : mission.activeAttemptId,
    lastError: options.lastError !== undefined ? options.lastError : (mission.lastError ?? reason),
  });
}

export function resolveMissionStopReason(mission: Pick<Mission, 'stopRequest' | 'statusReason'>): string {
  return normalizeText(mission.stopRequest?.reason)
    ?? normalizeText(mission.statusReason)
    ?? 'Mission stopped.';
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
