import {
  MissionRuntime,
  createMission,
  createMissionVerifierResult,
  isMissionResumable,
  normalizeCodexMissionDriverResult,
  transitionMission,
  type Mission,
  type MissionAttempt,
  type MissionEvent,
  type MissionExecutionInput,
  type MissionProvider,
  type MissionProviderArtifact,
  type MissionProviderResult,
  type MissionRepository,
  type MissionRunResult,
  type MissionVerifier,
  type MissionVerifierResult,
} from '../../packages/mission-control/src/index.js';
import { AutomationJobService } from './automation_job_service.js';
import type {
  AutomationJob,
  BridgeSession,
  MissionAttemptHistoryEntry,
  MissionRuntimeStateSnapshot,
  PlatformScopeRef,
} from '../types/core.js';
import type { OutputArtifact, ProviderApprovalRequest, ProviderTurnProgress } from '../types/provider.js';

type ProgressHandler = ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
type ApprovalHandler = ((request: ProviderApprovalRequest) => Promise<void> | void) | null;

type BridgeMissionTurnResult = {
  result: {
    outputText?: string | null;
    previewText?: string | null;
    errorMessage?: string | null;
    outputState?: string | null;
    outputArtifacts?: OutputArtifact[] | null;
    outputMedia?: OutputArtifact[] | null;
    finalSource?: string | null;
    threadId?: string | null;
    turnId?: string | null;
    title?: string | null;
  };
  session: BridgeSession;
};

type MissionControlAutomationJobRunProgressText = {
  running: (attempt: number, maxAttempts: number) => string;
  verifying: () => string;
  retrying: () => string;
};

export interface RunAutomationJobWithMissionControlOptions {
  job: AutomationJob;
  automationJobs: AutomationJobService;
  resolveSession: (job: AutomationJob) => BridgeSession | null;
  startTurnWithRecovery: (
    scopeRef: PlatformScopeRef,
    session: BridgeSession,
    event: {
      platform: string;
      externalScopeId: string;
      text: string;
      cwd: string | null;
      locale: string | null;
      attachments: unknown[];
      metadata: Record<string, unknown>;
    },
    options: {
      onProgress?: ProgressHandler;
      onApprovalRequest?: ApprovalHandler;
    },
  ) => Promise<BridgeMissionTurnResult>;
  stopSession: (scopeRef: PlatformScopeRef, session: BridgeSession) => Promise<void>;
  progressText?: Partial<MissionControlAutomationJobRunProgressText>;
  now?: () => number;
  onProgress?: ProgressHandler;
  onApprovalRequest?: ApprovalHandler;
}

export interface MissionControlAutomationJobRunOutput {
  runResult: MissionRunResult;
  finalJob: AutomationJob;
  finalSession: BridgeSession | null;
  finalBridgeResult: BridgeMissionTurnResult['result'] | null;
}

type MissionRuntimeState = {
  mission: Mission | null;
  attempts: MissionAttempt[];
  events: MissionEvent[];
};

type BridgeMissionExecutionRecord = BridgeMissionTurnResult & {
  normalizedResult: MissionProviderResult;
};

export async function runAutomationJobWithMissionControl(
  options: RunAutomationJobWithMissionControlOptions,
): Promise<MissionControlAutomationJobRunOutput> {
  const now = options.now ?? (() => Date.now());
  const repository = new AutomationJobMissionRepository(options.automationJobs);
  const scopeRef = {
    platform: options.job.platform,
    externalScopeId: options.job.externalScopeId,
  };
  const initialSession = options.resolveSession(options.job);
  const mission = prepareMissionSnapshot({
    job: options.job,
    session: initialSession,
    repository,
    now,
  });
  const syncBridgeSession = (nextSession: BridgeSession) => {
    const currentJob = options.automationJobs.getById(options.job.id);
    if (currentJob && currentJob.bridgeSessionId !== nextSession.id) {
      options.automationJobs.updateJob(currentJob.id, {
        bridgeSessionId: nextSession.id,
      });
    }
    const currentMission = repository.getMissionById(options.job.id);
    if (
      currentMission
      && (
        currentMission.bridgeSessionId !== nextSession.id
        || currentMission.codexThreadId !== nextSession.codexThreadId
      )
    ) {
      repository.saveMission({
        ...currentMission,
        bridgeSessionId: nextSession.id,
        codexThreadId: nextSession.codexThreadId,
        updatedAt: now(),
      });
    }
  };
  const progressText: MissionControlAutomationJobRunProgressText = {
    running: options.progressText?.running ?? (() => ''),
    verifying: options.progressText?.verifying ?? (() => ''),
    retrying: options.progressText?.retrying ?? (() => ''),
  };
  const provider = new BridgeMissionProvider({
    jobId: options.job.id,
    scopeRef,
    resolveJob: () => options.automationJobs.getById(options.job.id) ?? options.job,
    resolveSession: () => options.resolveSession(options.automationJobs.getById(options.job.id) ?? options.job),
    startTurnWithRecovery: options.startTurnWithRecovery,
    stopSession: options.stopSession,
    progressText,
    onProgress: options.onProgress ?? null,
    onApprovalRequest: options.onApprovalRequest ?? null,
    syncBridgeSession,
  });
  const verifier = new BridgeMissionVerifier({
    progressText,
    onProgress: options.onProgress ?? null,
  });

  const runtime = new MissionRuntime({
    repository,
    provider,
    verifier,
    now,
  });
  const runResult = await runtime.runMission(mission.id, {
    ownerId: `automation-job:${options.job.id}`,
    readOnly: true,
    allowSharedCwd: true,
  });
  const finalJob = options.automationJobs.getById(options.job.id) ?? options.job;
  const finalRunId = runResult.attempt?.providerRunId ?? null;
  const finalExecution = finalRunId ? provider.getExecutionRecord(finalRunId) : provider.getLastExecutionRecord();

  return {
    runResult,
    finalJob,
    finalSession: finalExecution?.session ?? options.resolveSession(finalJob),
    finalBridgeResult: finalExecution?.result ?? null,
  };
}

class AutomationJobMissionRepository implements MissionRepository {
  constructor(
    private readonly automationJobs: AutomationJobService,
  ) {}

  getMissionById(id: string): Mission | null {
    const job = this.automationJobs.getById(id);
    return job ? loadMissionRuntimeState(job).mission : null;
  }

  listMissions(): Mission[] {
    return this.automationJobs
      .listAllJobs()
      .map((job) => loadMissionRuntimeState(job).mission)
      .filter(Boolean) as Mission[];
  }

  listResumableMissions(now = Date.now()): Mission[] {
    return this.listMissions().filter((mission) => isMissionResumable(mission, now));
  }

  saveMission(mission: Mission): Mission {
    const currentJob = this.automationJobs.requireById(mission.id);
    const currentState = loadMissionRuntimeState(currentJob);
    const nextState: MissionRuntimeState = {
      ...currentState,
      mission: cloneValue(mission),
    };
    this.persistState(currentJob, nextState);
    return mission;
  }

  getAttemptById(id: string): MissionAttempt | null {
    for (const job of this.automationJobs.listAllJobs()) {
      const state = loadMissionRuntimeState(job);
      const attempt = state.attempts.find((entry) => entry.id === id);
      if (attempt) {
        return cloneValue(attempt);
      }
    }
    return null;
  }

  listAttempts(missionId: string): MissionAttempt[] {
    const job = this.automationJobs.getById(missionId);
    return job ? loadMissionRuntimeState(job).attempts : [];
  }

  saveAttempt(attempt: MissionAttempt): MissionAttempt {
    const currentJob = this.automationJobs.requireById(attempt.missionId);
    const currentState = loadMissionRuntimeState(currentJob);
    const nextState: MissionRuntimeState = {
      ...currentState,
      attempts: upsertById(currentState.attempts, attempt).sort((left, right) => left.index - right.index),
    };
    this.persistState(currentJob, nextState);
    return attempt;
  }

  listEvents(missionId: string): MissionEvent[] {
    const job = this.automationJobs.getById(missionId);
    return job ? loadMissionRuntimeState(job).events : [];
  }

  appendEvent(event: MissionEvent): MissionEvent {
    const currentJob = this.automationJobs.requireById(event.missionId);
    const currentState = loadMissionRuntimeState(currentJob);
    const nextState: MissionRuntimeState = {
      ...currentState,
      events: [...currentState.events, cloneValue(event)],
    };
    this.persistState(currentJob, nextState);
    return event;
  }

  resetMission(mission: Mission): Mission {
    const currentJob = this.automationJobs.requireById(mission.id);
    this.persistState(currentJob, {
      mission: cloneValue(mission),
      attempts: [],
      events: [],
    });
    return mission;
  }

  private persistState(job: AutomationJob, state: MissionRuntimeState): AutomationJob {
    const patch = buildAutomationJobMissionPatch(job, state);
    return this.automationJobs.updateJob(job.id, patch);
  }
}

class BridgeMissionProvider implements MissionProvider {
  readonly kind = 'codexbridge-automation-job';

  private runCounter = 0;

  private readonly executionRecords = new Map<string, BridgeMissionExecutionRecord>();

  private lastRunId: string | null = null;

  private readonly runningAttempts = new Set<string>();

  constructor(private readonly options: {
    jobId: string;
    scopeRef: PlatformScopeRef;
    resolveJob: () => AutomationJob;
    resolveSession: () => BridgeSession | null;
    startTurnWithRecovery: RunAutomationJobWithMissionControlOptions['startTurnWithRecovery'];
    stopSession: RunAutomationJobWithMissionControlOptions['stopSession'];
    progressText: MissionControlAutomationJobRunProgressText;
    onProgress: ProgressHandler;
    onApprovalRequest: ApprovalHandler;
    syncBridgeSession: (session: BridgeSession) => void;
  }) {}

  async start(input: MissionExecutionInput) {
    return this.beginTurn(input);
  }

  async continue(input: MissionExecutionInput) {
    return this.beginTurn(input);
  }

  async wait(runId: string): Promise<MissionProviderResult> {
    return this.requireExecutionRecord(runId).normalizedResult;
  }

  async interrupt(_runId: string): Promise<void> {
    const session = this.options.resolveSession();
    if (!session) {
      return;
    }
    await this.options.stopSession(this.options.scopeRef, session);
  }

  getExecutionRecord(runId: string): BridgeMissionExecutionRecord | null {
    return this.executionRecords.get(runId) ?? null;
  }

  getLastExecutionRecord(): BridgeMissionExecutionRecord | null {
    if (!this.lastRunId) {
      return null;
    }
    return this.getExecutionRecord(this.lastRunId);
  }

  private async beginTurn(input: MissionExecutionInput) {
    const liveJob = this.options.resolveJob();
    const session = this.options.resolveSession();
    if (!session) {
      throw new Error('Automation mission session is missing.');
    }
    if (!this.runningAttempts.has(input.attempt.id)) {
      this.runningAttempts.add(input.attempt.id);
      await emitProgress(
        this.options.onProgress,
        this.options.progressText.running(input.attempt.index, input.mission.maxAttempts),
      );
    }
    this.runCounter += 1;
    const runId = `${input.attempt.id}-provider-turn-${this.runCounter}`;
    const execution = await this.options.startTurnWithRecovery(
      this.options.scopeRef,
      session,
      {
        platform: input.mission.platform,
        externalScopeId: input.mission.externalScopeId,
        text: buildAutomationMissionExecutionPrompt(input.promptText, liveJob.locale),
        cwd: liveJob.cwd ?? input.mission.cwd,
        locale: liveJob.locale,
        attachments: [],
        metadata: {
          codexbridge: {
            overrideBridgeSessionId: session.id,
            automationJobId: this.options.jobId,
            automationMode: liveJob.mode,
            automationAttempt: input.attempt.index,
            missionId: input.mission.id,
            missionAttemptId: input.attempt.id,
          },
        },
      },
      {
        onProgress: this.options.onProgress,
        onApprovalRequest: this.options.onApprovalRequest,
      },
    );
    this.options.syncBridgeSession(execution.session);
    const normalizedResult = normalizeBridgeMissionProviderResult(execution.result);
    const record: BridgeMissionExecutionRecord = {
      ...execution,
      normalizedResult: normalizedResult.outcome === 'interrupted'
        ? {
          ...normalizedResult,
          outcome: 'completed',
          continuationEligible: false,
        }
        : normalizedResult,
    };
    this.executionRecords.set(runId, record);
    this.lastRunId = runId;
    return {
      providerRunId: runId,
      providerThreadId: execution.session.codexThreadId,
      previewText: execution.result.previewText ?? execution.result.outputText ?? null,
    };
  }

  private requireExecutionRecord(runId: string): BridgeMissionExecutionRecord {
    const record = this.executionRecords.get(runId);
    if (!record) {
      throw new Error(`Unknown mission provider run: ${runId}`);
    }
    return record;
  }
}

class BridgeMissionVerifier implements MissionVerifier {
  constructor(private readonly options: {
    progressText: MissionControlAutomationJobRunProgressText;
    onProgress: ProgressHandler;
  }) {}

  async verify(input: {
    mission: Mission;
    attempt: MissionAttempt;
    workflow: unknown;
    providerResult: MissionProviderResult;
    attemptCount: number;
    turnCount: number;
    runtimeMs: number | null;
    artifactBytes: number | null;
  }): Promise<MissionVerifierResult> {
    await emitProgress(this.options.onProgress, this.options.progressText.verifying());
    const hardFailure = resolveAutomationHardFailure(input.providerResult);
    if (hardFailure) {
      await emitProgress(this.options.onProgress, this.options.progressText.retrying());
      return createMissionVerifierResult({
        verdict: 'repair',
        summary: hardFailure,
        missingAcceptanceCriteria: [hardFailure],
      });
    }
    const hasDeliverable = Boolean(compactString(input.providerResult.text)) || input.providerResult.artifacts.length > 0;
    if (!hasDeliverable) {
      const summary = 'Scheduled automation did not produce a final deliverable yet.';
      await emitProgress(this.options.onProgress, this.options.progressText.retrying());
      return createMissionVerifierResult({
        verdict: 'repair',
        summary,
        missingAcceptanceCriteria: [
          'Produce a final user-deliverable result for the scheduled automation task.',
        ],
      });
    }
    return createMissionVerifierResult({
      verdict: 'complete',
      summary: 'Scheduled automation produced a deliverable result.',
    });
  }
}

function prepareMissionSnapshot(input: {
  job: AutomationJob;
  session: BridgeSession | null;
  repository: AutomationJobMissionRepository;
  now: () => number;
}): Mission {
  const existing = input.repository.getMissionById(input.job.id);
  if (!existing) {
    return input.repository.resetMission(buildFreshMission(input.job, input.session, input.now));
  }
  if (existing.status === 'draft') {
    const queued = transitionMission(existing, 'queued', {
      at: input.now(),
      reason: 'Scheduled automation mission re-queued through the bridge adapter.',
    });
    return input.repository.saveMission(queued);
  }
  if (
    existing.status === 'planning'
    || existing.status === 'running'
    || !isMissionResumable(existing, input.now())
  ) {
    return input.repository.resetMission(buildFreshMission(input.job, input.session, input.now));
  }
  return existing;
}

function buildFreshMission(job: AutomationJob, session: BridgeSession | null, now: () => number): Mission {
  return transitionMission(createMission({
    id: job.id,
    source: 'automation',
    sourceRef: job.id,
    platform: job.platform,
    externalScopeId: job.externalScopeId,
    title: job.title,
    goal: job.prompt,
    expectedOutput: 'A final scheduled-task result that can be delivered back to the user.',
    acceptanceCriteria: [
      'Produce a final user-deliverable result for the scheduled automation task.',
    ],
    plan: [
      'Execute the scheduled automation task.',
      'Verify the result is ready for delivery back to the user.',
    ],
    riskLevel: 'low',
    cwd: job.cwd,
    workflowPath: job.missionWorkflowPath ?? null,
    providerProfileId: job.providerProfileId,
    bridgeSessionId: job.bridgeSessionId,
    codexThreadId: session?.codexThreadId ?? null,
    maxAttempts: 2,
    maxTurns: 6,
    now: now(),
  }), 'queued', {
    at: now(),
    reason: 'Scheduled automation mission queued through the bridge adapter.',
  });
}

function buildAutomationJobMissionPatch(job: AutomationJob, state: MissionRuntimeState): Partial<AutomationJob> {
  const mission = state.mission;
  if (!mission) {
    return {
      missionRuntimeState: null,
      missionAttemptHistory: [],
    };
  }
  const attempts = [...state.attempts].sort((left, right) => left.index - right.index);
  return {
    lastRunAt: mission.lastRunAt,
    lastResultPreview: summarizeMissionPreview(mission.lastResultPreview, mission.resultArtifacts) ?? job.lastResultPreview,
    lastError: mission.status === 'completed' ? null : (mission.lastError ?? mission.statusReason),
    missionWorkflowPath: mission.workflowPath,
    missionWorkflowSourceLabel: mission.workflowPath
      ? `configured workflow (${mission.workflowPath})`
      : job.missionWorkflowSourceLabel ?? null,
    missionWorkpadLatestBlocker: mission.workpad.latestBlocker,
    missionWorkpadLatestVerifierSummary: mission.workpad.latestVerifierSummary,
    missionWorkpadFinalResultSummary: mission.workpad.finalResultSummary ?? mission.lastResultPreview,
    missionAttemptHistory: buildAttemptHistory(attempts),
    missionRuntimeState: serializeMissionRuntimeState(state),
  };
}

function buildAttemptHistory(attempts: MissionAttempt[]): MissionAttemptHistoryEntry[] {
  return attempts.map((attempt) => ({
    attempt: attempt.index,
    status: mapMissionAttemptStatusToHistoryStatus(attempt.status),
    verifierSummary: attempt.verifierSummary,
    outputPreview: attempt.outputPreview,
    error: attempt.error,
    recordedAt: attempt.endedAt ?? attempt.updatedAt,
  }));
}

function mapMissionAttemptStatusToHistoryStatus(status: MissionAttempt['status']): MissionAttemptHistoryEntry['status'] {
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

function summarizeMissionPreview(value: string | null, artifacts: unknown[]): string | null {
  const text = compactString(value);
  if (text) {
    return text.length > 180 ? `${text.slice(0, 179)}...` : text;
  }
  const artifactCount = Array.isArray(artifacts) ? artifacts.length : 0;
  return artifactCount > 0 ? `attachments: ${artifactCount}` : null;
}

function loadMissionRuntimeState(job: AutomationJob): MissionRuntimeState {
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

function serializeMissionRuntimeState(state: MissionRuntimeState): MissionRuntimeStateSnapshot {
  return {
    mission: state.mission ? (cloneValue(state.mission) as unknown as Record<string, unknown>) : null,
    attempts: state.attempts.map((attempt) => cloneValue(attempt) as unknown as Record<string, unknown>),
    events: state.events.map((event) => cloneValue(event) as unknown as Record<string, unknown>),
  };
}

function normalizeBridgeMissionProviderResult(
  result: BridgeMissionTurnResult['result'],
): MissionProviderResult {
  return normalizeCodexMissionDriverResult({
    outputState: result.outputState ?? null,
    outputText: result.outputText ?? null,
    previewText: result.previewText ?? null,
    errorMessage: result.errorMessage ?? null,
    outputArtifacts: normalizeBridgeArtifacts(result),
  });
}

function buildAutomationMissionExecutionPrompt(promptText: string, locale: string | null): string {
  const prefix = locale === 'zh-CN'
    ? '你正在执行 CodexBridge 定时自动化任务。请直接完成任务，并返回适合发送给用户的最终结果。'
    : 'You are executing a CodexBridge scheduled automation task. Complete the task and return a final user-deliverable result.';
  return [
    prefix,
    '',
    promptText,
  ].join('\n').trim();
}

function normalizeBridgeArtifacts(result: BridgeMissionTurnResult['result']): MissionProviderArtifact[] {
  const artifacts = [
    ...(Array.isArray(result.outputArtifacts) ? result.outputArtifacts : []),
    ...(Array.isArray(result.outputMedia) ? result.outputMedia : []),
  ];
  return artifacts
    .map((artifact) => {
      const path = compactString(artifact?.path);
      const type = compactString(artifact?.kind);
      if (!path || !type) {
        return null;
      }
      return {
        type: type === 'file' || type === 'image' || type === 'video' || type === 'audio'
          ? type
          : 'other',
        path,
        name: compactString(artifact?.displayName),
        mimeType: compactString(artifact?.mimeType),
        caption: compactString(artifact?.caption),
      } satisfies MissionProviderArtifact;
    })
    .filter(Boolean) as MissionProviderArtifact[];
}

function resolveAutomationHardFailure(result: MissionProviderResult): string | null {
  if (result.rawState === 'interrupted') {
    return 'The scheduled automation run was interrupted before it finished.';
  }
  if (result.errorMessage && !compactString(result.text) && result.artifacts.length === 0) {
    return result.errorMessage;
  }
  return null;
}

function upsertById<T extends { id: string }>(items: T[], value: T): T[] {
  const next = items.map((item) => cloneValue(item));
  const index = next.findIndex((item) => item.id === value.id);
  if (index === -1) {
    next.push(cloneValue(value));
    return next;
  }
  next[index] = cloneValue(value);
  return next;
}

async function emitProgress(handler: ProgressHandler, text: string): Promise<void> {
  if (typeof handler !== 'function') {
    return;
  }
  const normalized = compactString(text);
  if (!normalized) {
    return;
  }
  await handler({
    text: normalized,
    delta: normalized,
    outputKind: 'commentary',
  });
}

function compactString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 ? normalized : null;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
