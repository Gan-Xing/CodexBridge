import type { MissionVerifierResult } from './verifier.js';
import type {
  ChecklistItem,
  ChecklistItemKind,
  ChecklistItemStatus,
  ChecklistSnapshot,
  Mission,
  MissionAttempt,
  MissionEvent,
  MissionStatus,
} from './types.js';

export const MISSION_CYCLE_RESULT_SCHEMA_VERSION = 'mission-cycle/v1' as const;

export type MissionControlOutcome =
  | 'continue'
  | 'retry'
  | 'waiting_user'
  | 'needs_human'
  | 'handoff'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'stopped';

export interface MissionCycleAudit {
  attemptId: string | null;
  eventSeq: number;
  updatedAt: string;
}

export interface MissionCycleResult {
  schemaVersion: typeof MISSION_CYCLE_RESULT_SCHEMA_VERSION;
  cycle: number;
  status: MissionControlOutcome;
  stage: string;
  progress: string;
  overallCompletion: number | null;
  nextStep: string | null;
  activeItemId: string | null;
  activeItemStatus: ChecklistItemStatus | null;
  checklistVersion: number;
  verifierSummary: string | null;
  blocker: string | null;
  needUserAction: string | null;
  planChangeSuggestion: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
  audit: MissionCycleAudit;
}

export interface ChecklistProgressSummary {
  overallCompletion: number | null;
  activeItemId: string | null;
  activeItemStatus: ChecklistItemStatus | null;
  completedItemCount: number;
  totalItemCount: number;
}

export interface ChecklistItemSelectorOptions {
  preferredKinds?: ChecklistItemKind[];
}

export interface ApplyMissionChecklistResultOptions {
  activeItemId?: string | null;
  markRemainingComplete?: boolean;
}

export interface CreateMissionCycleResultInput {
  mission: Mission;
  attempt: MissionAttempt | null;
  checklistSnapshot: ChecklistSnapshot | null;
  cycle: number;
  status: MissionControlOutcome;
  stage: string;
  progress: string;
  nextStep?: string | null;
  verifierSummary?: string | null;
  blocker?: string | null;
  needUserAction?: string | null;
  planChangeSuggestion?: Record<string, unknown> | null;
  evidence?: Record<string, unknown>;
  eventSeq: number;
  updatedAt?: number | null;
}

const MISSION_CONTROL_OUTCOMES = new Set<MissionControlOutcome>([
  'continue',
  'retry',
  'waiting_user',
  'needs_human',
  'handoff',
  'done',
  'blocked',
  'failed',
  'stopped',
]);

const CHECKLIST_ITEM_STATUSES = new Set<ChecklistItemStatus>([
  'pending',
  'completed',
  'blocked',
  'skipped',
]);

export function mapMissionStatusToMissionControlOutcome(
  status: MissionStatus,
): MissionControlOutcome | null {
  switch (status) {
    case 'repairing':
      return 'retry';
    case 'waiting_user':
      return 'waiting_user';
    case 'needs_human':
      return 'needs_human';
    case 'handoff':
      return 'handoff';
    case 'completed':
      return 'done';
    case 'blocked':
      return 'blocked';
    case 'failed':
    case 'max_loops_reached':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      return null;
  }
}

export function summarizeChecklistSnapshotProgress(
  snapshot: ChecklistSnapshot | null,
): ChecklistProgressSummary {
  if (!snapshot) {
    return {
      overallCompletion: null,
      activeItemId: null,
      activeItemStatus: null,
      completedItemCount: 0,
      totalItemCount: 0,
    };
  }
  const actionableItems = getChecklistProgressItems(snapshot);
  const totalItemCount = actionableItems.length;
  const completedItemCount = actionableItems.filter((item) => item.status === 'completed').length;
  const activeItem = getActiveFormalChecklistItem(snapshot);
  return {
    overallCompletion: totalItemCount > 0
      ? Math.round((completedItemCount / totalItemCount) * 100)
      : null,
    activeItemId: activeItem?.id ?? null,
    activeItemStatus: activeItem?.status ?? null,
    completedItemCount,
    totalItemCount,
  };
}

export function applyMissionVerifierResultToChecklistSnapshot(
  snapshot: ChecklistSnapshot,
  result: Pick<MissionVerifierResult, 'verdict' | 'summary' | 'missingAcceptanceCriteria'>,
  now = Date.now(),
  options: ApplyMissionChecklistResultOptions = {},
): ChecklistSnapshot {
  const activeItem = resolveActiveChecklistItem(snapshot, options.activeItemId);
  if (!activeItem) {
    if (result.verdict === 'complete' && options.markRemainingComplete) {
      return completeChecklistSnapshot(snapshot, result.summary, now);
    }
    return {
      ...snapshot,
      updatedAt: now,
    };
  }

  if (result.verdict === 'complete' && options.markRemainingComplete) {
    return completeChecklistSnapshot(snapshot, result.summary, now);
  }

  if (result.verdict === 'complete') {
    return {
      ...snapshot,
      items: snapshot.items.map((item) => item.id === activeItem.id
        ? markChecklistItemCompleted(item, result.summary, now)
        : { ...item }),
      updatedAt: now,
    };
  }

  const missingCriteria = normalizeStringSet(result.missingAcceptanceCriteria);
  const pendingStatus = resolveIncompleteChecklistStatus(result.verdict);
  if (missingCriteria.size === 0) {
    return {
      ...snapshot,
      items: snapshot.items.map((item) => item.id === activeItem.id
        ? {
          ...item,
          status: pendingStatus,
          completionSummary: null,
          completedAt: null,
        }
        : { ...item }),
      updatedAt: now,
    };
  }

  return {
    ...snapshot,
    items: snapshot.items.map((item) => {
      if (activeItem.kind !== 'acceptance') {
        return item.id === activeItem.id
          ? {
            ...item,
            status: pendingStatus,
            completionSummary: null,
            completedAt: null,
          }
          : { ...item };
      }
      if (item.kind !== 'acceptance') {
        return { ...item };
      }
      const key = normalizeForMatch(item.title);
      if (missingCriteria.has(key)) {
        return {
          ...item,
          status: pendingStatus,
          completionSummary: null,
          completedAt: null,
        };
      }
      return markChecklistItemCompleted(item, 'Verified in the latest mission cycle.', now);
    }),
    updatedAt: now,
  };
}

export function getActiveChecklistItem(
  snapshot: ChecklistSnapshot | null,
  options: ChecklistItemSelectorOptions = {},
): ChecklistItem | null {
  if (!snapshot) {
    return null;
  }
  const preferredKinds = options.preferredKinds ?? [];
  for (const kind of preferredKinds) {
    const matched = snapshot.items.find((item) => item.kind === kind && isIncompleteChecklistItem(item));
    if (matched) {
      return matched;
    }
  }
  return snapshot.items.find((item) => isIncompleteChecklistItem(item)) ?? null;
}

export function getActiveFormalChecklistItem(
  snapshot: ChecklistSnapshot | null,
): ChecklistItem | null {
  if (!snapshot) {
    return null;
  }
  const activePlanItem = snapshot.items.find(
    (item) => item.kind === 'plan' && isIncompleteChecklistItem(item),
  ) ?? null;
  if (activePlanItem) {
    return activePlanItem;
  }
  return getActiveChecklistItem(snapshot, {
    preferredKinds: ['acceptance', 'deliverable'],
  });
}

export function getChecklistProgressItems(
  snapshot: ChecklistSnapshot | null,
): ChecklistItem[] {
  if (!snapshot) {
    return [];
  }
  const planItems = snapshot.items.filter((item) => item.kind === 'plan' && item.status !== 'skipped');
  if (planItems.length > 0) {
    return planItems.map((item) => ({ ...item }));
  }
  return snapshot.items
    .filter((item) => item.status !== 'skipped')
    .map((item) => ({ ...item }));
}

export function completeChecklistSnapshot(
  snapshot: ChecklistSnapshot,
  summary: string,
  now = Date.now(),
): ChecklistSnapshot {
  return {
    ...snapshot,
    items: snapshot.items.map((item) => isIncompleteChecklistItem(item)
      ? markChecklistItemCompleted(item, summary, now)
      : { ...item }),
    updatedAt: now,
  };
}

export function createMissionCycleResult(
  input: CreateMissionCycleResultInput,
): MissionCycleResult {
  const progressSummary = summarizeChecklistSnapshotProgress(input.checklistSnapshot);
  const updatedAt = typeof input.updatedAt === 'number' ? input.updatedAt : input.mission.updatedAt;
  const overallCompletion = input.status === 'done'
    ? 100
    : progressSummary.overallCompletion;
  const activeItemId = input.status === 'done'
    ? null
    : progressSummary.activeItemId;
  const activeItemStatus = input.status === 'done'
    ? null
    : progressSummary.activeItemStatus;

  return {
    schemaVersion: MISSION_CYCLE_RESULT_SCHEMA_VERSION,
    cycle: Math.max(1, Math.trunc(input.cycle)),
    status: input.status,
    stage: normalizeText(input.stage) ?? 'mission.runtime',
    progress: normalizeText(input.progress) ?? 'Mission cycle updated.',
    overallCompletion,
    nextStep: normalizeText(input.nextStep),
    activeItemId,
    activeItemStatus,
    checklistVersion: input.checklistSnapshot?.version ?? input.mission.currentChecklistSnapshotVersion,
    verifierSummary: normalizeText(input.verifierSummary),
    blocker: normalizeText(input.blocker),
    needUserAction: normalizeText(input.needUserAction),
    planChangeSuggestion: isRecord(input.planChangeSuggestion)
      ? cloneRecord(input.planChangeSuggestion)
      : null,
    evidence: isRecord(input.evidence)
      ? cloneRecord(input.evidence)
      : {},
    audit: {
      attemptId: input.attempt?.id ?? input.mission.activeAttemptId ?? null,
      eventSeq: Math.max(1, Math.trunc(input.eventSeq)),
      updatedAt: new Date(updatedAt).toISOString(),
    },
  };
}

export function readMissionCycleResult(
  event: MissionEvent,
): MissionCycleResult | null {
  const raw = isRecord(event.metadata) ? event.metadata.cycleResult : null;
  if (!isRecord(raw)) {
    return null;
  }
  const schemaVersion = raw.schemaVersion;
  const status = typeof raw.status === 'string' ? normalizeMissionControlOutcome(raw.status) : null;
  const audit = isRecord(raw.audit) ? raw.audit : null;
  if (
    schemaVersion !== MISSION_CYCLE_RESULT_SCHEMA_VERSION
    || status === null
    || !audit
    || typeof raw.cycle !== 'number'
    || typeof raw.stage !== 'string'
    || typeof raw.progress !== 'string'
    || typeof raw.checklistVersion !== 'number'
    || typeof audit.eventSeq !== 'number'
    || typeof audit.updatedAt !== 'string'
  ) {
    return null;
  }

  const activeItemStatus = normalizeChecklistItemStatus(raw.activeItemStatus);

  return {
    schemaVersion: MISSION_CYCLE_RESULT_SCHEMA_VERSION,
    cycle: Math.max(1, Math.trunc(raw.cycle)),
    status,
    stage: raw.stage,
    progress: raw.progress,
    overallCompletion: normalizeNullableNumber(raw.overallCompletion),
    nextStep: normalizeText(raw.nextStep),
    activeItemId: normalizeText(raw.activeItemId),
    activeItemStatus,
    checklistVersion: Math.max(1, Math.trunc(raw.checklistVersion)),
    verifierSummary: normalizeText(raw.verifierSummary),
    blocker: normalizeText(raw.blocker),
    needUserAction: normalizeText(raw.needUserAction),
    planChangeSuggestion: isRecord(raw.planChangeSuggestion)
      ? cloneRecord(raw.planChangeSuggestion)
      : null,
    evidence: isRecord(raw.evidence)
      ? cloneRecord(raw.evidence)
      : {},
    audit: {
      attemptId: normalizeText(audit.attemptId),
      eventSeq: Math.max(1, Math.trunc(audit.eventSeq)),
      updatedAt: audit.updatedAt,
    },
  };
}

export function listMissionCycleResults(
  events: readonly MissionEvent[],
): MissionCycleResult[] {
  return events
    .map((event) => readMissionCycleResult(event))
    .filter((result): result is MissionCycleResult => result !== null)
    .sort((left, right) => left.cycle - right.cycle);
}

export function getLatestMissionCycleResult(
  events: readonly MissionEvent[],
): MissionCycleResult | null {
  const results = listMissionCycleResults(events);
  return results.at(-1) ?? null;
}

function markChecklistItemCompleted(
  item: ChecklistItem,
  summary: string,
  now: number,
): ChecklistItem {
  return {
    ...item,
    status: 'completed',
    completionSummary: normalizeText(item.completionSummary) ?? normalizeText(summary),
    completedAt: item.completedAt ?? now,
  };
}

function resolveActiveChecklistItem(
  snapshot: ChecklistSnapshot,
  activeItemId: string | null | undefined,
): ChecklistItem | null {
  const explicit = typeof activeItemId === 'string'
    ? snapshot.items.find((item) => item.id === activeItemId) ?? null
    : null;
  if (explicit) {
    return explicit;
  }
  return getActiveFormalChecklistItem(snapshot);
}

function resolveIncompleteChecklistStatus(
  verdict: MissionVerifierResult['verdict'],
): ChecklistItemStatus {
  if (verdict === 'blocked' || verdict === 'failed') {
    return 'blocked';
  }
  return 'pending';
}

function isIncompleteChecklistItem(item: ChecklistItem): boolean {
  return item.status !== 'completed' && item.status !== 'skipped';
}

function normalizeMissionControlOutcome(
  value: string | MissionControlOutcome,
): MissionControlOutcome | null {
  const normalized = normalizeText(value)?.toLowerCase();
  if (!normalized || !MISSION_CONTROL_OUTCOMES.has(normalized as MissionControlOutcome)) {
    return null;
  }
  return normalized as MissionControlOutcome;
}

function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ');
}

function normalizeStringSet(values: readonly string[]): Set<string> {
  return new Set(
    values
      .map((value) => normalizeForMatch(String(value ?? '')))
      .filter(Boolean),
  );
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNullableNumber(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizeChecklistItemStatus(value: unknown): ChecklistItemStatus | null {
  if (typeof value !== 'string' || !CHECKLIST_ITEM_STATUSES.has(value as ChecklistItemStatus)) {
    return null;
  }
  return value as ChecklistItemStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}
