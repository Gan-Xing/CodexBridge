import {
  MissionWorkflowLoader,
  createMission,
  createMissionAttemptPromptContract,
  createMissionRetrySnapshot,
  createMissionResumeSnapshot,
  createMissionWorkpadStatusView,
  renderMissionAttemptPromptContract,
  transitionMission,
  type LoadedMissionWorkflow,
  type Mission,
  type MissionAttempt,
  type MissionAttemptStatus,
  type MissionEvent,
  type MissionStatus,
} from '../../packages/mission-control/src/index.js';
import type {
  AgentJob,
  AgentJobAttemptHistoryEntry,
  AgentJobMissionRuntimeState,
  AgentJobStatus,
  TurnArtifactDeliveredItem,
} from '../types/core.js';

const workflowLoader = new MissionWorkflowLoader();
const ACTIVE_MISSION_JOB_STATUS_SET = new Set<MissionStatus>([
  'planning',
  'running',
  'verifying',
  'repairing',
]);
const TERMINAL_MISSION_JOB_STATUS_SET = new Set<MissionStatus>([
  'completed',
  'failed',
  'stopped',
  'archived',
]);
const TERMINAL_ATTEMPT_STATUS_SET = new Set<MissionAttempt['status']>([
  'completed',
  'failed',
  'stopped',
  'waiting_user',
  'needs_human',
  'handoff',
  'blocked',
]);

export interface AgentJobMissionRuntimeStateView {
  mission: Mission | null;
  attempts: MissionAttempt[];
  events: MissionEvent[];
}

export function loadMissionWorkflowForAgentJob(job: AgentJob):
  | { workflow: LoadedMissionWorkflow; error: null }
  | { workflow: null; error: Error } {
  const effectiveJob = createMissionControlledAgentJobView(job);
  const result = workflowLoader.tryLoad({
    explicitPath: effectiveJob.missionWorkflowPath ?? undefined,
    cwd: effectiveJob.cwd,
  });
  if (result.workflow) {
    return result;
  }
  return {
    workflow: null,
    error: result.error,
  };
}

export function buildMissionControlledAgentExecutionPrompt(job: AgentJob, params: {
  attempt: number;
  previousVerificationSummary: string | null;
  previousVerificationIssues: string[];
  previousResultPreview: string | null;
  workflow: LoadedMissionWorkflow;
  locale: string | null;
}): string {
  const effectiveJob = createMissionControlledAgentJobView(job);
  const mission = createMissionFromAgentJob(effectiveJob, {
    workflow: params.workflow,
    latestBlocker: params.previousVerificationSummary,
    notes: buildPromptNotes(params.previousVerificationIssues, params.previousResultPreview),
  });
  const attempt = createSyntheticAttempt(effectiveJob, params.attempt, 'running');
  const contract = createMissionAttemptPromptContract({
    mission,
    attempt,
    workflow: params.workflow,
  });
  const localePrefix = normalizeLocalePrefix(params.locale);
  return [
    localePrefix,
    '',
    renderMissionAttemptPromptContract(contract),
  ].join('\n').trim();
}

export function createAgentJobStatusView(job: AgentJob, workflow: LoadedMissionWorkflow | null) {
  const effectiveJob = createMissionControlledAgentJobView(job);
  const state = loadAgentJobMissionRuntimeState(job);
  const mission = state.mission
    ? applyWorkflowMetadataToMission(state.mission, workflow)
    : createMissionFromAgentJob(effectiveJob, {
      workflow,
      latestBlocker: effectiveJob.missionWorkpadLatestBlocker,
    });
  const attempts = state.attempts.length > 0
    ? state.attempts.map((attempt) => cloneValue(attempt))
    : effectiveJob.missionAttemptHistory.map((entry) => createSyntheticAttemptFromHistory(effectiveJob, entry));
  return createMissionWorkpadStatusView({
    mission,
    attempts,
    workflow,
  });
}

export function createMissionControlledAgentJobView(job: AgentJob): AgentJob {
  const state = loadAgentJobMissionRuntimeState(job);
  const mission = state.mission;
  if (!mission) {
    return cloneValue(job);
  }
  const resultArtifacts = mapMissionArtifactsToAgentArtifacts(mission.resultArtifacts);
  const attemptHistory = state.attempts.length > 0
    ? buildAttemptHistoryFromMissionAttempts(state.attempts)
    : job.missionAttemptHistory;
  return {
    ...cloneValue(job),
    title: compactString(mission.title) ?? job.title,
    goal: compactString(mission.goal) ?? job.goal,
    expectedOutput: compactString(mission.expectedOutput) ?? job.expectedOutput,
    plan: mission.plan.length > 0 ? [...mission.plan] : [...job.plan],
    riskLevel: mission.riskLevel ?? job.riskLevel,
    providerProfileId: compactString(mission.providerProfileId) ?? job.providerProfileId,
    bridgeSessionId: compactString(mission.bridgeSessionId) ?? job.bridgeSessionId,
    cwd: mission.cwd ?? job.cwd,
    status: mapMissionStatusToAgentJobStatus(mission.status),
    running: ACTIVE_MISSION_JOB_STATUS_SET.has(mission.status),
    stopRequested: mission.status === 'stopped',
    maxAttempts: mission.maxAttempts,
    attemptCount: mission.attemptCount,
    lastRunAt: mission.lastRunAt,
    completedAt: TERMINAL_MISSION_JOB_STATUS_SET.has(mission.status)
      ? (mission.completedAt ?? mission.stoppedAt ?? mission.updatedAt)
      : null,
    lastResultPreview: summarizeMissionPreview(mission.lastResultPreview, mission.resultArtifacts) ?? job.lastResultPreview,
    resultText: compactString(mission.resultText) ?? job.resultText ?? null,
    resultArtifacts,
    lastError: compactString(mission.lastError) ?? compactString(mission.statusReason) ?? job.lastError,
    verificationSummary: compactString(mission.workpad.latestVerifierSummary)
      ?? compactString(mission.statusReason)
      ?? job.verificationSummary,
    missionWorkflowPath: mission.workflowPath ?? job.missionWorkflowPath,
    missionWorkflowSourceLabel: mission.workflowPath
      ? `configured workflow (${mission.workflowPath})`
      : job.missionWorkflowSourceLabel,
    missionWorkpadLatestBlocker: compactString(mission.workpad.latestBlocker) ?? job.missionWorkpadLatestBlocker,
    missionWorkpadLatestVerifierSummary: compactString(mission.workpad.latestVerifierSummary)
      ?? job.missionWorkpadLatestVerifierSummary,
    missionWorkpadFinalResultSummary: compactString(mission.workpad.finalResultSummary)
      ?? compactString(mission.lastResultPreview)
      ?? job.missionWorkpadFinalResultSummary,
    missionAttemptHistory: attemptHistory,
    updatedAt: Math.max(job.updatedAt, mission.updatedAt),
  };
}

export function loadAgentJobMissionRuntimeState(job: AgentJob): AgentJobMissionRuntimeStateView {
  const raw = job.missionRuntimeState;
  return {
    mission: raw?.mission ? cloneValue(raw.mission as unknown as Mission) : null,
    attempts: Array.isArray(raw?.attempts)
      ? raw.attempts.map((attempt) => cloneValue(attempt as unknown as MissionAttempt))
      : [],
    events: Array.isArray(raw?.events)
      ? raw.events.map((event) => cloneValue(event as unknown as MissionEvent))
      : [],
  };
}

export function serializeAgentJobMissionRuntimeState(
  state: AgentJobMissionRuntimeStateView,
): AgentJobMissionRuntimeState {
  return {
    mission: state.mission ? (cloneValue(state.mission) as unknown as Record<string, unknown>) : null,
    attempts: state.attempts.map((attempt) => cloneValue(attempt) as unknown as Record<string, unknown>),
    events: state.events.map((event) => cloneValue(event) as unknown as Record<string, unknown>),
  };
}

export function createFreshMissionRuntimeStateForAgentJob(
  job: AgentJob,
  options: {
    now?: number;
    codexThreadId?: string | null;
  } = {},
): AgentJobMissionRuntimeStateView {
  const now = options.now ?? Date.now();
  return {
    mission: transitionMission(createMission({
      id: job.id,
      source: mapPlatformToMissionSource(job.platform),
      sourceRef: job.id,
      platform: job.platform,
      externalScopeId: job.externalScopeId,
      title: job.title,
      goal: job.goal,
      expectedOutput: job.expectedOutput,
      acceptanceCriteria: job.expectedOutput ? [job.expectedOutput] : [],
      plan: [...job.plan],
      riskLevel: job.riskLevel,
      cwd: job.cwd,
      workflowPath: job.missionWorkflowPath ?? null,
      providerProfileId: job.providerProfileId,
      bridgeSessionId: job.bridgeSessionId,
      codexThreadId: options.codexThreadId ?? null,
      maxAttempts: job.maxAttempts,
      maxTurns: 8,
      now,
    }), 'queued', {
      at: now,
      reason: 'Agent mission queued through the bridge adapter.',
    }),
    attempts: [],
    events: [],
  };
}

export function createRetriedMissionRuntimeStateForAgentJob(
  job: AgentJob,
  options: {
    now?: number;
    codexThreadId?: string | null;
  } = {},
): AgentJobMissionRuntimeStateView {
  const state = loadAgentJobMissionRuntimeState(job);
  if (!state.mission) {
    return createFreshMissionRuntimeStateForAgentJob(job, options);
  }
  const now = options.now ?? Date.now();
  return {
    mission: createMissionRetrySnapshot(state.mission, {
      at: now,
      codexThreadId: options.codexThreadId ?? state.mission.codexThreadId,
      reason: 'Agent mission re-queued through Mission Control retry.',
    }),
    attempts: [],
    events: [],
  };
}

export function createResumedMissionRuntimeStateForAgentJob(
  job: AgentJob,
  options: {
    reason?: string | null;
    now?: number;
  } = {},
): AgentJobMissionRuntimeStateView | null {
  const state = loadAgentJobMissionRuntimeState(job);
  if (!state.mission) {
    return null;
  }
  const now = options.now ?? Date.now();
  return {
    mission: createMissionResumeSnapshot(state.mission, {
      at: now,
      reason: options.reason,
    }),
    attempts: state.attempts.map((attempt) => cloneValue(attempt)),
    events: state.events.map((event) => cloneValue(event)),
  };
}

export function createStoppedMissionRuntimeStateForAgentJob(
  job: AgentJob,
  options: {
    reason?: string | null;
    now?: number;
  } = {},
): AgentJobMissionRuntimeStateView | null {
  const state = loadAgentJobMissionRuntimeState(job);
  if (!state.mission) {
    return null;
  }
  const now = options.now ?? Date.now();
  const reason = compactString(options.reason) ?? 'Agent job stop requested.';
  if (
    state.mission.status === 'completed'
    || state.mission.status === 'failed'
    || state.mission.status === 'archived'
  ) {
    return state;
  }
  const mission = state.mission.status === 'stopped'
    ? {
      ...cloneValue(state.mission),
      updatedAt: now,
    }
    : transitionMission(state.mission, 'stopped', {
      at: now,
      reason,
      lastError: compactString(state.mission.lastError) ?? reason,
      activeAttemptId: state.mission.activeAttemptId,
    });
  return {
    mission,
    attempts: state.attempts.map((attempt) => {
      if (attempt.id !== state.mission?.activeAttemptId || TERMINAL_ATTEMPT_STATUS_SET.has(attempt.status)) {
        return cloneValue(attempt);
      }
      return {
        ...cloneValue(attempt),
        status: 'stopped',
        error: reason,
        endedAt: attempt.endedAt ?? now,
        updatedAt: now,
      };
    }),
    events: state.events.map((event) => cloneValue(event)),
  };
}

function applyWorkflowMetadataToMission(
  mission: Mission,
  workflow: LoadedMissionWorkflow | null,
): Mission {
  const next = cloneValue(mission);
  if (workflow?.source.path) {
    next.workflowPath = workflow.source.path;
  }
  return next;
}

function createMissionFromAgentJob(
  job: AgentJob,
  options: {
    workflow: LoadedMissionWorkflow | null;
    latestBlocker?: string | null;
    notes?: string[];
  },
): Mission {
  const summary = job.missionWorkpadFinalResultSummary
    ?? job.lastResultPreview
    ?? null;
  return {
    id: job.id,
    source: mapPlatformToMissionSource(job.platform),
    sourceRef: job.id,
    platform: job.platform,
    externalScopeId: job.externalScopeId,
    title: job.title,
    goal: job.goal,
    expectedOutput: job.expectedOutput,
    acceptanceCriteria: [],
    plan: [...job.plan],
    status: mapAgentStatusToMissionStatus(job.status, job.running),
    priority: 'normal',
    riskLevel: job.riskLevel,
    cwd: job.cwd,
    workspacePath: null,
    workflowPath: options.workflow?.source.path ?? job.missionWorkflowPath ?? null,
    providerProfileId: job.providerProfileId,
    bridgeSessionId: job.bridgeSessionId,
    codexThreadId: null,
    activeAttemptId: null,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    maxTurns: 1,
    lastRunAt: job.lastRunAt,
    completedAt: job.completedAt,
    archivedAt: null,
    stoppedAt: job.status === 'stopped' ? job.updatedAt : null,
    lastResultPreview: job.lastResultPreview,
    resultText: job.resultText ?? null,
    resultArtifacts: [...(job.resultArtifacts ?? [])],
    lastError: job.lastError,
    statusReason: job.lastError ?? job.verificationSummary,
    pendingApproval: null,
    lease: null,
    workpad: {
      summary,
      latestPlan: [...job.plan],
      latestBlocker: options.latestBlocker ?? job.missionWorkpadLatestBlocker,
      latestVerifierSummary: job.missionWorkpadLatestVerifierSummary ?? job.verificationSummary,
      finalResultSummary: job.missionWorkpadFinalResultSummary,
      notes: [...(options.notes ?? [])],
      updatedAt: job.updatedAt,
    },
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function createSyntheticAttempt(
  job: AgentJob,
  attemptIndex: number,
  status: 'running' | 'verifying' | 'repairing' | 'completed' | 'failed' | 'queued' | 'stopped',
): MissionAttempt {
  return {
    id: `${job.id}-attempt-${attemptIndex}`,
    missionId: job.id,
    index: attemptIndex,
    status,
    providerRunId: null,
    providerThreadId: null,
    promptDigest: null,
    verifierVerdict: null,
    verifierSummary: job.verificationSummary,
    missingAcceptanceCriteria: [],
    outputPreview: job.lastResultPreview,
    error: job.lastError,
    startedAt: job.lastRunAt,
    endedAt: job.completedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function createSyntheticAttemptFromHistory(job: AgentJob, entry: AgentJobAttemptHistoryEntry): MissionAttempt {
  return {
    id: `${job.id}-attempt-${entry.attempt}-${entry.recordedAt}`,
    missionId: job.id,
    index: entry.attempt,
    status: mapAgentStatusToMissionAttemptStatus(entry.status),
    providerRunId: null,
    providerThreadId: null,
    promptDigest: null,
    verifierVerdict: inferVerifierVerdict(entry.status, entry.verifierSummary),
    verifierSummary: entry.verifierSummary,
    missingAcceptanceCriteria: [],
    outputPreview: entry.outputPreview,
    error: entry.error,
    startedAt: entry.recordedAt,
    endedAt: entry.status === 'running' || entry.status === 'verifying' ? null : entry.recordedAt,
    createdAt: entry.recordedAt,
    updatedAt: entry.recordedAt,
  };
}

function buildAttemptHistoryFromMissionAttempts(attempts: MissionAttempt[]): AgentJobAttemptHistoryEntry[] {
  return [...attempts]
    .sort((left, right) => left.index - right.index)
    .map((attempt) => ({
      attempt: attempt.index,
      status: mapMissionAttemptStatusToAgentJobStatus(attempt.status),
      verifierSummary: attempt.verifierSummary,
      outputPreview: attempt.outputPreview,
      error: attempt.error,
      recordedAt: attempt.endedAt ?? attempt.updatedAt,
    }));
}

function mapPlatformToMissionSource(platform: string): Mission['source'] {
  if (platform === 'weixin' || platform === 'telegram') {
    return platform;
  }
  return 'manual';
}

function mapAgentStatusToMissionStatus(status: AgentJobStatus, running: boolean): MissionStatus {
  if (running && status !== 'stopped' && status !== 'completed' && status !== 'failed') {
    return status === 'planning' ? 'planning' : 'running';
  }
  return status;
}

function mapMissionStatusToAgentJobStatus(status: MissionStatus): AgentJobStatus {
  switch (status) {
    case 'draft':
      return 'queued';
    case 'queued':
    case 'planning':
    case 'running':
    case 'verifying':
    case 'repairing':
    case 'waiting_user':
    case 'needs_human':
    case 'handoff':
    case 'blocked':
    case 'completed':
    case 'failed':
    case 'stopped':
      return status;
    case 'archived':
      return 'completed';
  }
}

function mapMissionAttemptStatusToAgentJobStatus(status: MissionAttempt['status']): AgentJobStatus {
  switch (status) {
    case 'queued':
    case 'running':
    case 'verifying':
    case 'repairing':
    case 'waiting_user':
    case 'needs_human':
    case 'handoff':
    case 'blocked':
    case 'completed':
    case 'failed':
    case 'stopped':
      return status;
  }
}

function inferVerifierVerdict(
  status: AgentJobAttemptHistoryEntry['status'],
  verifierSummary: string | null,
): MissionAttempt['verifierVerdict'] {
  if (!verifierSummary) {
    return null;
  }
  if (status === 'completed') {
    return 'complete';
  }
  if (status === 'repairing' || status === 'verifying') {
    return 'repair';
  }
  if (status === 'waiting_user') {
    return 'waiting_user';
  }
  if (status === 'needs_human') {
    return 'needs_human';
  }
  if (status === 'handoff') {
    return 'handoff';
  }
  if (status === 'blocked') {
    return 'blocked';
  }
  if (status === 'failed') {
    return 'failed';
  }
  return null;
}

function buildPromptNotes(previousVerificationIssues: string[], previousResultPreview: string | null): string[] {
  const notes: string[] = [];
  for (const issue of previousVerificationIssues) {
    notes.push(`Previous verification issue: ${issue}`);
  }
  if (previousResultPreview) {
    notes.push(`Previous output preview: ${previousResultPreview}`);
  }
  return notes;
}

function normalizeLocalePrefix(locale: string | null): string {
  return locale === 'zh-CN'
    ? '你正在执行 CodexBridge 后台 Agent 任务。请用中文回复最终结果。\n最终回复必须包含：摘要、验证结果、产物或后续动作。'
    : 'You are executing a CodexBridge background Agent task. Reply with the final result in English.';
}

function mapAgentStatusToMissionAttemptStatus(status: AgentJobStatus): MissionAttemptStatus {
  switch (status) {
    case 'planning':
      return 'queued';
    case 'running':
    case 'verifying':
    case 'repairing':
    case 'waiting_user':
    case 'needs_human':
    case 'handoff':
    case 'blocked':
    case 'completed':
    case 'failed':
    case 'stopped':
    case 'queued':
      return status;
    default:
      return 'queued';
  }
}

function mapMissionArtifactsToAgentArtifacts(value: unknown[]): TurnArtifactDeliveredItem[] | null {
  const normalized = value
    .map((artifact) => {
      const record = artifact as Record<string, unknown> | null;
      const type = compactString(record?.type);
      const artifactPath = compactString(record?.path);
      if (!type || !artifactPath) {
        return null;
      }
      return {
        kind: type === 'other' ? 'file' : (type as TurnArtifactDeliveredItem['kind']),
        path: artifactPath,
        displayName: compactString(record?.name),
        mimeType: compactString(record?.mimeType),
        sizeBytes: null,
        caption: compactString(record?.caption),
        source: 'provider_native' as const,
        turnId: null,
      };
    })
    .filter(Boolean) as TurnArtifactDeliveredItem[];
  return normalized.length > 0 ? normalized : null;
}

function summarizeMissionPreview(value: string | null, artifacts: unknown[]): string | null {
  const text = compactString(value);
  if (text) {
    return text.length > 180 ? `${text.slice(0, 179)}…` : text;
  }
  const artifactCount = Array.isArray(artifacts) ? artifacts.length : 0;
  return artifactCount > 0 ? `attachments: ${artifactCount}` : null;
}

function compactString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 ? normalized : null;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
