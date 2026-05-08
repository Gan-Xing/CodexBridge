import { createMissionAttemptPromptContract, renderMissionAttemptPromptContract } from './prompt_contract.js';
import { transitionMission } from './state_machine.js';
import type { MissionProviderResult } from './provider.js';
import type {
  ChecklistItem,
  ChecklistSnapshot,
  Mission,
  MissionAttempt,
  MissionStatus,
  MissionVerifierVerdict,
  MissionWorkpad,
} from './types.js';
import type { LoadedMissionWorkflow } from './workflow.js';

const MISSION_VERIFIER_VERDICTS = [
  'complete',
  'repair',
  'blocked',
  'waiting_user',
  'needs_human',
  'handoff',
  'failed',
] as const satisfies readonly MissionVerifierVerdict[];

const MISSION_VERIFIER_VERDICT_SET = new Set<MissionVerifierVerdict>(MISSION_VERIFIER_VERDICTS);

export interface MissionVerifierInput {
  mission: Mission;
  attempt: MissionAttempt;
  checklistSnapshot: ChecklistSnapshot | null;
  activeChecklistItem: ChecklistItem | null;
  workflow: LoadedMissionWorkflow;
  providerResult: MissionProviderResult;
  attemptCount: number;
  turnCount: number;
  runtimeMs: number | null;
  artifactBytes: number | null;
}

export interface MissionVerifierResult {
  verdict: MissionVerifierVerdict;
  summary: string;
  missingAcceptanceCriteria: string[];
  budgetExceeded: boolean;
  budgetExceededReasons: string[];
  progressSummary: string | null;
  nextStep: string | null;
  latestBlocker: string | null;
  planChangeSuggestion: MissionPlanChangeSuggestion | null;
}

export interface CreateMissionVerifierResultInput {
  verdict?: MissionVerifierVerdict | string | null;
  summary?: string | null;
  missingAcceptanceCriteria?: readonly string[] | null;
  budgetExceededReasons?: readonly string[] | null;
  progressSummary?: string | null;
  nextStep?: string | null;
  latestBlocker?: string | null;
  planChangeSuggestion?: MissionPlanChangeSuggestion | null;
}

export interface MissionPlanChangeSuggestion {
  rationale: string;
  proposedExpectedOutput?: string | null;
  proposedAcceptanceCriteria?: string[] | null;
  proposedPlan?: string[] | null;
}

export interface ResolvedMissionPlanChangeSuggestion {
  rationale: string;
  proposedExpectedOutput: string | null;
  proposedAcceptanceCriteria: string[];
  proposedPlan: string[];
}

export interface MissionVerifier {
  verify(input: MissionVerifierInput): Promise<MissionVerifierResult>;
}

export interface MissionVerifierBudget {
  maxAttempts: number | null;
  maxTurns: number | null;
  maxRuntimeMs: number | null;
  maxArtifactCount: number | null;
  maxArtifactBytes: number | null;
}

export interface MissionVerifierBudgetUsage {
  attemptCount: number;
  turnCount: number;
  runtimeMs: number | null;
  artifactCount: number;
  artifactBytes: number | null;
}

export interface CreateMissionRepairPromptInput {
  mission: Mission;
  attempt: MissionAttempt;
  checklistSnapshot?: ChecklistSnapshot | null;
  workflow: LoadedMissionWorkflow;
  verifierResult: Pick<MissionVerifierResult, 'summary' | 'missingAcceptanceCriteria'>;
}

export function normalizeMissionVerifierVerdict(
  verdict: MissionVerifierVerdict | string | null | undefined,
  fallback: MissionVerifierVerdict = 'failed',
): MissionVerifierVerdict {
  if (typeof verdict !== 'string') {
    return fallback;
  }
  const normalized = verdict.trim().toLowerCase();
  if (!MISSION_VERIFIER_VERDICT_SET.has(normalized as MissionVerifierVerdict)) {
    return fallback;
  }
  return normalized as MissionVerifierVerdict;
}

export function createMissionVerifierResult(
  input: CreateMissionVerifierResultInput,
): MissionVerifierResult {
  const missingAcceptanceCriteria = normalizeStringList(input.missingAcceptanceCriteria);
  const budgetExceededReasons = normalizeStringList(input.budgetExceededReasons);
  const fallbackVerdict = missingAcceptanceCriteria.length > 0 ? 'repair' : 'failed';
  const verdict = normalizeMissionVerifierVerdict(input.verdict, fallbackVerdict);
  const summary = normalizeText(input.summary)
    ?? buildDefaultMissionVerifierSummary(verdict, missingAcceptanceCriteria, budgetExceededReasons);

  return {
    verdict,
    summary,
    missingAcceptanceCriteria,
    budgetExceeded: budgetExceededReasons.length > 0,
    budgetExceededReasons,
    progressSummary: normalizeText(input.progressSummary) ?? summary,
    nextStep: normalizeText(input.nextStep),
    latestBlocker: normalizeText(input.latestBlocker),
    planChangeSuggestion: normalizeMissionPlanChangeSuggestion(input.planChangeSuggestion),
  };
}

export function normalizeMissionPlanChangeSuggestion(
  value: MissionPlanChangeSuggestion | null | undefined,
): MissionPlanChangeSuggestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const rationale = normalizeText(value.rationale);
  if (!rationale) {
    return null;
  }
  const hasExpectedOutput = hasOwn(value, 'proposedExpectedOutput');
  const hasAcceptanceCriteria = hasOwn(value, 'proposedAcceptanceCriteria');
  const hasPlan = hasOwn(value, 'proposedPlan');
  if (!hasExpectedOutput && !hasAcceptanceCriteria && !hasPlan) {
    return null;
  }
  const suggestion: MissionPlanChangeSuggestion = {
    rationale,
  };
  if (hasExpectedOutput) {
    suggestion.proposedExpectedOutput = normalizeText(value.proposedExpectedOutput) ?? null;
  }
  if (hasAcceptanceCriteria) {
    suggestion.proposedAcceptanceCriteria = value.proposedAcceptanceCriteria === null
      ? null
      : normalizeStringList(value.proposedAcceptanceCriteria);
  }
  if (hasPlan) {
    suggestion.proposedPlan = value.proposedPlan === null
      ? null
      : normalizeStringList(value.proposedPlan);
  }
  return suggestion;
}

export function resolveMissionPlanChangeSuggestion(
  mission: Pick<Mission, 'expectedOutput' | 'acceptanceCriteria' | 'plan'>,
  suggestion: MissionPlanChangeSuggestion | null | undefined,
): ResolvedMissionPlanChangeSuggestion | null {
  const normalized = normalizeMissionPlanChangeSuggestion(suggestion);
  if (!normalized) {
    return null;
  }
  const proposedExpectedOutput = hasOwn(normalized, 'proposedExpectedOutput')
    ? normalizeText(normalized.proposedExpectedOutput) ?? mission.expectedOutput
    : mission.expectedOutput;
  const proposedAcceptanceCriteria = hasOwn(normalized, 'proposedAcceptanceCriteria')
    ? normalized.proposedAcceptanceCriteria === null
      ? [...mission.acceptanceCriteria]
      : normalizeStringList(normalized.proposedAcceptanceCriteria)
    : [...mission.acceptanceCriteria];
  const proposedPlan = hasOwn(normalized, 'proposedPlan')
    ? normalized.proposedPlan === null
      ? [...mission.plan]
      : normalizeStringList(normalized.proposedPlan)
    : [...mission.plan];
  const changed = proposedExpectedOutput !== mission.expectedOutput
    || !isSameStringList(proposedAcceptanceCriteria, mission.acceptanceCriteria)
    || !isSameStringList(proposedPlan, mission.plan);
  if (!changed) {
    return null;
  }
  return {
    rationale: normalized.rationale,
    proposedExpectedOutput,
    proposedAcceptanceCriteria,
    proposedPlan,
  };
}

export function mapMissionVerifierVerdictToMissionStatus(
  verdict: MissionVerifierVerdict,
): MissionStatus {
  switch (verdict) {
    case 'complete':
      return 'completed';
    case 'repair':
      return 'repairing';
    case 'blocked':
      return 'blocked';
    case 'waiting_user':
      return 'waiting_user';
    case 'needs_human':
      return 'needs_human';
    case 'handoff':
      return 'handoff';
    case 'failed':
      return 'failed';
  }
}

export function mapMissionVerifierVerdictToAttemptStatus(
  verdict: MissionVerifierVerdict,
): MissionAttempt['status'] {
  switch (verdict) {
    case 'complete':
      return 'completed';
    case 'repair':
      return 'repairing';
    case 'blocked':
      return 'blocked';
    case 'waiting_user':
      return 'waiting_user';
    case 'needs_human':
      return 'needs_human';
    case 'handoff':
      return 'handoff';
    case 'failed':
      return 'failed';
  }
}

export function applyMissionVerifierResultToAttempt(
  attempt: MissionAttempt,
  result: MissionVerifierResult,
  now = Date.now(),
): MissionAttempt {
  return {
    ...attempt,
    status: mapMissionVerifierVerdictToAttemptStatus(result.verdict),
    verifierVerdict: result.verdict,
    verifierSummary: result.summary,
    missingAcceptanceCriteria: [...result.missingAcceptanceCriteria],
    error: result.verdict === 'complete' ? null : result.summary,
    endedAt: now,
    updatedAt: now,
  };
}

export function applyMissionVerifierResultToWorkpad(
  workpad: MissionWorkpad,
  result: MissionVerifierResult,
  now = Date.now(),
): MissionWorkpad {
  const missingSummary = result.missingAcceptanceCriteria.length > 0
    ? `Missing acceptance criteria: ${result.missingAcceptanceCriteria.join('; ')}`
    : null;
  return {
    ...workpad,
    summary: result.progressSummary ?? result.summary,
    latestVerifierSummary: result.summary,
    latestBlocker: result.verdict === 'complete'
      ? null
      : result.latestBlocker ?? missingSummary ?? result.summary,
    finalResultSummary: result.verdict === 'complete'
      ? result.summary
      : workpad.finalResultSummary,
    updatedAt: now,
  };
}

export function applyMissionVerifierResultToMission(
  mission: Mission,
  result: MissionVerifierResult,
  options: {
    at?: number;
    resultText?: string | null;
    resultArtifacts?: unknown[];
  } = {},
): Mission {
  const at = options.at ?? Date.now();
  const nextStatus = mapMissionVerifierVerdictToMissionStatus(result.verdict);
  return transitionMission(mission, nextStatus, {
    at,
    reason: result.summary,
    lastError: result.verdict === 'complete' ? null : result.summary,
    resultText: result.verdict === 'complete'
      ? (options.resultText ?? mission.resultText)
      : mission.resultText,
    resultArtifacts: options.resultArtifacts ?? mission.resultArtifacts,
    workpad: applyMissionVerifierResultToWorkpad(mission.workpad, result, at),
  });
}

export function createMissionRepairPrompt(input: CreateMissionRepairPromptInput): string {
  const basePrompt = renderMissionAttemptPromptContract(createMissionAttemptPromptContract({
    mission: input.mission,
    attempt: input.attempt,
    workflow: input.workflow,
    checklistSnapshot: input.checklistSnapshot ?? null,
  }));
  const lines = [
    basePrompt,
    '',
    'Verifier repair contract',
    `Verifier summary: ${input.verifierResult.summary}`,
    'Missing acceptance criteria:',
    ...renderBullets(input.verifierResult.missingAcceptanceCriteria),
    'Use this verifier feedback to repair the mission instead of starting from scratch.',
  ];
  return lines.join('\n').trim();
}

export function resolveMissionVerifierBudget(input: {
  mission: Pick<Mission, 'maxAttempts' | 'maxTurns' | 'loopPolicy'>;
  workflow: Pick<LoadedMissionWorkflow, 'policy'>;
}): MissionVerifierBudget {
  return {
    maxAttempts: chooseSmallestPositiveInteger(
      input.mission.loopPolicy.maxAttempts,
      input.mission.maxAttempts,
      input.workflow.policy.maxAttempts,
    ),
    maxTurns: chooseSmallestPositiveInteger(
      input.mission.loopPolicy.maxTurns,
      input.mission.maxTurns,
      input.workflow.policy.maxTurns,
    ),
    maxRuntimeMs: input.workflow.policy.maxRuntimeMs,
    maxArtifactCount: input.workflow.policy.maxArtifactCount,
    maxArtifactBytes: input.workflow.policy.maxArtifactBytes,
  };
}

export function evaluateMissionVerifierBudget(
  budget: MissionVerifierBudget,
  usage: MissionVerifierBudgetUsage,
): string[] {
  const issues: string[] = [];
  if (budget.maxAttempts !== null && usage.attemptCount >= budget.maxAttempts) {
    issues.push(`max attempts exhausted (${usage.attemptCount}/${budget.maxAttempts})`);
  }
  if (budget.maxTurns !== null && usage.turnCount >= budget.maxTurns) {
    issues.push(`max turns exhausted (${usage.turnCount}/${budget.maxTurns})`);
  }
  if (budget.maxRuntimeMs !== null && usage.runtimeMs !== null && usage.runtimeMs >= budget.maxRuntimeMs) {
    issues.push(`max runtime exhausted (${usage.runtimeMs}ms/${budget.maxRuntimeMs}ms)`);
  }
  if (budget.maxArtifactCount !== null && usage.artifactCount >= budget.maxArtifactCount) {
    issues.push(`max artifact count exhausted (${usage.artifactCount}/${budget.maxArtifactCount})`);
  }
  if (budget.maxArtifactBytes !== null && usage.artifactBytes !== null && usage.artifactBytes >= budget.maxArtifactBytes) {
    issues.push(`max artifact bytes exhausted (${usage.artifactBytes}/${budget.maxArtifactBytes})`);
  }
  return issues;
}

function buildDefaultMissionVerifierSummary(
  verdict: MissionVerifierVerdict,
  missingAcceptanceCriteria: string[],
  budgetExceededReasons: string[],
): string {
  if (budgetExceededReasons.length > 0) {
    return `Mission budget exhausted: ${budgetExceededReasons.join('; ')}`;
  }
  if (verdict === 'complete') {
    return 'Acceptance criteria satisfied.';
  }
  if (verdict === 'repair' && missingAcceptanceCriteria.length > 0) {
    return `Acceptance criteria still missing: ${missingAcceptanceCriteria.join('; ')}`;
  }
  if (verdict === 'blocked') {
    return 'Mission is blocked and needs an explicit unblock before continuing.';
  }
  if (verdict === 'waiting_user') {
    return 'Mission is waiting for user input before continuing.';
  }
  if (verdict === 'needs_human') {
    return 'Mission needs human intervention before continuing.';
  }
  if (verdict === 'handoff') {
    return 'Mission is ready for a handoff to the next operator or system.';
  }
  return 'Mission verification failed.';
}

function chooseSmallestPositiveInteger(...values: Array<number | null | undefined>): number | null {
  const normalized = values.filter((value): value is number => typeof value === 'number' && value > 0);
  if (normalized.length === 0) {
    return null;
  }
  return Math.min(...normalized);
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringList(values: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const normalized: string[] = [];
  for (const value of values) {
    const text = normalizeText(value);
    if (!text) {
      continue;
    }
    normalized.push(text);
  }
  return normalized;
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isSameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function renderBullets(values: readonly string[]): string[] {
  if (values.length === 0) {
    return ['- none'];
  }
  return values.map((value) => `- ${value}`);
}
