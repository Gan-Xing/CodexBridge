import crypto from 'node:crypto';
import {
  canTransitionMissionStatus,
  createManualWorkItemSourceSummary,
  createWorkItemSourceSummary,
  DirectMissionControlApi,
  MissionSupervisor,
  transitionMission,
  type Mission,
  type MissionRepository,
  type MissionExecutionView,
  shouldMissionRetryReuseAccumulatedContext,
  type MissionDetailView,
  type MissionSummaryView,
} from '../../packages/mission-control/src/index.js';
import { NotFoundError } from './errors.js';
import { AgentJobMissionRepository } from './mission_control_agent_job_repository.js';
import {
  createFreshMissionRuntimeStateForAgentJob,
  createProjectedMissionRuntimeStateForAgentJob,
  loadAgentJobMissionRuntimeState,
} from './mission_control_agent_job_adapter.js';
import { persistMissionRuntimeStateToRepository } from './mission_control_agent_job_projection.js';
import { ProjectingMissionRepository } from './projecting_mission_repository.js';
import { createI18n, type Translator } from '../i18n/index.js';
import type {
  AgentJob,
  AgentJobAttemptHistoryEntry,
  AgentJobCategory,
  AgentJobMode,
  AgentJobRiskLevel,
  AgentJobStatus,
  BridgeSession,
  PlatformScopeRef,
  TurnArtifactDeliveredItem,
} from '../types/core.js';
import type { AgentJobRepository } from '../types/repository.js';

interface BridgeSessionsLike {
  getSessionById?(bridgeSessionId: string): BridgeSession | null;
}

interface AgentJobServiceOptions {
  agentJobs: AgentJobRepository;
  bridgeSessions?: BridgeSessionsLike | null;
  missionRepository?: MissionRepository | null;
  now?: () => number;
  locale?: string | null;
}

export interface AgentJobMissionSupervisionRecoveryResult {
  recoveredMissionIds: string[];
  stoppedMissionIds: string[];
}

export class AgentJobService {
  private readonly agentJobs: AgentJobRepository;

  private readonly bridgeSessions: BridgeSessionsLike | null;

  private readonly missionAuthorityRepository: MissionRepository | null;

  private readonly missionControlRepository: MissionRepository;

  private readonly now: () => number;

  private readonly i18n: Translator;

  constructor({
    agentJobs,
    bridgeSessions = null,
    missionRepository = null,
    now = () => Date.now(),
    locale = null,
  }: AgentJobServiceOptions) {
    this.agentJobs = agentJobs;
    this.bridgeSessions = bridgeSessions;
    this.missionAuthorityRepository = missionRepository;
    this.now = now;
    this.i18n = createI18n(locale);
    this.missionControlRepository = missionRepository
      ? new ProjectingMissionRepository(missionRepository, agentJobs)
      : new AgentJobMissionRepository({
        listJobs: () => this.agentJobs.list(),
        getJobById: (id) => this.agentJobs.getById(id),
        updateJob: (id, updates) => this.updateJob(id, updates),
        resolveSession: (job) => this.getSession(job),
      }, {
        now: this.now,
      });
  }

  listForScope(scopeRef: PlatformScopeRef): AgentJob[] {
    return this.agentJobs
      .list()
      .filter((job) => job.platform === scopeRef.platform && job.externalScopeId === scopeRef.externalScopeId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  listAllJobs(): AgentJob[] {
    return this.agentJobs
      .list()
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  listMissionSummariesForScope(scopeRef: PlatformScopeRef): MissionSummaryView[] {
    this.ensureMissionRecordsForJobs(this.listForScope(scopeRef));
    return this.createMissionControlApi().queries.listMissionSummaries({
      meta: this.createMissionControlMeta(`agent-list:${scopeRef.platform}:${scopeRef.externalScopeId}`),
      input: {
        filter: {
          platform: scopeRef.platform,
          externalScopeId: scopeRef.externalScopeId,
        },
      },
    }).data;
  }

  getMissionDetail(id: string): MissionDetailView | null {
    this.ensureMissionRecord(id);
    return this.createMissionControlApi().queries.getMissionDetail({
      meta: this.createMissionControlMeta(`agent-detail:${id}`),
      input: {
        missionId: id,
      },
    }).data;
  }

  getMissionExecution(id: string): MissionExecutionView | null {
    this.ensureMissionRecord(id);
    return this.createMissionControlApi().queries.getMissionExecution({
      meta: this.createMissionControlMeta(`agent-execution:${id}`),
      input: {
        missionId: id,
      },
    }).data;
  }

  getById(id: string): AgentJob | null {
    return this.agentJobs.getById(id);
  }

  requireById(id: string): AgentJob {
    const job = this.getById(id);
    if (!job) {
      throw new NotFoundError(this.i18n.t('service.unknownAgentJob', { id }));
    }
    return job;
  }

  resolveForScope(scopeRef: PlatformScopeRef, token: string): AgentJob | null {
    const normalized = String(token ?? '').trim();
    if (!normalized) {
      return null;
    }
    const byId = this.getById(normalized);
    if (byId && byId.platform === scopeRef.platform && byId.externalScopeId === scopeRef.externalScopeId) {
      return byId;
    }
    const index = Number(normalized);
    if (Number.isInteger(index) && index > 0) {
      return this.listForScope(scopeRef)[index - 1] ?? null;
    }
    return null;
  }

  createJob(params: {
    scopeRef: PlatformScopeRef;
    title: string;
    originalInput: string;
    goal: string;
    expectedOutput: string;
    plan: string[];
    category: AgentJobCategory;
    riskLevel: AgentJobRiskLevel;
    mode: AgentJobMode;
    providerProfileId: string;
    bridgeSessionId: string;
    cwd: string | null;
    locale: string | null;
    maxAttempts?: number | null;
  }): AgentJob {
    const now = this.now();
    const job: AgentJob = {
      id: crypto.randomUUID(),
      platform: params.scopeRef.platform,
      externalScopeId: params.scopeRef.externalScopeId,
      title: normalizeTitle(params.title, 'Agent'),
      originalInput: String(params.originalInput ?? '').trim(),
      goal: String(params.goal ?? '').trim(),
      expectedOutput: String(params.expectedOutput ?? '').trim(),
      plan: normalizePlan(params.plan),
      category: normalizeCategory(params.category),
      riskLevel: normalizeRiskLevel(params.riskLevel),
      mode: normalizeMode(params.mode),
      providerProfileId: params.providerProfileId,
      bridgeSessionId: params.bridgeSessionId,
      cwd: normalizeNullableString(params.cwd),
      locale: normalizeNullableString(params.locale),
      status: 'queued',
      running: false,
      stopRequested: false,
      maxAttempts: clampAttempts(params.maxAttempts ?? 2),
      attemptCount: 0,
      lastRunAt: null,
      completedAt: null,
      lastResultPreview: null,
      resultText: null,
      resultArtifacts: null,
      lastError: null,
      verificationSummary: null,
      missionWorkflowPath: null,
      missionWorkflowSourceLabel: null,
      missionWorkpadLatestBlocker: null,
      missionWorkpadLatestVerifierSummary: null,
      missionWorkpadFinalResultSummary: null,
      missionAttemptHistory: [],
      missionRuntimeState: null,
      createdAt: now,
      updatedAt: now,
    };
    this.agentJobs.save(job);
    this.seedMissionFromManualWorkItem(job);
    return this.requireById(job.id);
  }

  startJob(id: string, params: {
    confirmChecklist?: boolean | null;
    confirmPrompt?: boolean | null;
  } = {}): AgentJob {
    this.requireById(id);
    this.ensureMissionRecord(id);
    this.createMissionControlApi().commands.startMission({
      meta: this.createMissionControlMeta(`agent-start:${id}`),
      input: {
        missionId: id,
        confirmChecklist: params.confirmChecklist ?? null,
        confirmPrompt: params.confirmPrompt ?? null,
        actor: {
          actorId: 'agent-job-service',
          actorType: 'host',
        },
      },
    });
    return this.requireById(id);
  }

  proposePlanChange(id: string, params: {
    rationale: string;
    proposedExpectedOutput?: string | null;
    proposedAcceptanceCriteria?: string[] | null;
    proposedPlan?: string[] | null;
  }): AgentJob {
    this.requireById(id);
    this.ensureMissionRecord(id);
    this.createMissionControlApi().commands.proposePlanChange({
      meta: this.createMissionControlMeta(`agent-plan-change-propose:${id}`),
      input: {
        missionId: id,
        rationale: params.rationale,
        proposedExpectedOutput: params.proposedExpectedOutput ?? null,
        proposedAcceptanceCriteria: params.proposedAcceptanceCriteria ?? null,
        proposedPlan: params.proposedPlan ?? null,
        actor: {
          actorId: 'agent-job-service',
          actorType: 'host',
        },
      },
    });
    return this.requireById(id);
  }

  updateJob(id: string, updates: Partial<AgentJob>): AgentJob {
    const current = this.requireById(id);
    const next: AgentJob = {
      ...current,
      ...updates,
      plan: updates.plan ? normalizePlan(updates.plan) : current.plan,
      missionAttemptHistory: hasOwn(updates, 'missionAttemptHistory')
        ? normalizeAttemptHistory(updates.missionAttemptHistory ?? [])
        : current.missionAttemptHistory,
      updatedAt: this.now(),
    };
    this.agentJobs.save(next);
    return next;
  }

  renameJob(id: string, title: string): AgentJob {
    const renamed = this.updateJob(id, {
      title: normalizeTitle(title, 'Agent'),
    });
    if (!this.syncMissionSourceProjection(renamed)) {
      this.syncMissionTitleProjection(renamed);
    }
    return this.requireById(id);
  }

  requestStop(id: string): AgentJob {
    this.requireById(id);
    this.ensureMissionRecord(id);
    this.createMissionControlApi().commands.stopMission({
      meta: this.createMissionControlMeta(`agent-stop:${id}`),
      input: {
        missionId: id,
        reason: 'Agent job stop requested.',
        actor: {
          actorId: 'agent-job-service',
          actorType: 'host',
        },
      },
    });
    return this.requireById(id);
  }

  resumeJob(
    id: string,
    reason = 'Agent mission queued to continue after host confirmation.',
    options: {
      responseText?: string | null;
    } = {},
  ): AgentJob {
    this.requireById(id);
    this.ensureMissionRecord(id);
    this.createMissionControlApi().commands.resumeMission({
      meta: this.createMissionControlMeta(`agent-resume:${id}`),
      input: {
        missionId: id,
        reason,
        responseText: options.responseText ?? null,
        actor: {
          actorId: 'agent-job-service',
          actorType: 'host',
        },
      },
    });
    return this.requireById(id);
  }

  submitApproval(
    id: string,
    decision: 'approve' | 'reject',
    options: {
      approvalId?: string | null;
      reason?: string | null;
      responseText?: string | null;
    } = {},
  ): AgentJob {
    this.requireById(id);
    this.ensureMissionRecord(id);
    this.createMissionControlApi().commands.submitApproval({
      meta: this.createMissionControlMeta(`agent-approval:${id}`),
      input: {
        missionId: id,
        approvalId: options.approvalId ?? null,
        decision,
        reason: options.reason ?? null,
        responseText: options.responseText ?? null,
        actor: {
          actorId: 'agent-job-service',
          actorType: 'host',
        },
      },
    });
    return this.requireById(id);
  }

  resolvePlanChange(
    id: string,
    decision: 'approve' | 'reject',
    reason = decision === 'reject'
      ? 'Agent mission scope change rejected by the host.'
      : 'Agent mission scope change approved by the host.',
  ): AgentJob {
    this.requireById(id);
    this.ensureMissionRecord(id);
    this.createMissionControlApi().commands.resolvePlanChange({
      meta: this.createMissionControlMeta(`agent-plan-change-resolve:${id}`),
      input: {
        missionId: id,
        decision,
        reason,
        actor: {
          actorId: 'agent-job-service',
          actorType: 'host',
        },
      },
    });
    return this.requireById(id);
  }

  retryJob(id: string): AgentJob {
    const current = this.requireById(id);
    this.ensureMissionRecord(id);
    const api = this.createMissionControlApi();
    const detail = api.queries.getMissionDetail({
      meta: this.createMissionControlMeta(`agent-detail:${id}`),
      input: {
        missionId: id,
      },
    }).data;
    if (detail?.mission && shouldMissionRetryReuseAccumulatedContext(detail.mission)) {
      return this.resumeJob(id, 'Agent mission queued to continue after human input.');
    }
    api.commands.retryMission({
      meta: this.createMissionControlMeta(`agent-retry:${id}`),
      input: {
        missionId: id,
        reason: 'Agent mission re-queued through Mission Control retry.',
        codexThreadId: this.getSession(current)?.codexThreadId ?? null,
        actor: {
          actorId: 'agent-job-service',
          actorType: 'host',
        },
      },
    });
    return this.requireById(id);
  }

  deleteJob(id: string): void {
    this.agentJobs.delete(id);
  }

  recoverSupervisableMissions(): AgentJobMissionSupervisionRecoveryResult {
    this.ensureMissionRecordsForJobs(this.agentJobs.list());
    const supervisor = this.createMissionSupervisor();
    const now = this.now();
    return {
      recoveredMissionIds: supervisor.recoverStaleMissions(now).map((mission) => mission.id),
      stoppedMissionIds: supervisor.reconcileStopRequestedMissions('agent-job-service', now)
        .map((mission) => mission.id),
    };
  }

  claimSupervisableJobs(platform: string, limit = 2): AgentJob[] {
    if (limit <= 0) {
      return [];
    }
    this.recoverSupervisableMissions();
    return this.createMissionSupervisor()
      .listSupervisableMissionIds({ now: this.now() })
      .map((missionId) => this.agentJobs.getById(missionId))
      .filter((job): job is AgentJob => Boolean(job) && job.platform === platform)
      .slice(0, limit)
      .map((job) => this.requireById(job.id));
  }

  resetRunningJobs(): void {
    const now = this.now();
    for (const job of this.agentJobs.list()) {
      if (!job.running) {
        continue;
      }
      this.ensureMissionRecord(job.id);
      this.agentJobs.save({
        ...job,
        running: false,
        status: job.stopRequested ? 'stopped' : 'queued',
        updatedAt: now,
      });
      this.reconcileAuthoritativeMissionFromProjection(job.id, {
        status: job.stopRequested ? 'stopped' : 'queued',
        reason: job.stopRequested
          ? 'Host reset an interrupted agent mission into stopped state.'
          : 'Host reset an interrupted agent mission into the queue.',
      });
    }
  }

  claimQueuedJobs(platform: string, limit = 2): AgentJob[] {
    if (this.missionAuthorityRepository) {
      return this.claimSupervisableJobs(platform, limit);
    }
    const now = this.now();
    const jobs = this.agentJobs
      .list()
      .filter((job) => job.platform === platform && job.status === 'queued' && !job.running && !job.stopRequested)
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, limit);
    for (const job of jobs) {
      this.ensureMissionRecord(job.id);
      this.agentJobs.save({
        ...job,
        status: 'planning',
        running: true,
        updatedAt: now,
      });
      this.reconcileAuthoritativeMissionFromProjection(job.id, {
        status: 'planning',
        reason: 'Host claimed a queued mission for execution.',
      });
    }
    return jobs.map((job) => this.requireById(job.id));
  }

  markRunning(id: string, params: {
    attempt: number;
    workflowPath?: string | null;
    workflowSourceLabel?: string | null;
  }): AgentJob {
    const current = this.requireById(id);
    return this.updateJob(id, {
      status: 'running',
      running: true,
      attemptCount: params.attempt,
      lastRunAt: this.now(),
      missionWorkflowPath: params.workflowPath ?? current.missionWorkflowPath,
      missionWorkflowSourceLabel: params.workflowSourceLabel ?? current.missionWorkflowSourceLabel,
      missionAttemptHistory: appendAttemptHistoryEntry(current.missionAttemptHistory, {
        attempt: params.attempt,
        status: 'running',
        verifierSummary: null,
        outputPreview: null,
        error: null,
        recordedAt: this.now(),
      }),
    });
  }

  markVerifying(id: string, attemptCount: number): AgentJob {
    const current = this.requireById(id);
    return this.updateJob(id, {
      status: 'verifying',
      running: true,
      attemptCount,
      missionAttemptHistory: appendAttemptHistoryEntry(current.missionAttemptHistory, {
        attempt: attemptCount,
        status: 'verifying',
        verifierSummary: null,
        outputPreview: null,
        error: null,
        recordedAt: this.now(),
      }),
    });
  }

  markRepairing(id: string, verificationSummary: string | null): AgentJob {
    const current = this.requireById(id);
    return this.updateJob(id, {
      status: 'repairing',
      running: true,
      verificationSummary: normalizeNullableString(verificationSummary),
      missionWorkpadLatestBlocker: normalizeNullableString(verificationSummary),
      missionWorkpadLatestVerifierSummary: normalizeNullableString(verificationSummary),
      missionAttemptHistory: appendAttemptHistoryEntry(current.missionAttemptHistory, {
        attempt: Math.max(1, current.attemptCount),
        status: 'repairing',
        verifierSummary: normalizeNullableString(verificationSummary),
        outputPreview: current.lastResultPreview,
        error: normalizeNullableString(verificationSummary),
        recordedAt: this.now(),
      }),
    });
  }

  completeJob(id: string, params: {
    resultPreview?: string | null;
    resultText?: string | null;
    resultArtifacts?: TurnArtifactDeliveredItem[] | null;
    verificationSummary?: string | null;
  } = {}): AgentJob {
    const current = this.requireById(id);
    const normalizedResultPreview = normalizeNullableString(params.resultPreview);
    const normalizedVerificationSummary = normalizeNullableString(params.verificationSummary);
    return this.updateJob(id, {
      status: 'completed',
      running: false,
      stopRequested: false,
      completedAt: this.now(),
      lastResultPreview: normalizedResultPreview,
      resultText: normalizeNullableString(params.resultText),
      resultArtifacts: normalizeResultArtifacts(params.resultArtifacts ?? null),
      lastError: null,
      verificationSummary: normalizedVerificationSummary,
      missionWorkpadLatestBlocker: null,
      missionWorkpadLatestVerifierSummary: normalizedVerificationSummary,
      missionWorkpadFinalResultSummary: normalizedResultPreview,
      missionAttemptHistory: appendAttemptHistoryEntry(current.missionAttemptHistory, {
        attempt: Math.max(1, current.attemptCount),
        status: 'completed',
        verifierSummary: normalizedVerificationSummary,
        outputPreview: normalizedResultPreview,
        error: null,
        recordedAt: this.now(),
      }),
    });
  }

  failJob(id: string, params: {
    error: string;
    resultPreview?: string | null;
    verificationSummary?: string | null;
  }): AgentJob {
    const current = this.requireById(id);
    const normalizedError = normalizeNullableString(params.error);
    const normalizedResultPreview = normalizeNullableString(params.resultPreview);
    const normalizedVerificationSummary = normalizeNullableString(params.verificationSummary);
    return this.updateJob(id, {
      status: 'failed',
      running: false,
      completedAt: this.now(),
      lastResultPreview: normalizedResultPreview,
      resultText: normalizedResultPreview,
      resultArtifacts: null,
      lastError: normalizedError,
      verificationSummary: normalizedVerificationSummary,
      missionWorkpadLatestBlocker: normalizedVerificationSummary ?? normalizedError,
      missionWorkpadLatestVerifierSummary: normalizedVerificationSummary,
      missionAttemptHistory: appendAttemptHistoryEntry(current.missionAttemptHistory, {
        attempt: Math.max(1, current.attemptCount),
        status: 'failed',
        verifierSummary: normalizedVerificationSummary,
        outputPreview: normalizedResultPreview,
        error: normalizedError,
        recordedAt: this.now(),
      }),
    });
  }

  getSession(job: AgentJob): BridgeSession | null {
    return this.bridgeSessions?.getSessionById?.(job.bridgeSessionId) ?? null;
  }

  getMissionRepository(): MissionRepository {
    return this.missionControlRepository;
  }

  ensureMissionRecord(id: string): Mission | null {
    const job = this.agentJobs.getById(id);
    if (!job) {
      return null;
    }
    const jobState = loadAgentJobMissionRuntimeState(job);
    if (!this.missionAuthorityRepository) {
      return this.missionControlRepository.getMissionById(id);
    }
    const existing = this.missionAuthorityRepository.getMissionById(id);
    if (existing) {
      if (jobState.mission && jobState.mission.updatedAt > existing.updatedAt) {
        persistMissionRuntimeStateToRepository(this.missionControlRepository, jobState);
        return this.missionControlRepository.getMissionById(id);
      }
      return existing;
    }
    const seededState = jobState.mission
      ? jobState
      : hasLegacyMissionProjection(job)
        ? createProjectedMissionRuntimeStateForAgentJob(job, {
          now: this.now(),
          codexThreadId: this.getSession(job)?.codexThreadId ?? null,
        })
        : createFreshMissionRuntimeStateForAgentJob(job, {
          now: this.now(),
          codexThreadId: this.getSession(job)?.codexThreadId ?? null,
        });
    persistMissionRuntimeStateToRepository(this.missionControlRepository, seededState);
    return this.missionControlRepository.getMissionById(id);
  }

  private createMissionControlApi(): DirectMissionControlApi {
    return new DirectMissionControlApi({
      repository: this.missionControlRepository,
      now: this.now,
    });
  }

  private createMissionSupervisor(): MissionSupervisor {
    return new MissionSupervisor({
      repository: this.missionControlRepository,
      runtime: null,
      now: this.now,
    });
  }

  private ensureMissionRecordsForJobs(jobs: AgentJob[]): void {
    if (!this.missionAuthorityRepository) {
      return;
    }
    for (const job of jobs) {
      this.ensureMissionRecord(job.id);
    }
  }

  private seedMissionFromManualWorkItem(job: AgentJob): void {
    this.createMissionControlApi().commands.createMission({
      meta: this.createMissionControlMeta(`agent-create:${job.id}`),
      input: {
        missionId: job.id,
        workItem: createManualWorkItemSourceSummary({
          source: 'manual',
          sourceRef: job.id,
          title: job.title,
          goal: job.goal,
          expectedOutput: job.expectedOutput,
          acceptanceCriteria: job.expectedOutput ? [job.expectedOutput] : [],
          plan: [...job.plan],
          metadata: {
            category: job.category,
            mode: job.mode,
            originalInput: job.originalInput,
          },
        }),
        platform: job.platform,
        externalScopeId: job.externalScopeId,
        providerProfileId: job.providerProfileId,
        riskLevel: job.riskLevel,
        cwd: job.cwd,
        workflowPath: job.missionWorkflowPath,
        bridgeSessionId: job.bridgeSessionId,
        codexThreadId: this.getSession(job)?.codexThreadId ?? null,
        maxAttempts: job.maxAttempts,
        maxTurns: 8,
        initialStatus: 'draft',
        reason: 'Agent mission drafted through the bridge adapter.',
        actor: {
          actorId: 'agent-job-service',
          actorType: 'host',
        },
      },
    });
  }

  private reconcileAuthoritativeMissionFromProjection(
    jobId: string,
    params: {
      status: 'queued' | 'planning' | 'stopped';
      reason: string;
    },
  ): void {
    if (!this.missionAuthorityRepository) {
      return;
    }
    const mission = this.ensureMissionRecord(jobId);
    if (!mission || !canTransitionMissionStatus(mission.status, params.status)) {
      return;
    }
    this.missionControlRepository.saveMission(transitionMission(mission, params.status, {
      at: this.now(),
      reason: params.reason,
      lastError: params.status === 'stopped'
        ? mission.lastError ?? params.reason
        : null,
    }));
  }

  private syncMissionTitleProjection(job: AgentJob): void {
    if (!this.missionAuthorityRepository) {
      return;
    }
    const mission = this.ensureMissionRecord(job.id);
    if (!mission || mission.title === job.title) {
      return;
    }
    this.missionControlRepository.saveMission({
      ...mission,
      title: job.title,
      updatedAt: this.now(),
    });
    const workItem = this.missionControlRepository.getWorkItemById(mission.workItemId);
    if (!workItem || workItem.title === job.title) {
      return;
    }
    this.missionControlRepository.saveWorkItem({
      ...workItem,
      title: job.title,
      updatedAt: this.now(),
    });
  }

  private syncMissionSourceProjection(job: AgentJob): boolean {
    if (!this.missionAuthorityRepository) {
      return false;
    }
    const detail = this.getMissionDetail(job.id);
    if (
      !detail?.workItem
      || !detail.currentChecklistSnapshot
      || detail.attempts.length > 0
      || detail.planChangeRequests.length > 0
      || detail.mission.activeAttemptId
      || detail.mission.stopRequest
      || (detail.mission.status !== 'draft' && detail.mission.status !== 'queued')
    ) {
      return false;
    }
    try {
      this.createMissionControlApi().commands.syncMissionSource({
        meta: this.createMissionControlMeta(`agent-sync-source:${job.id}`),
        input: {
          missionId: job.id,
          workItem: createWorkItemSourceSummary({
            source: detail.workItem.source,
            sourceRef: detail.workItem.sourceRef ?? detail.mission.sourceRef ?? job.id,
            sourceRevision: detail.workItem.sourceRevision,
            title: job.title,
            goal: detail.mission.goal,
            expectedOutput: detail.currentChecklistSnapshot.expectedOutput ?? detail.mission.expectedOutput,
            acceptanceCriteria: detail.currentChecklistSnapshot.acceptanceCriteria,
            plan: detail.currentChecklistSnapshot.plan,
            metadata: detail.workItem.metadata,
          }),
          reason: 'Agent mission source synced after host rename.',
          actor: {
            actorId: 'agent-job-service',
            actorType: 'host',
          },
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private createMissionControlMeta(requestId: string) {
    return {
      requestId,
      correlationId: null,
      idempotencyKey: null,
    };
  }
}

function normalizeResultArtifacts(value: TurnArtifactDeliveredItem[] | null | undefined): TurnArtifactDeliveredItem[] | null {
  const items = Array.isArray(value) ? value : [];
  const normalized = items
    .map((item) => {
      const artifactPath = String(item?.path ?? '').trim();
      if (!artifactPath) {
        return null;
      }
      const kind = normalizeArtifactKind(item?.kind);
      if (!kind) {
        return null;
      }
      return {
        kind,
        path: artifactPath,
        displayName: normalizeNullableString(item?.displayName),
        mimeType: normalizeNullableString(item?.mimeType),
        sizeBytes: normalizeNullableNumber(item?.sizeBytes),
        caption: normalizeNullableString(item?.caption),
        source: normalizeArtifactSource(item?.source),
        turnId: normalizeNullableString(item?.turnId),
      };
    })
    .filter(Boolean) as TurnArtifactDeliveredItem[];
  return normalized.length > 0 ? normalized : null;
}

function hasLegacyMissionProjection(job: AgentJob): boolean {
  return job.attemptCount > 0
    || job.missionAttemptHistory.length > 0
    || Boolean(job.lastRunAt)
    || Boolean(job.completedAt)
    || Boolean(job.lastResultPreview)
    || Boolean(job.resultText)
    || Boolean(job.resultArtifacts?.length)
    || Boolean(job.lastError)
    || Boolean(job.verificationSummary)
    || Boolean(job.missionWorkflowPath)
    || Boolean(job.missionWorkpadLatestBlocker)
    || Boolean(job.missionWorkpadLatestVerifierSummary)
    || Boolean(job.missionWorkpadFinalResultSummary)
    || job.status !== 'queued';
}

function normalizeArtifactKind(value: unknown): TurnArtifactDeliveredItem['kind'] | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['image', 'file', 'video', 'audio'].includes(normalized)) {
    return normalized as TurnArtifactDeliveredItem['kind'];
  }
  return null;
}

function normalizeArtifactSource(value: unknown): TurnArtifactDeliveredItem['source'] {
  const normalized = String(value ?? '').trim();
  if (normalized === 'provider_native' || normalized === 'bridge_declared' || normalized === 'bridge_fallback') {
    return normalized;
  }
  return 'provider_native';
}

function normalizeNullableNumber(value: unknown): number | null {
  const normalized = Number(value ?? NaN);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
}

export function formatAgentStatus(status: AgentJobStatus, running: boolean): AgentJobStatus | 'running' {
  return running ? 'running' : status;
}

function normalizePlan(value: string[]): string[] {
  const lines = Array.isArray(value) ? value : [];
  return lines
    .map((line) => String(line ?? '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeTitle(value: string, fallback: string): string {
  const normalized = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.length > 40 ? `${normalized.slice(0, 39)}...` : normalized;
}

function normalizeNullableString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeAttemptHistory(value: AgentJobAttemptHistoryEntry[]): AgentJobAttemptHistoryEntry[] {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((entry) => ({
      attempt: Number.isInteger(entry?.attempt) && Number(entry.attempt) > 0 ? Number(entry.attempt) : 1,
      status: normalizeAgentJobStatus(entry?.status),
      verifierSummary: normalizeNullableString(entry?.verifierSummary),
      outputPreview: normalizeNullableString(entry?.outputPreview),
      error: normalizeNullableString(entry?.error),
      recordedAt: normalizeRecordedAt(entry?.recordedAt),
    }))
    .slice(-16);
}

function appendAttemptHistoryEntry(
  history: AgentJobAttemptHistoryEntry[],
  entry: AgentJobAttemptHistoryEntry,
): AgentJobAttemptHistoryEntry[] {
  return normalizeAttemptHistory([
    ...(Array.isArray(history) ? history : []),
    entry,
  ]);
}

function normalizeAgentJobStatus(value: unknown): AgentJobStatus {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'awaiting_checklist_confirm'
    || normalized === 'awaiting_prompt_confirm'
    || normalized === 'queued'
    || normalized === 'planning'
    || normalized === 'running'
    || normalized === 'verifying'
    || normalized === 'repairing'
    || normalized === 'waiting_user'
    || normalized === 'needs_human'
    || normalized === 'scope_change_pending'
    || normalized === 'handoff'
    || normalized === 'blocked'
    || normalized === 'max_loops_reached'
    || normalized === 'completed'
    || normalized === 'failed'
    || normalized === 'stopped'
  ) {
    return normalized;
  }
  return 'queued';
}

function normalizeRecordedAt(value: unknown): number {
  const normalized = Number(value ?? NaN);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : Date.now();
}

function hasOwn<T extends object, K extends PropertyKey>(value: T, key: K): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeCategory(value: unknown): AgentJobCategory {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['code', 'research', 'ops', 'doc', 'media', 'mixed'].includes(normalized)) {
    return normalized as AgentJobCategory;
  }
  return 'mixed';
}

function normalizeRiskLevel(value: unknown): AgentJobRiskLevel {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return 'medium';
}

function normalizeMode(value: unknown): AgentJobMode {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'agents' || normalized === 'hybrid') {
    return normalized;
  }
  return 'hybrid';
}

function clampAttempts(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) {
    return 2;
  }
  return Math.max(1, Math.min(3, numeric));
}
