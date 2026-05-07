import crypto from 'node:crypto';
import {
  DirectMissionControlApi,
  shouldMissionRetryReuseAccumulatedContext,
  type MissionDetailView,
  type MissionSummaryView,
} from '../../packages/mission-control/src/index.js';
import { NotFoundError } from './errors.js';
import { AgentJobMissionRepository } from './mission_control_agent_job_repository.js';
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
  now?: () => number;
  locale?: string | null;
}

export class AgentJobService {
  private readonly agentJobs: AgentJobRepository;

  private readonly bridgeSessions: BridgeSessionsLike | null;

  private readonly now: () => number;

  private readonly i18n: Translator;

  constructor({
    agentJobs,
    bridgeSessions = null,
    now = () => Date.now(),
    locale = null,
  }: AgentJobServiceOptions) {
    this.agentJobs = agentJobs;
    this.bridgeSessions = bridgeSessions;
    this.now = now;
    this.i18n = createI18n(locale);
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
    return this.createMissionControlApi().queries.getMissionDetail({
      meta: this.createMissionControlMeta(`agent-detail:${id}`),
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
    return job;
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
    return this.updateJob(id, {
      title: normalizeTitle(title, 'Agent'),
    });
  }

  requestStop(id: string): AgentJob {
    this.requireById(id);
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

  retryJob(id: string): AgentJob {
    const current = this.requireById(id);
    const api = this.createMissionControlApi();
    const detail = api.queries.getMissionDetail({
      meta: this.createMissionControlMeta(`agent-detail:${id}`),
      input: {
        missionId: id,
      },
    }).data;
    if (detail?.mission && shouldMissionRetryReuseAccumulatedContext(detail.mission)) {
      api.commands.resumeMission({
        meta: this.createMissionControlMeta(`agent-resume:${id}`),
        input: {
          missionId: id,
          reason: 'Agent mission queued to continue after human input.',
          actor: {
            actorId: 'agent-job-service',
            actorType: 'host',
          },
        },
      });
      return this.requireById(id);
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

  resetRunningJobs(): void {
    const now = this.now();
    for (const job of this.agentJobs.list()) {
      if (!job.running) {
        continue;
      }
      this.agentJobs.save({
        ...job,
        running: false,
        status: job.stopRequested ? 'stopped' : 'queued',
        updatedAt: now,
      });
    }
  }

  claimQueuedJobs(platform: string, limit = 2): AgentJob[] {
    const now = this.now();
    const jobs = this.agentJobs
      .list()
      .filter((job) => job.platform === platform && job.status === 'queued' && !job.running && !job.stopRequested)
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, limit);
    for (const job of jobs) {
      this.agentJobs.save({
        ...job,
        status: 'planning',
        running: true,
        updatedAt: now,
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

  private createMissionControlApi(): DirectMissionControlApi {
    return new DirectMissionControlApi({
      repository: new AgentJobMissionRepository({
        listJobs: () => this.agentJobs.list(),
        getJobById: (id) => this.agentJobs.getById(id),
        updateJob: (id, updates) => this.updateJob(id, updates),
        resolveSession: (job) => this.getSession(job),
      }, {
        now: this.now,
      }),
      now: this.now,
    });
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
    normalized === 'queued'
    || normalized === 'planning'
    || normalized === 'running'
    || normalized === 'verifying'
    || normalized === 'repairing'
    || normalized === 'waiting_user'
    || normalized === 'needs_human'
    || normalized === 'handoff'
    || normalized === 'blocked'
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
