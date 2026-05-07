import type { Mission, MissionAttempt, MissionStatus } from './types.js';
import type { LoadedMissionWorkflow } from './workflow.js';
import type { MissionWorkspaceAssignment } from './workspace.js';

export type MissionProviderArtifactType = 'image' | 'file' | 'video' | 'audio' | 'other';

export interface MissionProviderArtifact {
  type: MissionProviderArtifactType;
  name?: string | null;
  path?: string | null;
  uri?: string | null;
  mimeType?: string | null;
  caption?: string | null;
}

export type MissionProviderOutcome =
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'partial'
  | 'missing'
  | 'provider_error';

export type MissionProviderHandoffState = 'waiting_user' | 'needs_human' | 'handoff';

export interface MissionExecutionInput {
  mission: Mission;
  attempt: MissionAttempt;
  workflow: LoadedMissionWorkflow;
  workspace: MissionWorkspaceAssignment;
  promptText: string;
}

export interface MissionProviderStartResult {
  providerRunId: string;
  providerThreadId: string | null;
  previewText?: string | null;
}

export interface MissionProviderResult {
  outcome: MissionProviderOutcome;
  text: string | null;
  artifacts: MissionProviderArtifact[];
  previewText: string | null;
  errorMessage: string | null;
  requiresHuman: boolean;
  handoffState: MissionProviderHandoffState | null;
  continuationEligible: boolean;
  stopReason: string | null;
  rawState: string | null;
}

export interface MissionProvider {
  readonly kind: string;
  start(input: MissionExecutionInput): Promise<MissionProviderStartResult>;
  continue(input: MissionExecutionInput): Promise<MissionProviderStartResult>;
  wait(runId: string, options?: { timeoutMs?: number }): Promise<MissionProviderResult>;
  interrupt(runId: string): Promise<void>;
}

export function applyMissionProviderStartToAttempt(
  attempt: MissionAttempt,
  result: MissionProviderStartResult,
  now = Date.now(),
): MissionAttempt {
  return {
    ...attempt,
    providerRunId: result.providerRunId,
    providerThreadId: result.providerThreadId,
    startedAt: attempt.startedAt ?? now,
    updatedAt: now,
  };
}

export function mapMissionProviderResultToMissionStatus(
  result: MissionProviderResult,
): MissionStatus {
  if (result.handoffState) {
    return result.handoffState;
  }
  switch (result.outcome) {
    case 'completed':
    case 'partial':
    case 'missing':
      return 'verifying';
    case 'blocked':
      return result.requiresHuman ? 'needs_human' : 'blocked';
    case 'interrupted':
    case 'stopped':
      return 'stopped';
    case 'failed':
    case 'provider_error':
      return 'failed';
  }
}

export function canScheduleMissionContinuation(input: {
  missionStatus: MissionStatus;
  remainingAttempts: number;
  result: Pick<MissionProviderResult, 'continuationEligible'>;
}): boolean {
  if (!ACTIVE_MISSION_STATUS.has(input.missionStatus)) {
    return false;
  }
  if (input.remainingAttempts <= 0) {
    return false;
  }
  return input.result.continuationEligible;
}

const ACTIVE_MISSION_STATUS = new Set<MissionStatus>([
  'queued',
  'planning',
  'running',
  'verifying',
  'repairing',
  'handoff',
]);
