import type {
  MissionExecutionInput,
  MissionProvider,
  MissionProviderArtifact,
  MissionProviderHandoffState,
  MissionProviderResult,
  MissionProviderStartResult,
} from './provider.js';

export interface CodexMissionDriverExecutionInput {
  missionId: string;
  attemptId: string;
  providerProfileId: string;
  promptText: string;
  workspacePath: string;
  cwd: string | null;
  workflowPath: string | null;
  threadId: string | null;
}

export interface CodexMissionDriverStartResult {
  providerRunId: string;
  providerThreadId: string | null;
  previewText?: string | null;
}

export interface CodexMissionDriverWaitResult {
  outputState?: string | null;
  outputText?: string | null;
  previewText?: string | null;
  errorMessage?: string | null;
  outputArtifacts?: MissionProviderArtifact[];
  requiresHuman?: boolean | null;
  handoffState?: MissionProviderHandoffState | null;
  stopReason?: string | null;
  status?: string | null;
}

export interface CodexMissionDriver {
  start(input: CodexMissionDriverExecutionInput): Promise<CodexMissionDriverStartResult>;
  continue(input: CodexMissionDriverExecutionInput): Promise<CodexMissionDriverStartResult>;
  wait(runId: string, options?: { timeoutMs?: number }): Promise<CodexMissionDriverWaitResult>;
  interrupt(runId: string): Promise<void>;
}

export class CodexMissionProvider implements MissionProvider {
  readonly kind = 'codex';

  constructor(private readonly driver: CodexMissionDriver) {}

  start(input: MissionExecutionInput): Promise<MissionProviderStartResult> {
    return this.driver.start(toCodexMissionDriverExecutionInput(input));
  }

  continue(input: MissionExecutionInput): Promise<MissionProviderStartResult> {
    return this.driver.continue(toCodexMissionDriverExecutionInput(input));
  }

  async wait(runId: string, options?: { timeoutMs?: number }): Promise<MissionProviderResult> {
    const raw = await this.driver.wait(runId, options);
    return normalizeCodexMissionDriverResult(raw);
  }

  interrupt(runId: string): Promise<void> {
    return this.driver.interrupt(runId);
  }
}

export function toCodexMissionDriverExecutionInput(
  input: MissionExecutionInput,
): CodexMissionDriverExecutionInput {
  return {
    missionId: input.mission.id,
    attemptId: input.attempt.id,
    providerProfileId: input.mission.providerProfileId,
    promptText: input.promptText,
    workspacePath: input.workspace.workspacePath,
    cwd: input.workspace.mode === 'shared-cwd'
      ? input.workspace.workspacePath
      : input.mission.cwd,
    workflowPath: input.workflow.source.path,
    threadId: input.attempt.providerThreadId ?? input.mission.codexThreadId,
  };
}

export function normalizeCodexMissionDriverResult(
  raw: CodexMissionDriverWaitResult,
): MissionProviderResult {
  const rawState = normalizeRawState(raw.outputState ?? raw.status ?? null);
  const handoffState = normalizeHandoffState(raw.handoffState ?? null, raw.requiresHuman ?? false);
  const text = normalizeText(raw.outputText);
  const previewText = normalizeText(raw.previewText);
  const artifacts = Array.isArray(raw.outputArtifacts) ? [...raw.outputArtifacts] : [];
  const errorMessage = normalizeText(raw.errorMessage);

  if (handoffState) {
    return {
      outcome: 'blocked',
      text,
      artifacts,
      previewText,
      errorMessage,
      requiresHuman: handoffState !== 'handoff',
      handoffState,
      continuationEligible: false,
      stopReason: normalizeText(raw.stopReason),
      rawState,
    };
  }

  if (rawState === 'interrupted') {
    return {
      outcome: 'interrupted',
      text,
      artifacts,
      previewText,
      errorMessage,
      requiresHuman: false,
      handoffState: null,
      continuationEligible: false,
      stopReason: normalizeText(raw.stopReason) ?? 'interrupted',
      rawState,
    };
  }

  if (rawState === 'provider_error' || rawState === 'failed') {
    return {
      outcome: rawState,
      text,
      artifacts,
      previewText,
      errorMessage,
      requiresHuman: false,
      handoffState: null,
      continuationEligible: false,
      stopReason: normalizeText(raw.stopReason),
      rawState,
    };
  }

  if (rawState === 'partial' || rawState === 'missing') {
    return {
      outcome: rawState,
      text,
      artifacts,
      previewText,
      errorMessage,
      requiresHuman: false,
      handoffState: null,
      continuationEligible: true,
      stopReason: normalizeText(raw.stopReason),
      rawState,
    };
  }

  if (rawState === 'complete' || text || previewText || artifacts.length > 0) {
    return {
      outcome: 'completed',
      text,
      artifacts,
      previewText,
      errorMessage,
      requiresHuman: false,
      handoffState: null,
      continuationEligible: true,
      stopReason: normalizeText(raw.stopReason),
      rawState,
    };
  }

  return {
    outcome: 'failed',
    text,
    artifacts,
    previewText,
    errorMessage: errorMessage ?? 'Codex provider finished without usable output.',
    requiresHuman: false,
    handoffState: null,
    continuationEligible: false,
    stopReason: normalizeText(raw.stopReason),
    rawState,
  };
}

function normalizeRawState(value: string | null | undefined): MissionProviderResult['rawState'] {
  const normalized = normalizeText(value)?.toLowerCase() ?? null;
  if (!normalized) {
    return null;
  }
  switch (normalized) {
    case 'complete':
    case 'completed':
      return 'complete';
    case 'interrupted':
    case 'cancelled':
    case 'canceled':
    case 'aborted':
    case 'stopped':
      return 'interrupted';
    case 'provider_error':
      return 'provider_error';
    case 'partial':
      return 'partial';
    case 'missing':
      return 'missing';
    case 'failed':
    case 'error':
    case 'timed_out':
    case 'timeout':
      return 'failed';
    default:
      return normalized;
  }
}

function normalizeHandoffState(
  value: MissionProviderHandoffState | null | undefined,
  requiresHuman: boolean,
): MissionProviderHandoffState | null {
  if (value === 'waiting_user' || value === 'needs_human' || value === 'handoff') {
    return value;
  }
  if (requiresHuman) {
    return 'needs_human';
  }
  return null;
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
