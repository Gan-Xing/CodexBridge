import {
  createMissionGeneration,
  createMissionRetryAggregate,
  mapMissionStatusToGenerationStatus,
} from './domain_records.js';
import { createMissionResumeSnapshot } from './control_actions.js';
import type { MissionRepository } from './repository.js';
import { transitionMission } from './state_machine.js';
import type {
  Mission,
  MissionAttempt,
  MissionEvent,
  MissionPendingApproval,
} from './types.js';
import type {
  GetMissionAttemptsInput,
  GetMissionDetailInput,
  GetMissionExecutionInput,
  GetMissionTimelineInput,
  ListMissionSummariesInput,
  MissionArtifactRefView,
  MissionControlApi,
  MissionControlCommands,
  MissionControlQueries,
  MissionControlRequest,
  MissionControlResponse,
  MissionControlStreams,
  MissionControlBoundaryMetadata,
  MissionDetailView,
  MissionExecutionRefsView,
  MissionExecutionView,
  MissionHostBindingView,
  MissionStreamFrame,
  MissionSummaryFilter,
  MissionSummaryView,
  MissionAttemptsView,
  MissionTimelineEntry,
  MissionTimelineView,
  ResumeMissionInput,
  RetryMissionInput,
  StopMissionInput,
  StreamMissionInput,
} from './api_contract.js';

export interface DirectMissionControlApiOptions {
  repository: MissionRepository;
  now?: () => number;
  generateId?: () => string;
}

export class DirectMissionControlApi implements MissionControlApi {
  private readonly repository: MissionRepository;

  private readonly now: () => number;

  private readonly generateId: () => string;

  readonly commands: MissionControlCommands;

  readonly queries: MissionControlQueries;

  readonly streams: MissionControlStreams;

  constructor({
    repository,
    now = () => Date.now(),
    generateId = () => `mission-control-${Math.random().toString(16).slice(2)}`,
  }: DirectMissionControlApiOptions) {
    this.repository = repository;
    this.now = now;
    this.generateId = generateId;
    this.commands = {
      retryMission: (request) => this.handleRetryMission(request),
      resumeMission: (request) => this.handleResumeMission(request),
      stopMission: (request) => this.handleStopMission(request),
    };
    this.queries = {
      listMissionSummaries: (request) => this.handleListMissionSummaries(request),
      getMissionDetail: (request) => this.handleGetMissionDetail(request),
      getMissionTimeline: (request) => this.handleGetMissionTimeline(request),
      getMissionAttempts: (request) => this.handleGetMissionAttempts(request),
      getMissionExecution: (request) => this.handleGetMissionExecution(request),
    };
    this.streams = {
      streamMission: (request) => this.handleStreamMission(request),
    };
  }

  private handleListMissionSummaries(
    request: MissionControlRequest<ListMissionSummariesInput>,
  ): MissionControlResponse<MissionSummaryView[]> {
    const filter = request.input.filter ?? null;
    const summaries = this.repository
      .listMissions()
      .filter((mission) => matchesMissionSummaryFilter(mission, filter))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((mission) => this.buildMissionSummaryView(mission));
    return withMeta(request.meta, summaries);
  }

  private handleGetMissionDetail(
    request: MissionControlRequest<GetMissionDetailInput>,
  ): MissionControlResponse<MissionDetailView | null> {
    const mission = this.repository.getMissionById(request.input.missionId);
    return withMeta(request.meta, mission ? this.buildMissionDetailView(mission) : null);
  }

  private handleGetMissionTimeline(
    request: MissionControlRequest<GetMissionTimelineInput>,
  ): MissionControlResponse<MissionTimelineView | null> {
    const mission = this.repository.getMissionById(request.input.missionId);
    if (!mission) {
      return withMeta(request.meta, null);
    }
    return withMeta(request.meta, {
      missionId: mission.id,
      entries: this.buildMissionTimelineEntries(mission.id),
    });
  }

  private handleGetMissionAttempts(
    request: MissionControlRequest<GetMissionAttemptsInput>,
  ): MissionControlResponse<MissionAttemptsView | null> {
    const mission = this.repository.getMissionById(request.input.missionId);
    if (!mission) {
      return withMeta(request.meta, null);
    }
    return withMeta(request.meta, {
      missionId: mission.id,
      attempts: sortAttempts(this.repository.listAttempts(mission.id)),
    });
  }

  private handleGetMissionExecution(
    request: MissionControlRequest<GetMissionExecutionInput>,
  ): MissionControlResponse<MissionExecutionView | null> {
    const mission = this.repository.getMissionById(request.input.missionId);
    if (!mission) {
      return withMeta(request.meta, null);
    }
    return withMeta(request.meta, this.buildMissionExecutionView(mission));
  }

  private handleRetryMission(
    request: MissionControlRequest<RetryMissionInput>,
  ): MissionControlResponse<MissionDetailView> {
    const mission = this.requireMission(request.input.missionId);
    const at = this.now();
    const previousGeneration = createMissionGeneration(mission, {
      at,
      id: mission.activeGenerationId,
      index: mission.activeGenerationIndex,
      checklistSnapshotId: mission.currentChecklistSnapshotId,
      status: mapMissionStatusToGenerationStatus(mission.status),
      trigger: mission.activeGenerationIndex === 1 ? 'initial' : 'retry',
    });
    const retried = createMissionRetryAggregate(mission, {
      at,
      reason: request.input.reason,
      bridgeSessionId: request.input.bridgeSessionId,
      codexThreadId: request.input.codexThreadId,
      workflowPath: request.input.workflowPath,
      workspacePath: request.input.workspacePath,
    });
    this.repository.saveGeneration(previousGeneration);
    this.repository.saveMission(retried.mission);
    this.repository.saveGeneration(retried.generation);
    this.repository.saveChecklistSnapshot(retried.checklistSnapshot);
    this.repository.appendEvent(this.createMissionEvent({
      mission: retried.mission,
      attemptId: null,
      kind: 'mission.retrying',
      summary: normalizeText(request.input.reason) ?? 'Mission queued for retry.',
      metadata: buildActorMetadata(request.input.actor),
    }));
    return withMeta(request.meta, this.buildMissionDetailView(retried.mission));
  }

  private handleResumeMission(
    request: MissionControlRequest<ResumeMissionInput>,
  ): MissionControlResponse<MissionDetailView> {
    const mission = this.requireMission(request.input.missionId);
    const resumed = createMissionResumeSnapshot(mission, {
      at: this.now(),
      reason: request.input.reason,
    });
    this.repository.saveMission(resumed);
    this.repository.appendEvent(this.createMissionEvent({
      mission: resumed,
      attemptId: null,
      kind: 'mission.queued',
      summary: normalizeText(request.input.reason) ?? 'Mission queued to continue after human input.',
      metadata: buildActorMetadata(request.input.actor),
    }));
    return withMeta(request.meta, this.buildMissionDetailView(resumed));
  }

  private handleStopMission(
    request: MissionControlRequest<StopMissionInput>,
  ): MissionControlResponse<MissionDetailView> {
    const mission = this.requireMission(request.input.missionId);
    const at = this.now();
    const reason = normalizeText(request.input.reason) ?? 'Mission stopped.';
    if (
      mission.status === 'completed'
      || mission.status === 'failed'
      || mission.status === 'archived'
    ) {
      return withMeta(request.meta, this.buildMissionDetailView(mission));
    }
    let activeAttempt = mission.activeAttemptId
      ? this.repository.getAttemptById(mission.activeAttemptId)
      : null;
    if (activeAttempt && !isTerminalAttemptStatus(activeAttempt.status)) {
      activeAttempt = {
        ...activeAttempt,
        status: 'stopped',
        error: reason,
        endedAt: activeAttempt.endedAt ?? at,
        updatedAt: at,
      };
      this.repository.saveAttempt(activeAttempt);
      this.repository.appendEvent(this.createMissionEvent({
        mission,
        attemptId: activeAttempt.id,
        kind: 'attempt.stopped',
        summary: reason,
        metadata: buildActorMetadata(request.input.actor),
      }));
    }
    const stopped = mission.status === 'stopped'
      ? {
        ...mission,
        updatedAt: at,
      }
      : transitionMission(mission, 'stopped', {
        at,
        reason,
        lastError: normalizeText(mission.lastError) ?? reason,
        activeAttemptId: mission.activeAttemptId,
      });
    this.repository.saveMission(stopped);
    this.repository.appendEvent(this.createMissionEvent({
      mission: stopped,
      attemptId: activeAttempt?.id ?? null,
      kind: 'mission.stopped',
      summary: reason,
      metadata: buildActorMetadata(request.input.actor),
    }));
    return withMeta(request.meta, this.buildMissionDetailView(stopped));
  }

  private async *handleStreamMission(
    request: MissionControlRequest<StreamMissionInput>,
  ): AsyncIterable<MissionControlResponse<MissionStreamFrame>> {
    const mission = this.repository.getMissionById(request.input.missionId);
    if (!mission) {
      return;
    }
    yield withMeta(request.meta, {
      type: 'detail',
      detail: this.buildMissionDetailView(mission),
    });
    if (request.input.includeHistory === false) {
      return;
    }
    for (const entry of this.buildMissionTimelineEntries(mission.id)) {
      yield withMeta(request.meta, {
        type: 'timeline_entry',
        entry,
      });
    }
  }

  private buildMissionSummaryView(mission: Mission): MissionSummaryView {
    const workItem = this.repository.getWorkItemById(mission.workItemId);
    return {
      workItem,
      mission,
      summary: mission.workpad.summary,
      latestBlocker: mission.workpad.latestBlocker,
      latestVerifierSummary: mission.workpad.latestVerifierSummary,
      finalResultSummary: mission.workpad.finalResultSummary,
      lastResultPreview: mission.lastResultPreview,
      lastError: mission.lastError,
      pendingApproval: clonePendingApproval(mission.pendingApproval),
      hostBindings: buildMissionHostBindings(mission),
      executionRefs: this.buildMissionExecutionRefs(mission),
      artifactRefs: buildMissionArtifactRefs(mission.resultArtifacts),
    };
  }

  private buildMissionDetailView(mission: Mission): MissionDetailView {
    const summary = this.buildMissionSummaryView(mission);
    return {
      ...summary,
      activeGeneration: this.repository.getGenerationById(mission.activeGenerationId),
      currentChecklistSnapshot: this.repository.getChecklistSnapshotById(mission.currentChecklistSnapshotId),
      planChangeRequests: this.repository.listPlanChangeRequests(mission.id),
      attempts: sortAttempts(this.repository.listAttempts(mission.id)),
    };
  }

  private buildMissionExecutionView(mission: Mission): MissionExecutionView {
    return {
      missionId: mission.id,
      pendingApproval: clonePendingApproval(mission.pendingApproval),
      hostBindings: buildMissionHostBindings(mission),
      executionRefs: this.buildMissionExecutionRefs(mission),
      artifactRefs: buildMissionArtifactRefs(mission.resultArtifacts),
    };
  }

  private buildMissionExecutionRefs(mission: Mission): MissionExecutionRefsView {
    const attempts = sortAttempts(this.repository.listAttempts(mission.id));
    const activeAttempt = mission.activeAttemptId
      ? attempts.find((attempt) => attempt.id === mission.activeAttemptId) ?? null
      : null;
    const latestAttempt = activeAttempt ?? attempts[attempts.length - 1] ?? null;
    return {
      activeAttemptId: mission.activeAttemptId,
      providerRunId: latestAttempt?.providerRunId ?? null,
      providerThreadId: latestAttempt?.providerThreadId ?? null,
      workflowPath: mission.workflowPath,
      workspacePath: mission.workspacePath,
    };
  }

  private buildMissionTimelineEntries(missionId: string): MissionTimelineEntry[] {
    const entries: MissionTimelineEntry[] = [
      ...this.repository.listGenerations(missionId).map((generation) => ({
        type: 'generation' as const,
        createdAt: generation.createdAt,
        generation,
      })),
      ...this.repository.listChecklistSnapshots(missionId).map((checklistSnapshot) => ({
        type: 'checklist_snapshot' as const,
        createdAt: checklistSnapshot.createdAt,
        checklistSnapshot,
      })),
      ...this.repository.listPlanChangeRequests(missionId).map((planChangeRequest) => ({
        type: 'plan_change_request' as const,
        createdAt: planChangeRequest.createdAt,
        planChangeRequest,
      })),
      ...this.repository.listAttempts(missionId).map((attempt) => ({
        type: 'attempt' as const,
        createdAt: attempt.createdAt,
        attempt,
      })),
      ...this.repository.listEvents(missionId).map((event) => ({
        type: 'event' as const,
        createdAt: event.createdAt,
        event,
      })),
    ];
    return entries.sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt - right.createdAt;
      }
      return compareMissionTimelineEntry(left, right);
    });
  }

  private createMissionEvent(input: {
    mission: Mission;
    attemptId: string | null;
    kind: MissionEvent['kind'];
    summary: string;
    metadata: Record<string, unknown>;
  }): MissionEvent {
    return {
      id: this.generateId(),
      missionId: input.mission.id,
      attemptId: input.attemptId,
      generationId: input.mission.activeGenerationId,
      generationIndex: input.mission.activeGenerationIndex,
      kind: input.kind,
      summary: input.summary,
      detail: null,
      metadata: input.metadata,
      createdAt: this.now(),
    };
  }

  private requireMission(missionId: string): Mission {
    const mission = this.repository.getMissionById(missionId);
    if (!mission) {
      throw new Error(`Unknown mission: ${missionId}`);
    }
    return mission;
  }
}

function buildMissionHostBindings(mission: Mission): MissionHostBindingView {
  return {
    platform: mission.platform,
    externalScopeId: mission.externalScopeId,
    source: mission.source,
    sourceRef: mission.sourceRef,
    providerProfileId: mission.providerProfileId,
    bridgeSessionId: mission.bridgeSessionId,
    codexThreadId: mission.codexThreadId,
  };
}

function buildMissionArtifactRefs(resultArtifacts: unknown[]): MissionArtifactRefView[] {
  return resultArtifacts
    .map((artifact) => {
      const value = artifact as {
        type?: unknown;
        path?: unknown;
        name?: unknown;
        mimeType?: unknown;
        caption?: unknown;
      };
      const type = normalizeText(value?.type) ?? 'other';
      return {
        type,
        path: normalizeText(value?.path),
        name: normalizeText(value?.name),
        mimeType: normalizeText(value?.mimeType),
        caption: normalizeText(value?.caption),
      };
    })
    .filter((artifact) => artifact.path || artifact.name);
}

function buildActorMetadata(actor: RetryMissionInput['actor'] | ResumeMissionInput['actor'] | StopMissionInput['actor']): Record<string, unknown> {
  if (!actor) {
    return {};
  }
  return {
    actorId: actor.actorId,
    actorType: actor.actorType,
  };
}

function clonePendingApproval(value: MissionPendingApproval | null): MissionPendingApproval | null {
  if (!value) {
    return null;
  }
  return {
    ...value,
    options: value.options.map((option) => ({ ...option })),
  };
}

function isTerminalAttemptStatus(status: MissionAttempt['status']): boolean {
  return (
    status === 'completed'
    || status === 'failed'
    || status === 'stopped'
    || status === 'waiting_user'
    || status === 'needs_human'
    || status === 'handoff'
    || status === 'blocked'
  );
}

function sortAttempts(attempts: MissionAttempt[]): MissionAttempt[] {
  return [...attempts].sort((left, right) => {
    const leftGeneration = left.generationIndex ?? 0;
    const rightGeneration = right.generationIndex ?? 0;
    if (leftGeneration !== rightGeneration) {
      return leftGeneration - rightGeneration;
    }
    return left.index - right.index;
  });
}

function matchesMissionSummaryFilter(mission: Mission, filter: MissionSummaryFilter | null): boolean {
  if (!filter) {
    return true;
  }
  if (normalizeText(filter.platform) && mission.platform !== filter.platform) {
    return false;
  }
  if (normalizeText(filter.externalScopeId) && mission.externalScopeId !== filter.externalScopeId) {
    return false;
  }
  if (normalizeText(filter.providerProfileId) && mission.providerProfileId !== filter.providerProfileId) {
    return false;
  }
  if (Array.isArray(filter.statuses) && filter.statuses.length > 0 && !filter.statuses.includes(mission.status)) {
    return false;
  }
  if (Array.isArray(filter.sources) && filter.sources.length > 0 && !filter.sources.includes(mission.source)) {
    return false;
  }
  return true;
}

function compareMissionTimelineEntry(left: MissionTimelineEntry, right: MissionTimelineEntry): number {
  const rank = (entry: MissionTimelineEntry): number => {
    switch (entry.type) {
      case 'generation':
        return 0;
      case 'checklist_snapshot':
        return 1;
      case 'plan_change_request':
        return 2;
      case 'attempt':
        return 3;
      case 'event':
        return 4;
    }
  };
  return rank(left) - rank(right);
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function withMeta<TData>(
  meta: MissionControlBoundaryMetadata,
  data: TData,
): MissionControlResponse<TData> {
  return {
    meta: {
      requestId: meta.requestId,
      correlationId: meta.correlationId ?? null,
      idempotencyKey: meta.idempotencyKey ?? null,
    },
    data,
  };
}
