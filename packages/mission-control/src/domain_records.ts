import type {
  ChecklistItem,
  ChecklistSnapshot,
  Mission,
  MissionGeneration,
  MissionGenerationStatus,
  MissionLoopPolicy,
  MissionStatus,
  WorkItem,
} from './types.js';

export function buildMissionWorkItemId(missionId: string): string {
  return `${missionId}:work-item`;
}

export function buildMissionGenerationId(missionId: string, index: number): string {
  return `${missionId}:generation:${Math.max(1, Math.trunc(index))}`;
}

export function buildChecklistSnapshotId(missionId: string, version: number): string {
  return `${missionId}:checklist:${Math.max(1, Math.trunc(version))}`;
}

export function buildDefaultImmutablePrompt(input: {
  title: string;
  goal: string;
  expectedOutput: string;
  plan: readonly string[];
}): string {
  const lines = [
    `Mission title: ${input.title}`,
    'Immutable goal:',
    input.goal,
    '',
    'Expected output:',
    input.expectedOutput,
  ];
  if (input.plan.length > 0) {
    lines.push('');
    lines.push('Initial plan:');
    for (const [index, item] of input.plan.entries()) {
      lines.push(`${index + 1}. ${item}`);
    }
  }
  return lines.join('\n').trim();
}

export function normalizeMissionLoopPolicy(
  value: Partial<MissionLoopPolicy> | null | undefined,
  fallback: {
    maxAttempts?: number | null;
    maxTurns?: number | null;
  } = {},
): MissionLoopPolicy {
  return {
    maxAttempts: normalizePositiveInteger(value?.maxAttempts) ?? normalizePositiveInteger(fallback.maxAttempts),
    maxTurns: normalizePositiveInteger(value?.maxTurns) ?? normalizePositiveInteger(fallback.maxTurns),
    maxCycles: normalizePositiveInteger(value?.maxCycles),
    maxNoProgressCycles: normalizePositiveInteger(value?.maxNoProgressCycles),
  };
}

export function normalizeMissionRecord(mission: Mission): Mission {
  const activeGenerationIndex = normalizePositiveInteger(mission.activeGenerationIndex) ?? 1;
  const generationCount = Math.max(
    normalizePositiveInteger(mission.generationCount) ?? activeGenerationIndex,
    activeGenerationIndex,
  );
  const currentChecklistSnapshotVersion = normalizePositiveInteger(mission.currentChecklistSnapshotVersion) ?? 1;
  const loopPolicy = normalizeMissionLoopPolicy(mission.loopPolicy, {
    maxAttempts: mission.maxAttempts,
    maxTurns: mission.maxTurns,
  });
  const goal = normalizeText(mission.immutableGoal) ?? normalizeText(mission.goal) ?? '';
  const expectedOutput = normalizeText(mission.expectedOutput) ?? '';
  return {
    ...mission,
    workItemId: normalizeText(mission.workItemId) ?? buildMissionWorkItemId(mission.id),
    immutableGoal: goal,
    immutablePrompt: normalizeText(mission.immutablePrompt) ?? buildDefaultImmutablePrompt({
      title: mission.title,
      goal,
      expectedOutput,
      plan: mission.plan,
    }),
    loopPolicy,
    activeGenerationId: normalizeText(mission.activeGenerationId)
      ?? buildMissionGenerationId(mission.id, activeGenerationIndex),
    activeGenerationIndex,
    generationCount,
    currentChecklistSnapshotId: normalizeText(mission.currentChecklistSnapshotId)
      ?? buildChecklistSnapshotId(mission.id, currentChecklistSnapshotVersion),
    currentChecklistSnapshotVersion,
    goal,
    expectedOutput,
    acceptanceCriteria: normalizeStringList(mission.acceptanceCriteria),
    plan: normalizeStringList(mission.plan),
    maxAttempts: loopPolicy.maxAttempts ?? normalizePositiveInteger(mission.maxAttempts) ?? 1,
    maxTurns: loopPolicy.maxTurns ?? normalizePositiveInteger(mission.maxTurns) ?? 1,
    workpad: {
      ...mission.workpad,
      latestPlan: mission.workpad.latestPlan.length > 0
        ? normalizeStringList(mission.workpad.latestPlan)
        : normalizeStringList(mission.plan),
      notes: normalizeStringList(mission.workpad.notes),
    },
  };
}

export function createMissionWorkItem(
  mission: Mission,
  options: {
    at?: number;
  } = {},
): WorkItem {
  const normalized = normalizeMissionRecord(mission);
  const at = options.at ?? normalized.updatedAt;
  return {
    id: normalized.workItemId,
    source: normalized.source,
    sourceRef: normalized.sourceRef,
    platform: normalized.platform,
    externalScopeId: normalized.externalScopeId,
    title: normalized.title,
    immutableGoal: normalized.immutableGoal,
    immutablePrompt: normalized.immutablePrompt,
    expectedOutput: normalized.expectedOutput,
    createdAt: normalized.createdAt,
    updatedAt: at,
  };
}

export function createMissionChecklistSnapshot(
  mission: Mission,
  options: {
    at?: number;
    id?: string | null;
    version?: number | null;
    generationId?: string | null;
  } = {},
): ChecklistSnapshot {
  const normalized = normalizeMissionRecord(mission);
  const version = normalizePositiveInteger(options.version) ?? normalized.currentChecklistSnapshotVersion;
  const at = options.at ?? normalized.updatedAt;
  return {
    id: normalizeText(options.id) ?? buildChecklistSnapshotId(normalized.id, version),
    missionId: normalized.id,
    workItemId: normalized.workItemId,
    generationId: options.generationId ?? normalized.activeGenerationId,
    version,
    source: normalized.source,
    sourceRef: normalized.sourceRef,
    expectedOutput: normalized.expectedOutput,
    acceptanceCriteria: [...normalized.acceptanceCriteria],
    plan: [...normalized.plan],
    items: buildChecklistItems(normalized),
    supersededAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

export function createMissionGeneration(
  mission: Mission,
  options: {
    at?: number;
    id?: string | null;
    index?: number | null;
    trigger?: MissionGeneration['trigger'];
    parentGenerationId?: string | null;
    checklistSnapshotId?: string | null;
    status?: MissionGenerationStatus | null;
    summary?: string | null;
  } = {},
): MissionGeneration {
  const normalized = normalizeMissionRecord(mission);
  const index = normalizePositiveInteger(options.index) ?? normalized.activeGenerationIndex;
  const at = options.at ?? normalized.updatedAt;
  const status = normalizeGenerationStatus(options.status) ?? mapMissionStatusToGenerationStatus(normalized.status);
  const isTerminal = status !== 'active';
  return {
    id: normalizeText(options.id) ?? buildMissionGenerationId(normalized.id, index),
    missionId: normalized.id,
    workItemId: normalized.workItemId,
    index,
    trigger: options.trigger ?? (index === 1 ? 'initial' : 'retry'),
    parentGenerationId: options.parentGenerationId ?? null,
    checklistSnapshotId: options.checklistSnapshotId ?? normalized.currentChecklistSnapshotId,
    status,
    attemptCount: normalized.attemptCount,
    summary: normalizeText(options.summary) ?? normalizeText(normalized.statusReason) ?? null,
    createdAt: at,
    updatedAt: at,
    completedAt: isTerminal ? at : null,
    supersededAt: status === 'superseded' ? at : null,
  };
}

export function createMissionRetryAggregate(
  mission: Mission,
  options: {
    at?: number;
    reason?: string | null;
    bridgeSessionId?: string | null;
    codexThreadId?: string | null;
    workflowPath?: string | null;
    workspacePath?: string | null;
  } = {},
): {
  mission: Mission;
  generation: MissionGeneration;
  checklistSnapshot: ChecklistSnapshot;
} {
  const current = normalizeMissionRecord(mission);
  const at = options.at ?? Date.now();
  const nextGenerationIndex = current.generationCount + 1;
  const nextChecklistVersion = current.currentChecklistSnapshotVersion + 1;
  const nextMission = normalizeMissionRecord({
    ...current,
    status: 'queued',
    bridgeSessionId: options.bridgeSessionId !== undefined
      ? options.bridgeSessionId
      : current.bridgeSessionId,
    codexThreadId: options.codexThreadId !== undefined
      ? options.codexThreadId
      : current.codexThreadId,
    workflowPath: options.workflowPath !== undefined
      ? options.workflowPath
      : current.workflowPath,
    workspacePath: options.workspacePath !== undefined
      ? options.workspacePath
      : current.workspacePath,
    activeGenerationIndex: nextGenerationIndex,
    generationCount: nextGenerationIndex,
    activeGenerationId: buildMissionGenerationId(current.id, nextGenerationIndex),
    currentChecklistSnapshotVersion: nextChecklistVersion,
    currentChecklistSnapshotId: buildChecklistSnapshotId(current.id, nextChecklistVersion),
    activeAttemptId: null,
    attemptCount: 0,
    lastRunAt: null,
    completedAt: null,
    archivedAt: null,
    stoppedAt: null,
    lastResultPreview: null,
    resultText: null,
    resultArtifacts: [],
    lastError: null,
    statusReason: normalizeText(options.reason) ?? 'Mission queued for retry.',
    pendingApproval: null,
    lease: null,
    workpad: {
      ...current.workpad,
      summary: null,
      latestPlan: [...current.plan],
      latestBlocker: null,
      latestVerifierSummary: null,
      finalResultSummary: null,
      updatedAt: at,
    },
    updatedAt: at,
  });
  return {
    mission: nextMission,
    checklistSnapshot: createMissionChecklistSnapshot(nextMission, {
      at,
      generationId: nextMission.activeGenerationId,
    }),
    generation: createMissionGeneration(nextMission, {
      at,
      trigger: 'retry',
      parentGenerationId: current.activeGenerationId,
    }),
  };
}

export function mapMissionStatusToGenerationStatus(status: MissionStatus): MissionGenerationStatus {
  switch (status) {
    case 'draft':
    case 'queued':
    case 'planning':
    case 'running':
    case 'verifying':
    case 'repairing':
      return 'active';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    case 'blocked':
      return 'blocked';
    case 'waiting_user':
      return 'waiting_user';
    case 'needs_human':
      return 'needs_human';
    case 'handoff':
      return 'handoff';
    case 'archived':
      return 'superseded';
  }
}

function buildChecklistItems(mission: Mission): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  let order = 0;
  if (normalizeText(mission.expectedOutput)) {
    order += 1;
    items.push({
      id: `${mission.currentChecklistSnapshotId}:deliverable`,
      kind: 'deliverable',
      title: mission.expectedOutput,
      detail: 'Final deliverable expected from this mission generation.',
      order,
      status: 'pending',
      sourceRef: 'expected-output',
      completionSummary: null,
      completedAt: null,
    });
  }
  for (const [index, criterion] of mission.acceptanceCriteria.entries()) {
    order += 1;
    items.push({
      id: `${mission.currentChecklistSnapshotId}:acceptance:${index + 1}`,
      kind: 'acceptance',
      title: criterion,
      detail: null,
      order,
      status: 'pending',
      sourceRef: `acceptance:${index + 1}`,
      completionSummary: null,
      completedAt: null,
    });
  }
  for (const [index, step] of mission.plan.entries()) {
    order += 1;
    items.push({
      id: `${mission.currentChecklistSnapshotId}:plan:${index + 1}`,
      kind: 'plan',
      title: step,
      detail: null,
      order,
      status: 'pending',
      sourceRef: `plan:${index + 1}`,
      completionSummary: null,
      completedAt: null,
    });
  }
  return items;
}

function normalizeGenerationStatus(value: string | null | undefined): MissionGenerationStatus | null {
  if (
    value === 'active'
    || value === 'completed'
    || value === 'failed'
    || value === 'stopped'
    || value === 'blocked'
    || value === 'waiting_user'
    || value === 'needs_human'
    || value === 'handoff'
    || value === 'superseded'
  ) {
    return value;
  }
  return null;
}

function normalizePositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function normalizeStringList(values: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => normalizeText(value))
    .filter((value): value is string => value !== null);
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
