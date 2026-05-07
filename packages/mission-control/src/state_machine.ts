import type {
  CreateMissionInput,
  Mission,
  MissionLease,
  MissionPendingApproval,
  MissionStatus,
  MissionWorkpad,
} from './types.js';

export const MISSION_STATUS_TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = Object.freeze({
  draft: ['queued', 'stopped', 'archived'],
  queued: ['planning', 'running', 'stopped', 'archived'],
  planning: ['queued', 'running', 'blocked', 'failed', 'stopped'],
  running: ['verifying', 'repairing', 'waiting_user', 'needs_human', 'handoff', 'blocked', 'failed', 'stopped'],
  verifying: ['repairing', 'completed', 'failed', 'waiting_user', 'needs_human', 'handoff', 'blocked', 'stopped'],
  repairing: ['queued', 'running', 'waiting_user', 'needs_human', 'handoff', 'blocked', 'failed', 'stopped'],
  waiting_user: ['queued', 'running', 'stopped', 'archived'],
  needs_human: ['queued', 'running', 'stopped', 'archived'],
  handoff: ['queued', 'running', 'archived', 'stopped'],
  blocked: ['queued', 'running', 'needs_human', 'waiting_user', 'failed', 'stopped', 'archived'],
  completed: ['archived'],
  failed: ['queued', 'archived'],
  stopped: ['queued', 'archived'],
  archived: [],
});

const RESUMABLE_MISSION_STATUS_SET = new Set<MissionStatus>([
  'queued',
  'planning',
  'running',
  'verifying',
  'repairing',
  'handoff',
]);

export function createMissionWorkpad(now: number): MissionWorkpad {
  return {
    summary: null,
    latestPlan: [],
    latestBlocker: null,
    latestVerifierSummary: null,
    finalResultSummary: null,
    notes: [],
    updatedAt: now,
  };
}

export function createMission(input: CreateMissionInput): Mission {
  const now = input.now ?? Date.now();
  return {
    id: input.id,
    source: input.source,
    sourceRef: input.sourceRef ?? null,
    platform: input.platform,
    externalScopeId: input.externalScopeId,
    title: input.title,
    goal: input.goal,
    expectedOutput: input.expectedOutput,
    acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
    plan: [...(input.plan ?? [])],
    status: 'draft',
    priority: input.priority ?? 'normal',
    riskLevel: input.riskLevel ?? 'medium',
    cwd: input.cwd ?? null,
    workspacePath: input.workspacePath ?? null,
    workflowPath: input.workflowPath ?? null,
    providerProfileId: input.providerProfileId,
    bridgeSessionId: input.bridgeSessionId ?? null,
    codexThreadId: input.codexThreadId ?? null,
    activeAttemptId: null,
    attemptCount: 0,
    maxAttempts: input.maxAttempts ?? 1,
    maxTurns: input.maxTurns ?? 1,
    lastRunAt: null,
    completedAt: null,
    archivedAt: null,
    stoppedAt: null,
    lastResultPreview: null,
    resultText: null,
    resultArtifacts: [],
    lastError: null,
    statusReason: null,
    pendingApproval: null,
    lease: null,
    workpad: createMissionWorkpad(now),
    createdAt: now,
    updatedAt: now,
  };
}

export function canTransitionMissionStatus(from: MissionStatus, to: MissionStatus): boolean {
  return MISSION_STATUS_TRANSITIONS[from].includes(to);
}

export function assertMissionStatusTransition(from: MissionStatus, to: MissionStatus): void {
  if (!canTransitionMissionStatus(from, to)) {
    throw new Error(`invalid mission status transition: ${from} -> ${to}`);
  }
}

export interface TransitionMissionOptions {
  at?: number;
  reason?: string | null;
  pendingApproval?: MissionPendingApproval | null;
  lease?: MissionLease | null;
  activeAttemptId?: string | null;
  lastError?: string | null;
  lastResultPreview?: string | null;
  resultText?: string | null;
  resultArtifacts?: unknown[];
  workpad?: MissionWorkpad;
}

export function transitionMission(
  mission: Mission,
  nextStatus: MissionStatus,
  options: TransitionMissionOptions = {},
): Mission {
  assertMissionStatusTransition(mission.status, nextStatus);
  const at = options.at ?? Date.now();
  const next: Mission = {
    ...mission,
    status: nextStatus,
    updatedAt: at,
    statusReason: options.reason ?? mission.statusReason,
    pendingApproval: options.pendingApproval !== undefined ? options.pendingApproval : mission.pendingApproval,
    lease: options.lease !== undefined ? options.lease : mission.lease,
    activeAttemptId: options.activeAttemptId !== undefined ? options.activeAttemptId : mission.activeAttemptId,
    lastError: options.lastError !== undefined ? options.lastError : mission.lastError,
    lastResultPreview: options.lastResultPreview !== undefined ? options.lastResultPreview : mission.lastResultPreview,
    resultText: options.resultText !== undefined ? options.resultText : mission.resultText,
    resultArtifacts: options.resultArtifacts !== undefined ? [...options.resultArtifacts] : [...mission.resultArtifacts],
    workpad: options.workpad ?? mission.workpad,
  };
  if (nextStatus === 'completed') {
    next.completedAt = at;
    next.stoppedAt = null;
    next.archivedAt = null;
    next.pendingApproval = null;
    next.lease = null;
  }
  if (nextStatus === 'stopped') {
    next.stoppedAt = at;
    next.pendingApproval = null;
    next.lease = null;
  }
  if (nextStatus === 'archived') {
    next.archivedAt = at;
    next.pendingApproval = null;
    next.lease = null;
  }
  if (nextStatus === 'queued') {
    next.stoppedAt = null;
  }
  if (nextStatus === 'running') {
    next.lastRunAt = at;
  }
  return next;
}

export function isMissionResumable(mission: Mission, now = Date.now()): boolean {
  if (!RESUMABLE_MISSION_STATUS_SET.has(mission.status)) {
    return false;
  }
  if (!mission.lease) {
    return true;
  }
  if (mission.lease.releasedAt !== null) {
    return true;
  }
  return mission.lease.expiresAt <= now;
}

