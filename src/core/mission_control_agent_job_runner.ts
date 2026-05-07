import {
  MissionRuntime,
  createMission,
  createMissionVerifierResult,
  isMissionResumable,
  normalizeCodexMissionDriverResult,
  normalizeMissionRecord,
  transitionMission,
  type ChecklistSnapshot,
  type Mission,
  type MissionAttempt,
  type MissionEvent,
  type MissionGeneration,
  type MissionExecutionInput,
  type PlanChangeRequest,
  type MissionProvider,
  type MissionProviderArtifact,
  type MissionProviderResult,
  type MissionRepository,
  type MissionRunResult,
  type MissionStatus,
  type MissionVerifier,
  type MissionVerifierResult,
  type WorkItem,
} from '../../packages/mission-control/src/index.js';
import { AgentJobService } from './agent_job_service.js';
import { AgentJobMissionRepository as AgentJobMissionStateRepository } from './mission_control_agent_job_repository.js';
import type {
  AgentJob,
  AgentJobAttemptHistoryEntry,
  AgentJobMissionRuntimeState,
  AgentJobStatus,
  BridgeSession,
  PlatformScopeRef,
  TurnArtifactDeliveredItem,
} from '../types/core.js';
import type { OutputArtifact, ProviderApprovalRequest, ProviderTurnProgress } from '../types/provider.js';

type ProgressHandler = ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
type ApprovalHandler = ((request: ProviderApprovalRequest) => Promise<void> | void) | null;

type AgentVerificationResultLike = {
  pass: boolean;
  summary: string;
  issues: string[];
  nextAction: 'complete' | 'retry' | 'fail';
};

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

type MissionControlAgentJobRunProgressText = {
  running: (attempt: number, maxAttempts: number) => string;
  verifying: () => string;
  retrying: () => string;
};

export interface RunAgentJobWithMissionControlOptions {
  job: AgentJob;
  agentJobs: AgentJobService;
  resolveSession: (job: AgentJob) => BridgeSession | null;
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
  verifyJob: (
    job: AgentJob,
    result: BridgeMissionTurnResult['result'],
    session: BridgeSession | null,
  ) => Promise<AgentVerificationResultLike>;
  progressText: MissionControlAgentJobRunProgressText;
  now?: () => number;
  onProgress?: ProgressHandler;
  onApprovalRequest?: ApprovalHandler;
}

export interface MissionControlAgentJobRunOutput {
  runResult: MissionRunResult;
  finalJob: AgentJob;
  finalSession: BridgeSession | null;
  finalBridgeResult: BridgeMissionTurnResult['result'] | null;
}

type MissionRuntimeState = {
  workItem: WorkItem | null;
  mission: Mission | null;
  generations: MissionGeneration[];
  checklistSnapshots: ChecklistSnapshot[];
  planChangeRequests: PlanChangeRequest[];
  attempts: MissionAttempt[];
  events: MissionEvent[];
};

type BridgeMissionExecutionRecord = BridgeMissionTurnResult & {
  normalizedResult: MissionProviderResult;
};

export async function runAgentJobWithMissionControl(
  options: RunAgentJobWithMissionControlOptions,
): Promise<MissionControlAgentJobRunOutput> {
  const now = options.now ?? (() => Date.now());
  const repository = new AgentJobMissionStateRepository({
    listJobs: () => options.agentJobs.listAllJobs(),
    getJobById: (id) => options.agentJobs.getById(id),
    updateJob: (id, updates) => options.agentJobs.updateJob(id, updates),
    resolveSession: (job) => options.resolveSession(options.agentJobs.getById(job.id) ?? job),
  }, {
    now,
    materializeMissingState: false,
  });
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
    const currentJob = options.agentJobs.getById(options.job.id);
    if (currentJob && currentJob.bridgeSessionId !== nextSession.id) {
      options.agentJobs.updateJob(currentJob.id, {
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
  const provider = new BridgeMissionProvider({
    jobId: options.job.id,
    scopeRef,
    resolveJob: () => options.agentJobs.getById(options.job.id) ?? options.job,
    resolveSession: () => options.resolveSession(options.agentJobs.getById(options.job.id) ?? options.job),
    startTurnWithRecovery: options.startTurnWithRecovery,
    stopSession: options.stopSession,
    progressText: options.progressText,
    onProgress: options.onProgress ?? null,
    onApprovalRequest: options.onApprovalRequest ?? null,
    syncBridgeSession,
  });
  const verifier = new BridgeMissionVerifier({
    jobId: options.job.id,
    agentJobs: options.agentJobs,
    provider,
    verifyJob: options.verifyJob,
    progressText: options.progressText,
    onProgress: options.onProgress ?? null,
  });

  const runtime = new MissionRuntime({
    repository,
    provider,
    verifier,
    now,
  });
  const runResult = await runtime.runMission(mission.id, {
    ownerId: `agent-job:${options.job.id}`,
    readOnly: true,
    allowSharedCwd: true,
  });
  const finalJob = options.agentJobs.getById(options.job.id) ?? options.job;
  const finalRunId = runResult.attempt?.providerRunId ?? null;
  const finalExecution = finalRunId ? provider.getExecutionRecord(finalRunId) : provider.getLastExecutionRecord();

  return {
    runResult,
    finalJob,
    finalSession: finalExecution?.session ?? options.resolveSession(finalJob),
    finalBridgeResult: finalExecution?.result ?? null,
  };
}

class AgentJobMissionRepository implements MissionRepository {
  constructor(
    private readonly agentJobs: AgentJobService,
    private readonly now: () => number,
  ) {}

  getMissionById(id: string): Mission | null {
    const job = this.agentJobs.getById(id);
    return job ? loadMissionRuntimeState(job).mission : null;
  }

  getWorkItemById(id: string): WorkItem | null {
    for (const job of this.agentJobs.listAllJobs()) {
      const workItem = loadMissionRuntimeState(job).workItem;
      if (workItem?.id === id) {
        return cloneValue(workItem);
      }
    }
    return null;
  }

  saveWorkItem(workItem: WorkItem): WorkItem {
    const currentJob = this.agentJobs
      .listAllJobs()
      .find((job) => loadMissionRuntimeState(job).mission?.workItemId === workItem.id);
    if (!currentJob) {
      return workItem;
    }
    const currentState = loadMissionRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      workItem: cloneValue(workItem),
    });
    return workItem;
  }

  listMissions(): Mission[] {
    return this.agentJobs
      .listAllJobs()
      .map((job) => loadMissionRuntimeState(job).mission)
      .filter(Boolean) as Mission[];
  }

  listResumableMissions(now = Date.now()): Mission[] {
    return this.listMissions().filter((mission) => isMissionResumable(mission, now));
  }

  saveMission(mission: Mission): Mission {
    const currentJob = this.agentJobs.requireById(mission.id);
    const currentState = loadMissionRuntimeState(currentJob);
    const nextState: MissionRuntimeState = {
      ...currentState,
      mission: cloneValue(mission),
    };
    this.persistState(currentJob, nextState);
    return mission;
  }

  getGenerationById(id: string): MissionGeneration | null {
    for (const job of this.agentJobs.listAllJobs()) {
      const generation = loadMissionRuntimeState(job).generations.find((entry) => entry.id === id);
      if (generation) {
        return cloneValue(generation);
      }
    }
    return null;
  }

  listGenerations(missionId: string): MissionGeneration[] {
    const job = this.agentJobs.getById(missionId);
    return job ? loadMissionRuntimeState(job).generations : [];
  }

  saveGeneration(generation: MissionGeneration): MissionGeneration {
    const currentJob = this.agentJobs.requireById(generation.missionId);
    const currentState = loadMissionRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      generations: upsertById(currentState.generations, generation).sort((left, right) => left.index - right.index),
    });
    return generation;
  }

  getChecklistSnapshotById(id: string): ChecklistSnapshot | null {
    for (const job of this.agentJobs.listAllJobs()) {
      const snapshot = loadMissionRuntimeState(job).checklistSnapshots.find((entry) => entry.id === id);
      if (snapshot) {
        return cloneValue(snapshot);
      }
    }
    return null;
  }

  listChecklistSnapshots(missionId: string): ChecklistSnapshot[] {
    const job = this.agentJobs.getById(missionId);
    return job ? loadMissionRuntimeState(job).checklistSnapshots : [];
  }

  saveChecklistSnapshot(snapshot: ChecklistSnapshot): ChecklistSnapshot {
    const currentJob = this.agentJobs.requireById(snapshot.missionId);
    const currentState = loadMissionRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      checklistSnapshots: upsertById(currentState.checklistSnapshots, snapshot)
        .sort((left, right) => left.version - right.version),
    });
    return snapshot;
  }

  getPlanChangeRequestById(id: string): PlanChangeRequest | null {
    for (const job of this.agentJobs.listAllJobs()) {
      const changeRequest = loadMissionRuntimeState(job).planChangeRequests.find((entry) => entry.id === id);
      if (changeRequest) {
        return cloneValue(changeRequest);
      }
    }
    return null;
  }

  listPlanChangeRequests(missionId: string): PlanChangeRequest[] {
    const job = this.agentJobs.getById(missionId);
    return job ? loadMissionRuntimeState(job).planChangeRequests : [];
  }

  savePlanChangeRequest(changeRequest: PlanChangeRequest): PlanChangeRequest {
    const currentJob = this.agentJobs.requireById(changeRequest.missionId);
    const currentState = loadMissionRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      planChangeRequests: upsertById(currentState.planChangeRequests, changeRequest),
    });
    return changeRequest;
  }

  getAttemptById(id: string): MissionAttempt | null {
    for (const job of this.agentJobs.listAllJobs()) {
      const state = loadMissionRuntimeState(job);
      const attempt = state.attempts.find((entry) => entry.id === id);
      if (attempt) {
        return cloneValue(attempt);
      }
    }
    return null;
  }

  listAttempts(missionId: string): MissionAttempt[] {
    const job = this.agentJobs.getById(missionId);
    return job ? loadMissionRuntimeState(job).attempts : [];
  }

  saveAttempt(attempt: MissionAttempt): MissionAttempt {
    const currentJob = this.agentJobs.requireById(attempt.missionId);
    const currentState = loadMissionRuntimeState(currentJob);
    const nextState: MissionRuntimeState = {
      ...currentState,
      attempts: upsertById(currentState.attempts, attempt).sort((left, right) => left.index - right.index),
    };
    this.persistState(currentJob, nextState);
    return attempt;
  }

  listEvents(missionId: string): MissionEvent[] {
    const job = this.agentJobs.getById(missionId);
    return job ? loadMissionRuntimeState(job).events : [];
  }

  appendEvent(event: MissionEvent): MissionEvent {
    const currentJob = this.agentJobs.requireById(event.missionId);
    const currentState = loadMissionRuntimeState(currentJob);
    const nextState: MissionRuntimeState = {
      ...currentState,
      events: [...currentState.events, cloneValue(event)],
    };
    this.persistState(currentJob, nextState);
    return event;
  }

  resetMission(mission: Mission): Mission {
    const currentJob = this.agentJobs.requireById(mission.id);
    this.persistState(currentJob, {
      workItem: null,
      mission: cloneValue(mission),
      generations: [],
      checklistSnapshots: [],
      planChangeRequests: [],
      attempts: [],
      events: [],
    });
    return mission;
  }

  private persistState(job: AgentJob, state: MissionRuntimeState): AgentJob {
    const patch = buildAgentJobMissionPatch(job, state);
    return this.agentJobs.updateJob(job.id, patch);
  }
}

class BridgeMissionProvider implements MissionProvider {
  readonly kind = 'codexbridge-agent-job';

  private runCounter = 0;

  private readonly executionRecords = new Map<string, BridgeMissionExecutionRecord>();

  private lastRunId: string | null = null;

  private readonly runningAttempts = new Set<string>();

  constructor(private readonly options: {
    jobId: string;
    scopeRef: PlatformScopeRef;
    resolveJob: () => AgentJob;
    resolveSession: () => BridgeSession | null;
    startTurnWithRecovery: RunAgentJobWithMissionControlOptions['startTurnWithRecovery'];
    stopSession: RunAgentJobWithMissionControlOptions['stopSession'];
    progressText: MissionControlAgentJobRunProgressText;
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
      throw new Error('Agent mission session is missing.');
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
        text: buildAgentMissionExecutionPrompt(input.promptText, liveJob.locale),
        cwd: liveJob.cwd ?? input.mission.cwd,
        locale: liveJob.locale,
        attachments: [],
        metadata: {
          codexbridge: {
            overrideBridgeSessionId: session.id,
            agentJobId: this.options.jobId,
            agentAttempt: input.attempt.index,
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
      normalizedResult: normalizedResult.outcome === 'interrupted' && !liveJob.stopRequested
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
    jobId: string;
    agentJobs: AgentJobService;
    provider: BridgeMissionProvider;
    verifyJob: RunAgentJobWithMissionControlOptions['verifyJob'];
    progressText: MissionControlAgentJobRunProgressText;
    onProgress: ProgressHandler;
  }) {}

  async verify(input: {
    mission: Mission;
    attempt: MissionAttempt;
    providerResult: MissionProviderResult;
  }): Promise<MissionVerifierResult> {
    await emitProgress(this.options.onProgress, this.options.progressText.verifying());
    const currentJob = this.options.agentJobs.getById(this.options.jobId);
    if (!currentJob) {
      return createMissionVerifierResult({
        verdict: 'failed',
        summary: 'Agent job was deleted before verification finished.',
      });
    }
    const execution = input.attempt.providerRunId
      ? this.options.provider.getExecutionRecord(input.attempt.providerRunId)
      : this.options.provider.getLastExecutionRecord();
    const verification = await this.options.verifyJob(
      currentJob,
      execution?.result ?? missionProviderResultToBridgeResult(input.providerResult),
      execution?.session ?? null,
    );
    if (!verification.pass && verification.nextAction === 'retry') {
      await emitProgress(this.options.onProgress, this.options.progressText.retrying());
    }
    return createMissionVerifierResult({
      verdict: verification.pass || verification.nextAction === 'complete'
        ? 'complete'
        : verification.nextAction === 'retry'
          ? 'repair'
          : 'failed',
      summary: verification.summary,
      missingAcceptanceCriteria: verification.issues,
    });
  }
}

function prepareMissionSnapshot(input: {
  job: AgentJob;
  session: BridgeSession | null;
  repository: AgentJobMissionRepository;
  now: () => number;
}): Mission {
  const existing = input.repository.getMissionById(input.job.id);
  if (!existing) {
    return input.repository.resetMission(buildFreshMission(input.job, input.session, input.now));
  }
  if (existing.status === 'draft') {
    const queued = transitionMission(existing, 'queued', {
      at: input.now(),
      reason: 'Agent mission re-queued through the bridge adapter.',
    });
    return input.repository.saveMission(queued);
  }
  if (
    existing.status === 'running'
    || existing.status === 'planning'
    || (!isMissionResumable(existing, input.now()) && input.job.status === 'queued' && !input.job.running)
  ) {
    return input.repository.resetMission(buildFreshMission(input.job, input.session, input.now));
  }
  return existing;
}

function buildFreshMission(job: AgentJob, session: BridgeSession | null, now: () => number): Mission {
  return transitionMission(createMission({
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
    codexThreadId: session?.codexThreadId ?? null,
    maxAttempts: job.maxAttempts,
    maxTurns: 8,
    now: now(),
  }), 'queued', {
    at: now(),
    reason: 'Agent mission queued through the bridge adapter.',
  });
}

function buildAgentJobMissionPatch(job: AgentJob, state: MissionRuntimeState): Partial<AgentJob> {
  const mission = state.mission;
  if (!mission) {
    return {
      missionRuntimeState: null,
      missionAttemptHistory: [],
    };
  }
  const attempts = [...state.attempts].sort((left, right) => {
    const leftGeneration = left.generationIndex ?? 0;
    const rightGeneration = right.generationIndex ?? 0;
    if (leftGeneration !== rightGeneration) {
      return leftGeneration - rightGeneration;
    }
    return left.index - right.index;
  });
  return {
    status: mapMissionStatusToAgentJobStatus(mission.status),
    running: ACTIVE_MISSION_JOB_STATUS_SET.has(mission.status),
    stopRequested: mission.status === 'stopped',
    attemptCount: mission.attemptCount,
    lastRunAt: mission.lastRunAt,
    completedAt: TERMINAL_MISSION_JOB_STATUS_SET.has(mission.status)
      ? (mission.completedAt ?? mission.stoppedAt ?? mission.updatedAt)
      : null,
    lastResultPreview: summarizeMissionPreview(mission.lastResultPreview, mission.resultArtifacts),
    resultText: mission.resultText,
    resultArtifacts: mapMissionArtifactsToAgentArtifacts(mission.resultArtifacts),
    lastError: mission.lastError,
    verificationSummary: mission.workpad.latestVerifierSummary,
    missionWorkflowPath: mission.workflowPath,
    missionWorkflowSourceLabel: mission.workflowPath
      ? `configured workflow (${mission.workflowPath})`
      : job.missionWorkflowSourceLabel,
    missionWorkpadLatestBlocker: mission.workpad.latestBlocker,
    missionWorkpadLatestVerifierSummary: mission.workpad.latestVerifierSummary,
    missionWorkpadFinalResultSummary: mission.workpad.finalResultSummary ?? mission.lastResultPreview,
    missionAttemptHistory: buildAttemptHistory(attempts),
    missionRuntimeState: serializeMissionRuntimeState(state),
  };
}

function buildAttemptHistory(attempts: MissionAttempt[]): AgentJobAttemptHistoryEntry[] {
  return attempts.map((attempt) => ({
    attempt: attempt.index,
    status: mapMissionAttemptStatusToAgentJobStatus(attempt.status),
    verifierSummary: attempt.verifierSummary,
    outputPreview: attempt.outputPreview,
    error: attempt.error,
    recordedAt: attempt.endedAt ?? attempt.updatedAt,
  }));
}

function summarizeMissionPreview(value: string | null, artifacts: unknown[]): string | null {
  const text = compactString(value);
  if (text) {
    return text.length > 180 ? `${text.slice(0, 179)}…` : text;
  }
  const artifactCount = Array.isArray(artifacts) ? artifacts.length : 0;
  return artifactCount > 0 ? `attachments: ${artifactCount}` : null;
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

function mapPlatformToMissionSource(platform: string): Mission['source'] {
  if (platform === 'weixin' || platform === 'telegram') {
    return platform;
  }
  return 'manual';
}

function mapMissionArtifactsToAgentArtifacts(value: unknown[]): TurnArtifactDeliveredItem[] | null {
  const normalized = value
    .map((artifact) => {
      const type = compactString((artifact as MissionProviderArtifact | null)?.type);
      const path = compactString((artifact as MissionProviderArtifact | null)?.path);
      if (!type || !path) {
        return null;
      }
      return {
        kind: type === 'other' ? 'file' : (type as TurnArtifactDeliveredItem['kind']),
        path,
        displayName: compactString((artifact as MissionProviderArtifact | null)?.name),
        mimeType: compactString((artifact as MissionProviderArtifact | null)?.mimeType),
        sizeBytes: null,
        caption: compactString((artifact as MissionProviderArtifact | null)?.caption),
        source: 'provider_native' as const,
        turnId: null,
      };
    })
    .filter(Boolean) as TurnArtifactDeliveredItem[];
  return normalized.length > 0 ? normalized : null;
}

function loadMissionRuntimeState(job: AgentJob): MissionRuntimeState {
  const raw = job.missionRuntimeState;
  return {
    workItem: raw?.workItem ? cloneValue(raw.workItem as unknown as WorkItem) : null,
    mission: raw?.mission ? normalizeMissionRecord(cloneValue(raw.mission as unknown as Mission)) : null,
    generations: Array.isArray(raw?.generations)
      ? raw.generations.map((generation) => cloneValue(generation as unknown as MissionGeneration))
      : [],
    checklistSnapshots: Array.isArray(raw?.checklistSnapshots)
      ? raw.checklistSnapshots.map((snapshot) => cloneValue(snapshot as unknown as ChecklistSnapshot))
      : [],
    planChangeRequests: Array.isArray(raw?.planChangeRequests)
      ? raw.planChangeRequests.map((changeRequest) => cloneValue(changeRequest as unknown as PlanChangeRequest))
      : [],
    attempts: Array.isArray(raw?.attempts)
      ? raw.attempts.map((attempt) => cloneValue(attempt as unknown as MissionAttempt))
      : [],
    events: Array.isArray(raw?.events)
      ? raw.events.map((event) => cloneValue(event as unknown as MissionEvent))
      : [],
  };
}

function serializeMissionRuntimeState(state: MissionRuntimeState): AgentJobMissionRuntimeState {
  return {
    workItem: state.workItem ? (cloneValue(state.workItem) as unknown as Record<string, unknown>) : null,
    mission: state.mission ? (cloneValue(state.mission) as unknown as Record<string, unknown>) : null,
    generations: state.generations.map((generation) => cloneValue(generation) as unknown as Record<string, unknown>),
    checklistSnapshots: state.checklistSnapshots.map((snapshot) => cloneValue(snapshot) as unknown as Record<string, unknown>),
    planChangeRequests: state.planChangeRequests.map((changeRequest) => cloneValue(changeRequest) as unknown as Record<string, unknown>),
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

function missionProviderResultToBridgeResult(result: MissionProviderResult): BridgeMissionTurnResult['result'] {
  return {
    outputText: result.text,
    previewText: result.previewText,
    errorMessage: result.errorMessage,
    outputState: result.rawState,
    outputArtifacts: result.artifacts.map((artifact) => ({
      kind: artifact.type === 'other' ? 'file' : (artifact.type as OutputArtifact['kind']),
      path: artifact.path ?? '',
      displayName: artifact.name ?? null,
      mimeType: artifact.mimeType ?? null,
      caption: artifact.caption ?? null,
      source: 'provider_native',
    })),
    finalSource: 'mission_control_runtime',
  };
}

function buildAgentMissionExecutionPrompt(promptText: string, locale: string | null): string {
  const prefix = locale === 'zh-CN'
    ? '你正在执行 CodexBridge 后台 Agent 任务。请用中文回复最终结果。\n最终回复必须包含：摘要、验证结果、产物或后续动作。'
    : 'You are executing a CodexBridge background Agent task. Reply with the final result in English.';
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

const ACTIVE_MISSION_JOB_STATUS_SET = new Set<MissionStatus>([
  'planning',
  'running',
  'verifying',
  'repairing',
]);

const TERMINAL_MISSION_JOB_STATUS_SET = new Set<MissionStatus>([
  'waiting_user',
  'needs_human',
  'handoff',
  'blocked',
  'completed',
  'failed',
  'stopped',
  'archived',
]);
