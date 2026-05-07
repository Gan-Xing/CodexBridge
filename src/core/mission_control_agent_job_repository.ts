import type {
  ChecklistSnapshot,
  Mission,
  MissionAttempt,
  MissionEvent,
  MissionGeneration,
  MissionRepository,
  PlanChangeRequest,
  WorkItem,
} from '../../packages/mission-control/src/index.js';
import {
  createProjectedMissionRuntimeStateForAgentJob,
  loadAgentJobMissionRuntimeState,
  serializeAgentJobMissionRuntimeState,
} from './mission_control_agent_job_adapter.js';
import type {
  AgentJob,
  AgentJobAttemptHistoryEntry,
  AgentJobMissionRuntimeState,
  AgentJobStatus,
  BridgeSession,
  TurnArtifactDeliveredItem,
} from '../types/core.js';

type MissionRuntimeState = {
  workItem: WorkItem | null;
  mission: Mission | null;
  generations: MissionGeneration[];
  checklistSnapshots: ChecklistSnapshot[];
  planChangeRequests: PlanChangeRequest[];
  attempts: MissionAttempt[];
  events: MissionEvent[];
};

export interface AgentJobMissionRepositoryStore {
  listJobs(): AgentJob[];
  getJobById(id: string): AgentJob | null;
  updateJob(id: string, updates: Partial<AgentJob>): AgentJob;
  resolveSession?(job: AgentJob): BridgeSession | null;
}

export interface AgentJobMissionRepositoryOptions {
  now?: () => number;
  materializeMissingState?: boolean;
}

export class AgentJobMissionRepository implements MissionRepository {
  private readonly now: () => number;

  private readonly materializeMissingState: boolean;

  constructor(
    private readonly store: AgentJobMissionRepositoryStore,
    options: AgentJobMissionRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.materializeMissingState = options.materializeMissingState ?? true;
  }

  getMissionById(id: string): Mission | null {
    const job = this.store.getJobById(id);
    return job ? this.ensureRuntimeState(job).mission : null;
  }

  getWorkItemById(id: string): WorkItem | null {
    for (const job of this.store.listJobs()) {
      const workItem = this.ensureRuntimeState(job).workItem;
      if (workItem?.id === id) {
        return cloneValue(workItem);
      }
    }
    return null;
  }

  saveWorkItem(workItem: WorkItem): WorkItem {
    const currentJob = this.store
      .listJobs()
      .find((job) => this.ensureRuntimeState(job).mission?.workItemId === workItem.id);
    if (!currentJob) {
      return workItem;
    }
    const currentState = this.ensureRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      workItem: cloneValue(workItem),
    });
    return workItem;
  }

  listMissions(): Mission[] {
    return this.store
      .listJobs()
      .map((job) => this.ensureRuntimeState(job).mission)
      .filter(Boolean) as Mission[];
  }

  listResumableMissions(now = Date.now()): Mission[] {
    return this.listMissions().filter((mission) => {
      if (!mission.lease) {
        return ['queued', 'planning', 'running', 'verifying', 'repairing', 'handoff'].includes(mission.status);
      }
      return mission.lease.releasedAt !== null || mission.lease.expiresAt <= now;
    });
  }

  saveMission(mission: Mission): Mission {
    const currentJob = this.requireJob(mission.id);
    const currentState = this.ensureRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      mission: cloneValue(mission),
    });
    return mission;
  }

  getGenerationById(id: string): MissionGeneration | null {
    for (const job of this.store.listJobs()) {
      const generation = this.ensureRuntimeState(job).generations.find((entry) => entry.id === id);
      if (generation) {
        return cloneValue(generation);
      }
    }
    return null;
  }

  listGenerations(missionId: string): MissionGeneration[] {
    const job = this.store.getJobById(missionId);
    return job ? this.ensureRuntimeState(job).generations : [];
  }

  saveGeneration(generation: MissionGeneration): MissionGeneration {
    const currentJob = this.requireJob(generation.missionId);
    const currentState = this.ensureRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      generations: upsertById(currentState.generations, generation).sort((left, right) => left.index - right.index),
    });
    return generation;
  }

  getChecklistSnapshotById(id: string): ChecklistSnapshot | null {
    for (const job of this.store.listJobs()) {
      const snapshot = this.ensureRuntimeState(job).checklistSnapshots.find((entry) => entry.id === id);
      if (snapshot) {
        return cloneValue(snapshot);
      }
    }
    return null;
  }

  listChecklistSnapshots(missionId: string): ChecklistSnapshot[] {
    const job = this.store.getJobById(missionId);
    return job ? this.ensureRuntimeState(job).checklistSnapshots : [];
  }

  saveChecklistSnapshot(snapshot: ChecklistSnapshot): ChecklistSnapshot {
    const currentJob = this.requireJob(snapshot.missionId);
    const currentState = this.ensureRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      checklistSnapshots: upsertById(currentState.checklistSnapshots, snapshot)
        .sort((left, right) => left.version - right.version),
    });
    return snapshot;
  }

  getPlanChangeRequestById(id: string): PlanChangeRequest | null {
    for (const job of this.store.listJobs()) {
      const changeRequest = this.ensureRuntimeState(job).planChangeRequests.find((entry) => entry.id === id);
      if (changeRequest) {
        return cloneValue(changeRequest);
      }
    }
    return null;
  }

  listPlanChangeRequests(missionId: string): PlanChangeRequest[] {
    const job = this.store.getJobById(missionId);
    return job ? this.ensureRuntimeState(job).planChangeRequests : [];
  }

  savePlanChangeRequest(changeRequest: PlanChangeRequest): PlanChangeRequest {
    const currentJob = this.requireJob(changeRequest.missionId);
    const currentState = this.ensureRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      planChangeRequests: upsertById(currentState.planChangeRequests, changeRequest),
    });
    return changeRequest;
  }

  getAttemptById(id: string): MissionAttempt | null {
    for (const job of this.store.listJobs()) {
      const attempt = this.ensureRuntimeState(job).attempts.find((entry) => entry.id === id);
      if (attempt) {
        return cloneValue(attempt);
      }
    }
    return null;
  }

  listAttempts(missionId: string): MissionAttempt[] {
    const job = this.store.getJobById(missionId);
    return job ? this.ensureRuntimeState(job).attempts : [];
  }

  saveAttempt(attempt: MissionAttempt): MissionAttempt {
    const currentJob = this.requireJob(attempt.missionId);
    const currentState = this.ensureRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      attempts: upsertById(currentState.attempts, attempt).sort((left, right) => {
        const leftGeneration = left.generationIndex ?? 0;
        const rightGeneration = right.generationIndex ?? 0;
        if (leftGeneration !== rightGeneration) {
          return leftGeneration - rightGeneration;
        }
        return left.index - right.index;
      }),
    });
    return attempt;
  }

  listEvents(missionId: string): MissionEvent[] {
    const job = this.store.getJobById(missionId);
    return job ? this.ensureRuntimeState(job).events : [];
  }

  appendEvent(event: MissionEvent): MissionEvent {
    const currentJob = this.requireJob(event.missionId);
    const currentState = this.ensureRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      events: [...currentState.events, cloneValue(event)],
    });
    return event;
  }

  resetMission(mission: Mission): Mission {
    const currentJob = this.requireJob(mission.id);
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

  private requireJob(id: string): AgentJob {
    const job = this.store.getJobById(id);
    if (!job) {
      throw new Error(`Unknown agent job: ${id}`);
    }
    return job;
  }

  private ensureRuntimeState(job: AgentJob): MissionRuntimeState {
    const state = loadAgentJobMissionRuntimeState(job);
    if (state.mission || !this.materializeMissingState) {
      return state;
    }
    const synthesized = createProjectedMissionRuntimeStateForAgentJob(job, {
      now: this.now(),
      codexThreadId: this.store.resolveSession?.(job)?.codexThreadId ?? null,
    });
    this.persistState(job, synthesized);
    return synthesized;
  }

  private persistState(job: AgentJob, state: MissionRuntimeState): AgentJob {
    const patch = buildAgentJobMissionPatch(job, state);
    return this.store.updateJob(job.id, patch);
  }
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

function mapMissionStatusToAgentJobStatus(status: Mission['status']): AgentJobStatus {
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

const ACTIVE_MISSION_JOB_STATUS_SET = new Set<Mission['status']>([
  'planning',
  'running',
  'verifying',
  'repairing',
]);

const TERMINAL_MISSION_JOB_STATUS_SET = new Set<Mission['status']>([
  'waiting_user',
  'needs_human',
  'handoff',
  'blocked',
  'completed',
  'failed',
  'stopped',
  'archived',
]);
