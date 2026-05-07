import {
  createMissionChecklistSnapshot,
  createMissionGeneration,
  createMissionRetryAggregate,
  mapMissionStatusToGenerationStatus,
} from './domain_records.js';
import {
  createMissionResumeSnapshot,
  createMissionStopRequest,
  materializeMissionStop,
  shouldMissionStopImmediately,
} from './control_actions.js';
import {
  getActiveChecklistItem,
  getLatestMissionCycleResult,
  summarizeChecklistSnapshotProgress,
} from './cycle_result.js';
import { createMissionAggregateFromSourceSummary } from './source_mission.js';
import { createWorkItemSourceSummary } from './source.js';
import { createMissionWorkpadStatusView } from './workpad_view.js';
import {
  MissionWorkflowLoader,
  type LoadedMissionWorkflow,
} from './workflow.js';
import type { MissionRepository } from './repository.js';
import type {
  ChecklistSnapshot,
  Mission,
  MissionAttempt,
  MissionEvent,
  MissionPendingApproval,
  MissionStopRequest,
  WorkItem,
} from './types.js';
import type {
  CreateMissionCommandInput,
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
  SyncMissionSourceInput,
  StopMissionInput,
  StreamMissionInput,
} from './api_contract.js';

export interface DirectMissionControlApiOptions {
  repository: MissionRepository;
  now?: () => number;
  generateId?: () => string;
  workflowLoader?: MissionWorkflowLoader;
}

export class DirectMissionControlApi implements MissionControlApi {
  private readonly repository: MissionRepository;

  private readonly now: () => number;

  private readonly generateId: () => string;

  private readonly workflowLoader: MissionWorkflowLoader;

  readonly commands: MissionControlCommands;

  readonly queries: MissionControlQueries;

  readonly streams: MissionControlStreams;

  constructor({
    repository,
    now = () => Date.now(),
    generateId = () => `mission-control-${Math.random().toString(16).slice(2)}`,
    workflowLoader = new MissionWorkflowLoader(),
  }: DirectMissionControlApiOptions) {
    this.repository = repository;
    this.now = now;
    this.generateId = generateId;
    this.workflowLoader = workflowLoader;
    this.commands = {
      createMission: (request) => this.handleCreateMission(request),
      syncMissionSource: (request) => this.handleSyncMissionSource(request),
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

  private handleCreateMission(
    request: MissionControlRequest<CreateMissionCommandInput>,
  ): MissionControlResponse<MissionDetailView> {
    const existing = this.repository.getMissionById(request.input.missionId);
    if (existing && !shouldReplaceMissionOnCreate(this.repository, existing)) {
      return withMeta(request.meta, this.buildMissionDetailView(existing));
    }
    const created = createMissionAggregateFromSourceSummary({
      missionId: request.input.missionId,
      workItem: request.input.workItem,
      platform: request.input.platform,
      externalScopeId: request.input.externalScopeId,
      providerProfileId: request.input.providerProfileId,
      loopPolicy: request.input.loopPolicy,
      priority: request.input.priority,
      riskLevel: request.input.riskLevel,
      cwd: request.input.cwd,
      workspacePath: request.input.workspacePath,
      workflowPath: request.input.workflowPath,
      bridgeSessionId: resolveHostSessionId(request.input),
      codexThreadId: resolveProviderThreadId(request.input),
      immutableGoal: request.input.immutableGoal,
      immutablePrompt: request.input.immutablePrompt,
      maxAttempts: request.input.maxAttempts,
      maxTurns: request.input.maxTurns,
      initialStatus: request.input.initialStatus,
      reason: request.input.reason,
      now: this.now(),
    });
    if (existing) {
      this.repository.resetMission(created.mission);
    } else {
      this.repository.saveMission(created.mission);
    }
    this.repository.saveWorkItem(created.workItem);
    this.repository.saveGeneration(created.generation);
    this.repository.saveChecklistSnapshot(created.checklistSnapshot);
    this.repository.appendEvent(this.createMissionEvent({
      mission: created.mission,
      attemptId: null,
      kind: 'mission.created',
      summary: 'Mission created from a source-backed work item.',
      metadata: {
        source: created.mission.source,
        sourceRef: created.mission.sourceRef,
        sourceRevision: request.input.workItem.sourceRevision,
        ...buildActorMetadata(request.input.actor),
      },
    }));
    if (created.mission.status === 'queued') {
      this.repository.appendEvent(this.createMissionEvent({
        mission: created.mission,
        attemptId: null,
        kind: 'mission.queued',
        summary: normalizeText(request.input.reason) ?? 'Mission queued from a source-backed work item.',
        metadata: buildActorMetadata(request.input.actor),
      }));
    }
    return withMeta(request.meta, this.buildMissionDetailView(created.mission));
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
      bridgeSessionId: resolveHostSessionId(request.input),
      codexThreadId: resolveProviderThreadId(request.input),
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

  private handleSyncMissionSource(
    request: MissionControlRequest<SyncMissionSourceInput>,
  ): MissionControlResponse<MissionDetailView> {
    const mission = this.requireMission(request.input.missionId);
    if (!canSyncMissionSource(this.repository, mission)) {
      throw new Error(`Mission source can only be synced before attempts start: ${mission.id}`);
    }
    const existingWorkItem = this.repository.getWorkItemById(mission.workItemId);
    const existingGeneration = this.repository.getGenerationById(mission.activeGenerationId);
    const existingChecklistSnapshot = this.repository.getChecklistSnapshotById(mission.currentChecklistSnapshotId);
    const nextSourceSummary = createWorkItemSourceSummary(request.input.workItem);
    const currentSourceSummary = buildMissionSourceSummary(mission, existingWorkItem, existingChecklistSnapshot);
    if (
      nextSourceSummary.source !== mission.source
      || nextSourceSummary.sourceRef !== currentSourceSummary.sourceRef
    ) {
      throw new Error(`Mission source sync must preserve source identity: ${mission.id}`);
    }
    if (JSON.stringify(nextSourceSummary) === JSON.stringify(currentSourceSummary)) {
      return withMeta(request.meta, this.buildMissionDetailView(mission));
    }

    const at = this.now();
    const reason = normalizeText(request.input.reason) ?? 'Mission source synced before execution.';
    const synced = createMissionAggregateFromSourceSummary({
      missionId: mission.id,
      workItem: nextSourceSummary,
      platform: mission.platform,
      externalScopeId: mission.externalScopeId,
      providerProfileId: mission.providerProfileId,
      loopPolicy: mission.loopPolicy,
      priority: mission.priority,
      riskLevel: mission.riskLevel,
      cwd: mission.cwd,
      workspacePath: mission.workspacePath,
      workflowPath: mission.workflowPath,
      bridgeSessionId: mission.bridgeSessionId,
      codexThreadId: mission.codexThreadId,
      maxAttempts: mission.maxAttempts,
      maxTurns: mission.maxTurns,
      initialStatus: mission.status === 'draft' ? 'draft' : 'queued',
      reason,
      now: at,
    });
    const nextChecklistVersion = Math.max(
      mission.currentChecklistSnapshotVersion,
      existingChecklistSnapshot?.version ?? 0,
    ) + 1;
    const syncedMission: Mission = {
      ...synced.mission,
      workItemId: mission.workItemId,
      activeGenerationId: mission.activeGenerationId,
      activeGenerationIndex: mission.activeGenerationIndex,
      generationCount: mission.generationCount,
      currentChecklistSnapshotVersion: nextChecklistVersion,
      createdAt: mission.createdAt,
      updatedAt: at,
    };
    const syncedWorkItem: WorkItem = {
      ...synced.workItem,
      createdAt: existingWorkItem?.createdAt ?? mission.createdAt,
      updatedAt: at,
    };
    const syncedChecklistSnapshot = createMissionChecklistSnapshot(syncedMission, {
      at,
      version: nextChecklistVersion,
      generationId: mission.activeGenerationId,
      sourceRevision: nextSourceSummary.sourceRevision,
    });
    syncedMission.currentChecklistSnapshotId = syncedChecklistSnapshot.id;
    const syncedGeneration = existingGeneration
      ? {
        ...existingGeneration,
        checklistSnapshotId: syncedChecklistSnapshot.id,
        updatedAt: at,
      }
      : createMissionGeneration(syncedMission, {
        at,
        id: mission.activeGenerationId,
        index: mission.activeGenerationIndex,
        trigger: mission.activeGenerationIndex === 1 ? 'initial' : 'retry',
        checklistSnapshotId: syncedChecklistSnapshot.id,
        status: mapMissionStatusToGenerationStatus(mission.status),
      });

    this.repository.saveMission(syncedMission);
    this.repository.saveWorkItem(syncedWorkItem);
    this.repository.saveGeneration(syncedGeneration);
    if (existingChecklistSnapshot && existingChecklistSnapshot.id !== syncedChecklistSnapshot.id) {
      this.repository.saveChecklistSnapshot({
        ...existingChecklistSnapshot,
        supersededAt: at,
        updatedAt: at,
      });
    }
    this.repository.saveChecklistSnapshot(syncedChecklistSnapshot);
    this.repository.appendEvent(this.createMissionEvent({
      mission: syncedMission,
      attemptId: null,
      kind: 'mission.source_synced',
      summary: reason,
      metadata: {
        previousSourceRevision: currentSourceSummary.sourceRevision,
        sourceRevision: nextSourceSummary.sourceRevision,
        previousChecklistHash: existingChecklistSnapshot?.hash ?? null,
        checklistHash: syncedChecklistSnapshot.hash,
        ...buildActorMetadata(request.input.actor),
      },
    }));
    return withMeta(request.meta, this.buildMissionDetailView(syncedMission));
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
      mission.status === 'stopped'
      || mission.status === 'completed'
      || mission.status === 'failed'
      || mission.status === 'archived'
    ) {
      return withMeta(request.meta, this.buildMissionDetailView(mission));
    }
    const stopRequested = createMissionStopRequest(mission, {
      at,
      requestId: request.meta.requestId,
      actorId: request.input.actor?.actorId ?? null,
      actorType: request.input.actor?.actorType ?? null,
      reason,
    });
    this.repository.saveMission(stopRequested);
    this.repository.appendEvent(this.createMissionEvent({
      mission: stopRequested,
      attemptId: stopRequested.activeAttemptId,
      kind: 'mission.stop_requested',
      summary: reason,
      metadata: {
        requestId: request.meta.requestId,
        ...buildActorMetadata(request.input.actor),
      },
    }));
    if (!shouldMissionStopImmediately(stopRequested)) {
      return withMeta(request.meta, this.buildMissionDetailView(stopRequested));
    }
    let activeAttempt = stopRequested.activeAttemptId
      ? this.repository.getAttemptById(stopRequested.activeAttemptId)
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
        mission: stopRequested,
        attemptId: activeAttempt.id,
        kind: 'attempt.stopped',
        summary: reason,
        metadata: {
          requestId: request.meta.requestId,
          ...buildActorMetadata(request.input.actor),
        },
      }));
    }
    const stopped = materializeMissionStop(stopRequested, {
      at,
      reason,
      lastError: normalizeText(stopRequested.lastError) ?? reason,
      activeAttemptId: activeAttempt?.id ?? stopRequested.activeAttemptId,
    });
    this.repository.saveMission(stopped);
    this.repository.appendEvent(this.createMissionEvent({
      mission: stopped,
      attemptId: activeAttempt?.id ?? null,
      kind: 'mission.stopped',
      summary: reason,
      metadata: {
        requestId: request.meta.requestId,
        ...buildActorMetadata(request.input.actor),
      },
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
    const events = this.repository.listEvents(mission.id);
    const attempts = sortAttempts(this.repository.listAttempts(mission.id));
    const workflow = this.resolveMissionWorkflow(mission);
    const checklistSnapshot = this.repository.getChecklistSnapshotById(mission.currentChecklistSnapshotId);
    return {
      workItem,
      mission,
      summary: mission.workpad.summary,
      latestBlocker: mission.workpad.latestBlocker,
      latestVerifierSummary: mission.workpad.latestVerifierSummary,
      latestCycleResult: getLatestMissionCycleResult(events),
      finalResultSummary: mission.workpad.finalResultSummary,
      lastResultPreview: mission.lastResultPreview,
      lastError: mission.lastError,
      pendingApproval: clonePendingApproval(mission.pendingApproval),
      hostBindings: buildMissionHostBindings(mission),
      executionRefs: this.buildMissionExecutionRefs(mission),
      workflow: workflow.view,
      checklistStatus: buildMissionChecklistStatusView(mission, checklistSnapshot),
      workpadStatus: createMissionWorkpadStatusView({
        mission,
        attempts,
        workflow: workflow.loadedWorkflow,
      }),
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
    const events = this.repository.listEvents(mission.id);
    const workflow = this.resolveMissionWorkflow(mission);
    const checklistSnapshot = this.repository.getChecklistSnapshotById(mission.currentChecklistSnapshotId);
    const attempts = sortAttempts(this.repository.listAttempts(mission.id));
    return {
      missionId: mission.id,
      stopRequest: cloneStopRequest(mission.stopRequest),
      pendingApproval: clonePendingApproval(mission.pendingApproval),
      latestCycleResult: getLatestMissionCycleResult(events),
      hostBindings: buildMissionHostBindings(mission),
      executionRefs: this.buildMissionExecutionRefs(mission),
      workflow: workflow.view,
      checklistStatus: buildMissionChecklistStatusView(mission, checklistSnapshot),
      workpadStatus: createMissionWorkpadStatusView({
        mission,
        attempts,
        workflow: workflow.loadedWorkflow,
      }),
      artifactRefs: buildMissionArtifactRefs(mission.resultArtifacts),
    };
  }

  private resolveMissionWorkflow(mission: Mission): {
    loadedWorkflow: LoadedMissionWorkflow | null;
    view: MissionSummaryView['workflow'];
  } {
    const result = this.workflowLoader.tryLoad({
      cwd: mission.cwd,
      workspacePath: mission.workspacePath,
      explicitPath: mission.workflowPath ?? undefined,
    });
    if (result.workflow) {
      return {
        loadedWorkflow: result.workflow,
        view: {
          status: 'loaded',
          source: result.workflow.source,
          error: null,
        },
      };
    }
    const workflowPath = result.error.workflowPath ?? mission.workflowPath ?? null;
    const error = result.error.issues.length > 0
      ? `${result.error.message} ${result.error.issues.join('; ')}`
      : result.error.message;
    return {
      loadedWorkflow: null,
      view: {
        status: 'invalid',
        source: {
          kind: 'file',
          path: workflowPath,
          label: workflowPath ?? 'invalid workflow',
        },
        error,
      },
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
    hostSessionId: mission.bridgeSessionId,
    providerThreadId: mission.codexThreadId,
    bridgeSessionId: mission.bridgeSessionId,
    codexThreadId: mission.codexThreadId,
  };
}

function resolveHostSessionId(
  input: Pick<CreateMissionCommandInput | RetryMissionInput, 'hostSessionId' | 'bridgeSessionId'>,
): string | null {
  return normalizeText(input.hostSessionId) ?? normalizeText(input.bridgeSessionId);
}

function resolveProviderThreadId(
  input: Pick<CreateMissionCommandInput | RetryMissionInput, 'providerThreadId' | 'codexThreadId'>,
): string | null {
  return normalizeText(input.providerThreadId) ?? normalizeText(input.codexThreadId);
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

function buildMissionChecklistStatusView(
  mission: Mission,
  checklistSnapshot: ChecklistSnapshot | null,
): MissionSummaryView['checklistStatus'] {
  const progress = summarizeChecklistSnapshotProgress(checklistSnapshot);
  const actionableItems = checklistSnapshot?.items.filter((item) => item.status !== 'skipped') ?? [];
  const currentItem = getActiveChecklistItem(checklistSnapshot, {
    preferredKinds: ['acceptance'],
  });
  return {
    generationId: mission.activeGenerationId,
    generationIndex: mission.activeGenerationIndex,
    checklistSnapshotId: checklistSnapshot?.id ?? mission.currentChecklistSnapshotId ?? null,
    checklistSnapshotVersion: checklistSnapshot?.version ?? mission.currentChecklistSnapshotVersion ?? null,
    sourceRevision: checklistSnapshot?.sourceRevision ?? null,
    totalItems: progress.totalItemCount,
    completedItems: progress.completedItemCount,
    blockedItems: actionableItems.filter((item) => item.status === 'blocked').length,
    overallCompletion: progress.overallCompletion,
    currentItem: currentItem ? { ...currentItem } : null,
  };
}

function buildActorMetadata(
  actor:
    | CreateMissionCommandInput['actor']
    | SyncMissionSourceInput['actor']
    | RetryMissionInput['actor']
    | ResumeMissionInput['actor']
    | StopMissionInput['actor'],
): Record<string, unknown> {
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

function cloneStopRequest(value: MissionStopRequest | null): MissionStopRequest | null {
  if (!value) {
    return null;
  }
  return {
    ...value,
  };
}

function buildMissionSourceSummary(
  mission: Mission,
  workItem: WorkItem | null,
  checklistSnapshot: ChecklistSnapshot | null,
) {
  return createWorkItemSourceSummary({
    source: mission.source,
    sourceRef: workItem?.sourceRef ?? mission.sourceRef ?? mission.id,
    sourceRevision: workItem?.sourceRevision ?? checklistSnapshot?.sourceRevision ?? null,
    title: workItem?.title ?? mission.title,
    goal: mission.goal,
    expectedOutput: checklistSnapshot?.expectedOutput ?? mission.expectedOutput,
    acceptanceCriteria: checklistSnapshot?.acceptanceCriteria ?? mission.acceptanceCriteria,
    plan: checklistSnapshot?.plan ?? mission.plan,
    metadata: workItem?.metadata ?? null,
  });
}

function canSyncMissionSource(repository: MissionRepository, mission: Mission): boolean {
  return (
    (mission.status === 'draft' || mission.status === 'queued')
    && mission.activeAttemptId === null
    && mission.stopRequest === null
    && mission.attemptCount === 0
    && repository.listAttempts(mission.id).length === 0
    && repository.listPlanChangeRequests(mission.id).length === 0
  );
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

function shouldReplaceMissionOnCreate(
  repository: MissionRepository,
  mission: Mission,
): boolean {
  return mission.attemptCount === 0
    && repository.listAttempts(mission.id).length === 0
    && repository.listEvents(mission.id).length === 0
    && repository.listPlanChangeRequests(mission.id).length === 0
    && mission.status !== 'running'
    && mission.status !== 'verifying'
    && mission.status !== 'repairing'
    && mission.status !== 'completed'
    && mission.status !== 'failed'
    && mission.status !== 'stopped'
    && mission.status !== 'archived';
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
