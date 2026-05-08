import {
  buildChecklistSnapshotId,
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
import { transitionMission } from './state_machine.js';
import {
  getActiveFormalChecklistItem,
  getLatestMissionCycleResult,
  summarizeChecklistSnapshotProgress,
} from './cycle_result.js';
import { createMissionAggregateFromSourceSummary } from './source_mission.js';
import { createWorkItemSourceSummary } from './source.js';
import { createMissionSupervisionSnapshot } from './supervision.js';
import { createMissionWorkpadStatusView } from './workpad_view.js';
import {
  MissionWorkflowLoader,
  type LoadedMissionWorkflow,
} from './workflow.js';
import { MissionWorkflowResolver } from './workflow_resolver.js';
import type { MissionRepository } from './repository.js';
import type {
  ChecklistSnapshot,
  Mission,
  MissionAttempt,
  MissionCheckpoint,
  MissionEnvironmentStamp,
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
  GetMissionLoopSnapshotInput,
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
  MissionLoopSnapshotView,
  MissionStreamFrame,
  MissionSummaryFilter,
  MissionSummaryView,
  MissionAttemptsView,
  MissionTimelineEntry,
  MissionTimelineView,
  ProposePlanChangeInput,
  ResolvePlanChangeInput,
  SubmitApprovalInput,
  StartMissionInput,
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
  workflowResolver?: MissionWorkflowResolver;
}

export class DirectMissionControlApi implements MissionControlApi {
  private readonly repository: MissionRepository;

  private readonly now: () => number;

  private readonly generateId: () => string;

  private readonly workflowLoader: MissionWorkflowLoader;

  private readonly workflowResolver: MissionWorkflowResolver;

  readonly commands: MissionControlCommands;

  readonly queries: MissionControlQueries;

  readonly streams: MissionControlStreams;

  constructor({
    repository,
    now = () => Date.now(),
    generateId = () => `mission-control-${Math.random().toString(16).slice(2)}`,
    workflowLoader = new MissionWorkflowLoader(),
    workflowResolver = new MissionWorkflowResolver(),
  }: DirectMissionControlApiOptions) {
    this.repository = repository;
    this.now = now;
    this.generateId = generateId;
    this.workflowLoader = workflowLoader;
    this.workflowResolver = workflowResolver;
    this.commands = {
      createMission: (request) => this.handleCreateMission(request),
      startMission: (request) => this.handleStartMission(request),
      submitApproval: (request) => this.handleSubmitApproval(request),
      syncMissionSource: (request) => this.handleSyncMissionSource(request),
      proposePlanChange: (request) => this.handleProposePlanChange(request),
      resolvePlanChange: (request) => this.handleResolvePlanChange(request),
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
      getMissionLoopSnapshot: (request) => this.handleGetMissionLoopSnapshot(request),
    };
    this.streams = {
      streamMission: (request) => this.handleStreamMission(request),
      streamMissionSnapshots: (request) => this.handleStreamMissionSnapshots(request),
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

  private handleGetMissionLoopSnapshot(
    request: MissionControlRequest<GetMissionLoopSnapshotInput>,
  ): MissionControlResponse<MissionLoopSnapshotView | null> {
    const mission = this.repository.getMissionById(request.input.missionId);
    if (!mission) {
      return withMeta(request.meta, null);
    }
    return withMeta(request.meta, this.buildMissionLoopSnapshotView(mission));
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

  private handleStartMission(
    request: MissionControlRequest<StartMissionInput>,
  ): MissionControlResponse<MissionDetailView> {
    const mission = this.requireMission(request.input.missionId);
    if (
      mission.status !== 'draft'
      && mission.status !== 'awaiting_checklist_confirm'
      && mission.status !== 'awaiting_prompt_confirm'
    ) {
      return withMeta(request.meta, this.buildMissionDetailView(mission));
    }
    const staged = advanceMissionStartGate(this.repository, mission, {
      at: this.now(),
      requestId: request.meta.requestId,
      confirmChecklist: request.input.confirmChecklist === true,
      confirmPrompt: request.input.confirmPrompt === true,
    });
    this.repository.saveMission(staged.mission);
    this.repository.appendEvent(this.createMissionEvent({
      mission: staged.mission,
      attemptId: null,
      kind: staged.eventKind,
      summary: staged.summary,
      metadata: {
        requestId: request.meta.requestId,
        checklistSnapshotId: staged.mission.currentChecklistSnapshotId,
        checklistSnapshotVersion: staged.mission.currentChecklistSnapshotVersion,
        checklistHash: staged.checklistSnapshot?.hash ?? null,
        confirmChecklist: request.input.confirmChecklist === true,
        confirmPrompt: request.input.confirmPrompt === true,
        ...buildActorMetadata(request.input.actor),
      },
    }));
    return withMeta(request.meta, this.buildMissionDetailView(staged.mission));
  }

  private handleSubmitApproval(
    request: MissionControlRequest<SubmitApprovalInput>,
  ): MissionControlResponse<MissionDetailView> {
    const mission = this.requireMission(request.input.missionId);
    const pendingApproval = mission.pendingApproval;
    const approvalId = normalizeText(request.input.approvalId) ?? pendingApproval?.requestId ?? null;
    if (pendingApproval && approvalId && pendingApproval.requestId !== approvalId) {
      throw new Error(`Mission approval does not match the active pending approval: ${mission.id}`);
    }

    if (mission.status === 'scope_change_pending') {
      return this.handleResolvePlanChange({
        meta: request.meta,
        input: {
          missionId: mission.id,
          planChangeRequestId: approvalId,
          decision: request.input.decision,
          reason: request.input.reason,
          actor: request.input.actor,
        },
      });
    }

    const at = this.now();
    if (
      mission.status === 'awaiting_checklist_confirm'
      || mission.status === 'awaiting_prompt_confirm'
    ) {
      if (request.input.decision === 'reject') {
        const stopped = transitionMission(mission, 'stopped', {
          at,
          reason: normalizeText(request.input.reason) ?? 'Mission start was rejected before the first autonomous cycle.',
          pendingApproval: null,
          workpad: {
            ...mission.workpad,
            summary: 'Mission start was rejected before autonomous execution.',
            latestBlocker: null,
            latestVerifierSummary: null,
            updatedAt: at,
          },
        });
        this.repository.saveMission(stopped);
        this.repository.appendEvent(this.createMissionEvent({
          mission: stopped,
          attemptId: null,
          kind: 'mission.stopped',
          summary: stopped.statusReason ?? 'Mission start was rejected before the first autonomous cycle.',
          metadata: {
            requestId: request.meta.requestId,
            approvalId,
            decision: request.input.decision,
            responseText: normalizeText(request.input.responseText) ?? null,
            ...buildActorMetadata(request.input.actor),
          },
        }));
        return withMeta(request.meta, this.buildMissionDetailView(stopped));
      }

      const staged = advanceMissionStartGate(this.repository, mission, {
        at,
        requestId: request.meta.requestId,
        confirmChecklist: mission.status === 'awaiting_checklist_confirm',
        confirmPrompt: mission.status === 'awaiting_prompt_confirm',
      });
      this.repository.saveMission(staged.mission);
      this.repository.appendEvent(this.createMissionEvent({
        mission: staged.mission,
        attemptId: null,
        kind: staged.eventKind,
        summary: staged.summary,
        metadata: {
          requestId: request.meta.requestId,
          approvalId,
          decision: request.input.decision,
          responseText: normalizeText(request.input.responseText) ?? null,
          checklistSnapshotId: staged.mission.currentChecklistSnapshotId,
          checklistSnapshotVersion: staged.mission.currentChecklistSnapshotVersion,
          checklistHash: staged.checklistSnapshot?.hash ?? null,
          ...buildActorMetadata(request.input.actor),
        },
      }));
      return withMeta(request.meta, this.buildMissionDetailView(staged.mission));
    }

    if (canSubmitPausedMissionApproval(mission)) {
      const queued = createMissionResumeSnapshot(mission, {
        at,
        reason: normalizeText(request.input.reason)
          ?? (request.input.decision === 'reject'
            ? 'Mission queued after human rejection.'
            : 'Mission queued after human approval.'),
        responseText: buildMissionApprovalResponseText({
          decision: request.input.decision,
          pendingApproval,
          responseText: request.input.responseText,
        }),
      });
      this.repository.saveMission(queued);
      this.repository.appendEvent(this.createMissionEvent({
        mission: queued,
        attemptId: null,
        kind: 'mission.queued',
        summary: request.input.decision === 'reject'
          ? 'Mission queued after the host rejected the pending request.'
          : 'Mission queued after the host approved the pending request.',
        metadata: {
          requestId: request.meta.requestId,
          approvalId,
          decision: request.input.decision,
          responseText: normalizeText(request.input.responseText) ?? null,
          pendingApprovalKind: pendingApproval?.kind ?? null,
          pendingApprovalSummary: pendingApproval?.summary ?? null,
          ...buildActorMetadata(request.input.actor),
        },
      }));
      return withMeta(request.meta, this.buildMissionDetailView(queued));
    }

    return withMeta(request.meta, this.buildMissionDetailView(mission));
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

  private handleProposePlanChange(
    request: MissionControlRequest<ProposePlanChangeInput>,
  ): MissionControlResponse<MissionDetailView> {
    const mission = this.requireMission(request.input.missionId);
    if (!canProposePlanChange(mission)) {
      throw new Error(`Mission plan changes can only be proposed from active execution states: ${mission.id}`);
    }
    const existingProposed = getProposedPlanChangeRequests(this.repository, mission.id);
    const proposedChange = resolvePlanChangeProposal(mission, request.input);
    if (existingProposed.length > 0) {
      if (isEquivalentPlanChangeRequest(existingProposed[0], proposedChange)) {
        return withMeta(request.meta, this.buildMissionDetailView(mission));
      }
      throw new Error(`Mission already has a pending plan change request: ${mission.id}`);
    }

    const at = this.now();
    const changeRequest = {
      id: this.generateId(),
      missionId: mission.id,
      generationId: mission.activeGenerationId,
      checklistSnapshotId: mission.currentChecklistSnapshotId,
      status: 'proposed' as const,
      rationale: proposedChange.rationale,
      proposedExpectedOutput: proposedChange.proposedExpectedOutput,
      proposedAcceptanceCriteria: [...proposedChange.proposedAcceptanceCriteria],
      proposedPlan: [...proposedChange.proposedPlan],
      createdAt: at,
      decidedAt: null,
      decidedBy: null,
    };
    const pendingMission = enterScopeChangePending(mission, {
      at,
      requestId: changeRequest.id,
      rationale: changeRequest.rationale,
    });
    this.repository.savePlanChangeRequest(changeRequest);
    this.repository.saveMission(pendingMission);
    this.repository.appendEvent(this.createMissionEvent({
      mission: pendingMission,
      attemptId: pendingMission.activeAttemptId,
      kind: 'mission.scope_change_pending',
      summary: 'Mission is waiting for a scope change decision before continuing.',
      metadata: {
        planChangeRequestId: changeRequest.id,
        rationale: changeRequest.rationale,
        proposedExpectedOutput: changeRequest.proposedExpectedOutput,
        proposedAcceptanceCriteria: [...changeRequest.proposedAcceptanceCriteria],
        proposedPlan: [...changeRequest.proposedPlan],
        ...buildActorMetadata(request.input.actor),
      },
    }));
    return withMeta(request.meta, this.buildMissionDetailView(pendingMission));
  }

  private handleResolvePlanChange(
    request: MissionControlRequest<ResolvePlanChangeInput>,
  ): MissionControlResponse<MissionDetailView> {
    const mission = this.requireMission(request.input.missionId);
    const changeRequest = resolvePendingPlanChangeRequest(
      this.repository,
      mission.id,
      request.input.planChangeRequestId ?? null,
    );
    if (!changeRequest) {
      return withMeta(request.meta, this.buildMissionDetailView(mission));
    }

    const at = this.now();
    const actorId = request.input.actor?.actorId ?? request.input.actor?.actorType ?? null;
    const resolutionReason = normalizeText(request.input.reason);

    if (request.input.decision === 'approve') {
      const currentSnapshot = this.repository.getChecklistSnapshotById(mission.currentChecklistSnapshotId);
      const proposedExpectedOutput = normalizeText(changeRequest.proposedExpectedOutput) ?? mission.expectedOutput;
      const proposedAcceptanceCriteria = normalizeStringList(changeRequest.proposedAcceptanceCriteria);
      const proposedPlan = normalizeStringList(changeRequest.proposedPlan);
      const checklistChanged = proposedExpectedOutput !== mission.expectedOutput
        || !isSameStringList(proposedAcceptanceCriteria, mission.acceptanceCriteria)
        || !isSameStringList(proposedPlan, mission.plan);
      const appliedMissionBase = transitionMission(mission, 'queued', {
        at,
        reason: resolutionReason ?? 'Mission queued after scope change approval.',
        pendingApproval: null,
        activeAttemptId: null,
        lastError: null,
        workpad: {
          ...mission.workpad,
          summary: 'Mission queued after applying the approved scope change.',
          latestPlan: [...proposedPlan],
          latestBlocker: null,
          latestVerifierSummary: null,
          updatedAt: at,
        },
      });
      const appliedMission = checklistChanged
        ? {
          ...appliedMissionBase,
          expectedOutput: proposedExpectedOutput,
          acceptanceCriteria: [...proposedAcceptanceCriteria],
          plan: [...proposedPlan],
          currentChecklistSnapshotVersion: mission.currentChecklistSnapshotVersion + 1,
          currentChecklistSnapshotId: buildChecklistSnapshotId(
            mission.id,
            mission.currentChecklistSnapshotVersion + 1,
          ),
          updatedAt: at,
        }
        : appliedMissionBase;

      const appliedChangeRequest = {
        ...changeRequest,
        status: 'applied' as const,
        decidedAt: at,
        decidedBy: actorId,
      };
      this.repository.savePlanChangeRequest(appliedChangeRequest);

      let appliedChecklistSnapshot = currentSnapshot;
      if (checklistChanged) {
        const nextChecklistSnapshot = createMissionChecklistSnapshot(appliedMission, {
          at,
          version: appliedMission.currentChecklistSnapshotVersion,
          generationId: appliedMission.activeGenerationId,
          sourceRevision: currentSnapshot?.sourceRevision ?? null,
        });
        appliedMission.currentChecklistSnapshotId = nextChecklistSnapshot.id;
        appliedChecklistSnapshot = nextChecklistSnapshot;
        if (currentSnapshot && currentSnapshot.id !== nextChecklistSnapshot.id) {
          this.repository.saveChecklistSnapshot({
            ...currentSnapshot,
            supersededAt: at,
            updatedAt: at,
          });
        }
        const generation = this.repository.getGenerationById(appliedMission.activeGenerationId);
        if (generation) {
          this.repository.saveGeneration({
            ...generation,
            checklistSnapshotId: nextChecklistSnapshot.id,
            updatedAt: at,
          });
        } else {
          this.repository.saveGeneration(createMissionGeneration(appliedMission, {
            at,
            id: appliedMission.activeGenerationId,
            index: appliedMission.activeGenerationIndex,
            trigger: appliedMission.activeGenerationIndex === 1 ? 'initial' : 'retry',
            checklistSnapshotId: nextChecklistSnapshot.id,
            status: mapMissionStatusToGenerationStatus(appliedMission.status),
          }));
        }
        this.repository.saveChecklistSnapshot(nextChecklistSnapshot);
      }

      this.repository.saveMission(appliedMission);
      this.repository.appendEvent(this.createMissionEvent({
        mission: appliedMission,
        attemptId: null,
        kind: 'mission.plan_change_applied',
        summary: resolutionReason ?? 'Approved scope change applied; mission re-queued.',
        metadata: {
          planChangeRequestId: appliedChangeRequest.id,
          checklistSnapshotId: appliedChecklistSnapshot?.id ?? appliedMission.currentChecklistSnapshotId,
          checklistSnapshotVersion: appliedChecklistSnapshot?.version ?? appliedMission.currentChecklistSnapshotVersion,
          checklistHash: appliedChecklistSnapshot?.hash ?? null,
          ...buildActorMetadata(request.input.actor),
        },
      }));
      return withMeta(request.meta, this.buildMissionDetailView(appliedMission));
    }

    const rejectedChangeRequest = {
      ...changeRequest,
      status: 'rejected' as const,
      decidedAt: at,
      decidedBy: actorId,
    };
    const resumedMission = transitionMission(mission, 'queued', {
      at,
      reason: resolutionReason ?? 'Mission queued after rejecting the proposed scope change.',
      pendingApproval: null,
      activeAttemptId: null,
      lastError: null,
      workpad: {
        ...mission.workpad,
        summary: 'Mission queued after rejecting the proposed scope change.',
        latestPlan: [...mission.plan],
        latestBlocker: null,
        latestVerifierSummary: null,
        updatedAt: at,
      },
    });
    this.repository.savePlanChangeRequest(rejectedChangeRequest);
    this.repository.saveMission(resumedMission);
    this.repository.appendEvent(this.createMissionEvent({
      mission: resumedMission,
      attemptId: null,
      kind: 'mission.plan_change_rejected',
      summary: resolutionReason ?? 'Rejected the proposed scope change; mission re-queued with the current checklist.',
      metadata: {
        planChangeRequestId: rejectedChangeRequest.id,
        ...buildActorMetadata(request.input.actor),
      },
    }));
    return withMeta(request.meta, this.buildMissionDetailView(resumedMission));
  }

  private handleResumeMission(
    request: MissionControlRequest<ResumeMissionInput>,
  ): MissionControlResponse<MissionDetailView> {
    const mission = this.requireMission(request.input.missionId);
    const resumed = createMissionResumeSnapshot(mission, {
      at: this.now(),
      reason: request.input.reason,
      responseText: request.input.responseText,
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
      || mission.status === 'max_loops_reached'
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

  private async *handleStreamMissionSnapshots(
    request: MissionControlRequest<GetMissionLoopSnapshotInput>,
  ): AsyncIterable<MissionControlResponse<MissionLoopSnapshotView>> {
    const mission = this.repository.getMissionById(request.input.missionId);
    if (!mission) {
      return;
    }
    yield withMeta(request.meta, this.buildMissionLoopSnapshotView(mission));
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
      loopSnapshot: this.buildMissionLoopSnapshotView(mission, checklistSnapshot),
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
      environmentStamps: listEnvironmentStamps(this.repository, mission.id),
      checkpoints: listCheckpoints(this.repository, mission.id),
    };
  }

  private buildMissionExecutionView(mission: Mission): MissionExecutionView {
    const events = this.repository.listEvents(mission.id);
    const workflow = this.resolveMissionWorkflow(mission);
    const checklistSnapshot = this.repository.getChecklistSnapshotById(mission.currentChecklistSnapshotId);
    const attempts = sortAttempts(this.repository.listAttempts(mission.id));
    const environmentStamps = listEnvironmentStamps(this.repository, mission.id);
    const checkpoints = listCheckpoints(this.repository, mission.id);
    return {
      missionId: mission.id,
      stopRequest: cloneStopRequest(mission.stopRequest),
      pendingApproval: clonePendingApproval(mission.pendingApproval),
      latestCycleResult: getLatestMissionCycleResult(events),
      latestEnvironmentStamp: environmentStamps.at(-1) ?? null,
      latestCheckpoint: checkpoints.at(-1) ?? null,
      loopSnapshot: this.buildMissionLoopSnapshotView(mission, checklistSnapshot),
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

  private buildMissionLoopSnapshotView(
    mission: Mission,
    checklistSnapshot = this.repository.getChecklistSnapshotById(mission.currentChecklistSnapshotId),
  ): MissionLoopSnapshotView {
    const supervisionSnapshot = createMissionSupervisionSnapshot(this.repository, mission, this.now());
    const checklistStatus = buildMissionChecklistStatusView(mission, checklistSnapshot);
    const latestCycleResult = supervisionSnapshot.latestCycleResult;
    const currentItem = resolveChecklistItemForLoopSnapshot(checklistSnapshot, latestCycleResult, checklistStatus);
    return {
      missionId: mission.id,
      status: mission.status,
      loopStatus: latestCycleResult?.status ?? null,
      currentCycle: latestCycleResult?.cycle ?? mission.attemptCount,
      currentStage: latestCycleResult?.stage ?? null,
      currentProgress: latestCycleResult?.progress ?? supervisionSnapshot.summary,
      currentItemId: latestCycleResult?.activeItemId ?? currentItem?.id ?? null,
      currentItemTitle: currentItem?.title ?? null,
      currentItemStatus: latestCycleResult?.activeItemStatus ?? currentItem?.status ?? null,
      checklistVersion: latestCycleResult?.checklistVersion ?? checklistStatus.checklistSnapshotVersion,
      overallCompletion: latestCycleResult?.overallCompletion ?? checklistStatus.overallCompletion,
      nextStep: latestCycleResult?.nextStep ?? null,
      latestBlocker: supervisionSnapshot.latestBlocker,
      latestVerifierSummary: supervisionSnapshot.latestVerifierSummary,
      finalResultSummary: supervisionSnapshot.finalResultSummary,
      pendingApproval: clonePendingApproval(supervisionSnapshot.pendingApproval),
      stopRequest: cloneStopRequest(supervisionSnapshot.stopRequest),
      resumable: supervisionSnapshot.resumable,
      supervisable: supervisionSnapshot.supervisable,
      lastEventAt: supervisionSnapshot.lastEventAt,
      updatedAt: supervisionSnapshot.updatedAt,
    };
  }

  private resolveMissionWorkflow(mission: Mission): {
    loadedWorkflow: LoadedMissionWorkflow | null;
    view: MissionSummaryView['workflow'];
  } {
    const workflowSelection = this.workflowResolver.resolve(mission);
    const result = this.workflowLoader.tryLoad({
      cwd: mission.cwd,
      workspacePath: mission.workspacePath,
      explicitPath: workflowSelection.explicitPath ?? undefined,
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
    const workflowPath = result.error.workflowPath ?? workflowSelection.workflowPath ?? mission.workflowPath ?? null;
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
    const activeGeneration = this.repository.getGenerationById(mission.activeGenerationId);
    const activeAttempt = mission.activeAttemptId
      ? attempts.find((attempt) => attempt.id === mission.activeAttemptId) ?? null
      : null;
    const latestAttempt = activeAttempt ?? attempts[attempts.length - 1] ?? null;
    const workflowTrace = {
      workflowPath: latestAttempt?.workflowPath
        ?? activeGeneration?.workflowPath
        ?? mission.workflowPath
        ?? null,
      workflowHash: latestAttempt?.workflowHash
        ?? activeGeneration?.workflowHash
        ?? mission.workflowHash
        ?? null,
      resolverReason: latestAttempt?.resolverReason
        ?? activeGeneration?.resolverReason
        ?? mission.workflowResolverReason
        ?? null,
    };
    return {
      activeAttemptId: mission.activeAttemptId,
      providerRunId: latestAttempt?.providerRunId ?? null,
      providerThreadId: latestAttempt?.providerThreadId ?? null,
      workflowPath: workflowTrace.workflowPath,
      workflowHash: workflowTrace.workflowHash,
      resolverReason: workflowTrace.resolverReason,
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
      ...listEnvironmentStamps(this.repository, missionId).map((environmentStamp) => ({
        type: 'environment_stamp' as const,
        createdAt: environmentStamp.capturedAt,
        environmentStamp,
      })),
      ...listCheckpoints(this.repository, missionId).map((checkpoint) => ({
        type: 'checkpoint' as const,
        createdAt: checkpoint.createdAt,
        checkpoint,
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

function listEnvironmentStamps(
  repository: MissionRepository,
  missionId: string,
): MissionEnvironmentStamp[] {
  return repository
    .listEnvironmentStamps(missionId)
    .slice()
    .sort((left, right) => {
      if (left.capturedAt !== right.capturedAt) {
        return left.capturedAt - right.capturedAt;
      }
      return left.id.localeCompare(right.id);
    })
    .map((stamp) => cloneValue(stamp));
}

function listCheckpoints(
  repository: MissionRepository,
  missionId: string,
): MissionCheckpoint[] {
  return repository
    .listCheckpoints(missionId)
    .slice()
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt - right.createdAt;
      }
      return left.id.localeCompare(right.id);
    })
    .map((checkpoint) => cloneValue(checkpoint));
}

function buildMissionChecklistStatusView(
  mission: Mission,
  checklistSnapshot: ChecklistSnapshot | null,
): MissionSummaryView['checklistStatus'] {
  const progress = summarizeChecklistSnapshotProgress(checklistSnapshot);
  const progressItems = checklistSnapshot?.items.some((item) => item.kind === 'plan')
    ? checklistSnapshot.items.filter((item) => item.kind === 'plan' && item.status !== 'skipped')
    : checklistSnapshot?.items.filter((item) => item.status !== 'skipped') ?? [];
  const currentItem = getActiveFormalChecklistItem(checklistSnapshot);
  return {
    generationId: mission.activeGenerationId,
    generationIndex: mission.activeGenerationIndex,
    checklistSnapshotId: checklistSnapshot?.id ?? mission.currentChecklistSnapshotId ?? null,
    checklistSnapshotVersion: checklistSnapshot?.version ?? mission.currentChecklistSnapshotVersion ?? null,
    sourceRevision: checklistSnapshot?.sourceRevision ?? null,
    totalItems: progress.totalItemCount,
    completedItems: progress.completedItemCount,
    blockedItems: progressItems.filter((item) => item.status === 'blocked').length,
    overallCompletion: progress.overallCompletion,
    currentItem: currentItem ? { ...currentItem } : null,
  };
}

function resolveChecklistItemForLoopSnapshot(
  checklistSnapshot: ChecklistSnapshot | null,
  latestCycleResult: MissionSummaryView['latestCycleResult'],
  checklistStatus: MissionSummaryView['checklistStatus'],
) {
  const activeItemId = latestCycleResult?.activeItemId ?? checklistStatus.currentItem?.id ?? null;
  if (!activeItemId) {
    return checklistStatus.currentItem;
  }
  return checklistSnapshot?.items.find((item) => item.id === activeItemId) ?? checklistStatus.currentItem;
}

function buildActorMetadata(
  actor:
    | CreateMissionCommandInput['actor']
    | StartMissionInput['actor']
    | SyncMissionSourceInput['actor']
    | ProposePlanChangeInput['actor']
    | ResolvePlanChangeInput['actor']
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

function cloneValue<T>(value: T): T {
  return structuredClone(value);
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
    (
      mission.status === 'draft'
      || mission.status === 'awaiting_checklist_confirm'
      || mission.status === 'awaiting_prompt_confirm'
      || mission.status === 'queued'
    )
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
    && mission.status !== 'awaiting_checklist_confirm'
    && mission.status !== 'awaiting_prompt_confirm'
    && mission.status !== 'running'
    && mission.status !== 'verifying'
    && mission.status !== 'repairing'
    && mission.status !== 'completed'
    && mission.status !== 'max_loops_reached'
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
      case 'environment_stamp':
        return 4;
      case 'checkpoint':
        return 5;
      case 'event':
        return 6;
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

function advanceMissionStartGate(
  repository: MissionRepository,
  mission: Mission,
  options: {
    at: number;
    requestId: string;
    confirmChecklist: boolean;
    confirmPrompt: boolean;
  },
): {
  mission: Mission;
  checklistSnapshot: ChecklistSnapshot | null;
  eventKind: MissionEvent['kind'];
  summary: string;
} {
  if (
    mission.status === 'queued'
    || mission.status === 'planning'
    || mission.status === 'running'
    || mission.status === 'verifying'
    || mission.status === 'repairing'
    || mission.status === 'waiting_user'
    || mission.status === 'needs_human'
    || mission.status === 'scope_change_pending'
    || mission.status === 'handoff'
    || mission.status === 'blocked'
    || mission.status === 'max_loops_reached'
    || mission.status === 'completed'
    || mission.status === 'failed'
    || mission.status === 'stopped'
    || mission.status === 'archived'
  ) {
    return {
      mission,
      checklistSnapshot: repository.getChecklistSnapshotById(mission.currentChecklistSnapshotId),
      eventKind: 'mission.queued',
      summary: mission.statusReason ?? 'Mission start gate already resolved.',
    };
  }

  const checklistSnapshot = repository.getChecklistSnapshotById(mission.currentChecklistSnapshotId);
  const hasChecklist = Boolean(checklistSnapshot && checklistSnapshot.items.length > 0);
  const checklistConfirmed = !hasChecklist
    || mission.status === 'awaiting_prompt_confirm'
    || options.confirmChecklist;

  if (!checklistConfirmed) {
    return {
      mission: transitionMission(mission, 'awaiting_checklist_confirm', {
        at: options.at,
        reason: 'Waiting for the initial checklist snapshot to be confirmed before the first autonomous cycle.',
        pendingApproval: buildChecklistConfirmationApproval(options.requestId, options.at),
      }),
      checklistSnapshot,
      eventKind: 'mission.awaiting_checklist_confirm',
      summary: 'Waiting for checklist confirmation before the first autonomous cycle.',
    };
  }

  if (!options.confirmPrompt) {
    const awaitingPrompt = mission.status === 'awaiting_prompt_confirm'
      ? {
        ...mission,
        statusReason: 'Waiting for the immutable prompt to be confirmed before the first autonomous cycle.',
        pendingApproval: buildPromptConfirmationApproval(options.requestId, options.at),
        updatedAt: options.at,
      }
      : transitionMission(mission, 'awaiting_prompt_confirm', {
        at: options.at,
        reason: 'Waiting for the immutable prompt to be confirmed before the first autonomous cycle.',
        pendingApproval: buildPromptConfirmationApproval(options.requestId, options.at),
      });
    return {
      mission: awaitingPrompt,
      checklistSnapshot,
      eventKind: 'mission.awaiting_prompt_confirm',
      summary: 'Waiting for immutable prompt confirmation before the first autonomous cycle.',
    };
  }

  return {
    mission: transitionMission(mission, 'queued', {
      at: options.at,
      reason: 'Mission queued after checklist and immutable prompt confirmation.',
      pendingApproval: null,
    }),
    checklistSnapshot,
    eventKind: 'mission.queued',
    summary: 'Mission queued after checklist and immutable prompt confirmation.',
  };
}

function buildChecklistConfirmationApproval(
  requestId: string,
  at: number,
): MissionPendingApproval {
  return {
    requestId,
    kind: 'workflow',
    summary: 'Confirm the initial checklist snapshot before the first autonomous cycle.',
    options: [
      {
        index: 1,
        label: 'Confirm checklist',
        description: 'Approve the initial checklist snapshot for autonomous execution.',
      },
    ],
    createdAt: at,
  };
}

function buildPromptConfirmationApproval(
  requestId: string,
  at: number,
): MissionPendingApproval {
  return {
    requestId,
    kind: 'workflow',
    summary: 'Confirm the immutable prompt before the first autonomous cycle.',
    options: [
      {
        index: 1,
        label: 'Confirm prompt',
        description: 'Approve the immutable prompt that will be used for autonomous execution.',
      },
    ],
    createdAt: at,
  };
}

function canProposePlanChange(mission: Mission): boolean {
  return mission.status === 'running'
    || mission.status === 'verifying'
    || mission.status === 'repairing'
    || mission.status === 'scope_change_pending';
}

function getProposedPlanChangeRequests(
  repository: MissionRepository,
  missionId: string,
) {
  return repository
    .listPlanChangeRequests(missionId)
    .filter((changeRequest) => changeRequest.status === 'proposed')
    .sort((left, right) => left.createdAt - right.createdAt);
}

function resolvePendingPlanChangeRequest(
  repository: MissionRepository,
  missionId: string,
  planChangeRequestId: string | null,
) {
  const proposed = getProposedPlanChangeRequests(repository, missionId);
  if (proposed.length === 0) {
    return null;
  }
  if (!planChangeRequestId) {
    return proposed[proposed.length - 1] ?? null;
  }
  return proposed.find((changeRequest) => changeRequest.id === planChangeRequestId) ?? null;
}

function resolvePlanChangeProposal(
  mission: Mission,
  input: ProposePlanChangeInput,
): {
  rationale: string;
  proposedExpectedOutput: string | null;
  proposedAcceptanceCriteria: string[];
  proposedPlan: string[];
} {
  return {
    rationale: normalizeText(input.rationale) ?? 'Adjust the mission checklist before continuing.',
    proposedExpectedOutput: normalizeText(input.proposedExpectedOutput) ?? mission.expectedOutput,
    proposedAcceptanceCriteria: input.proposedAcceptanceCriteria === undefined || input.proposedAcceptanceCriteria === null
      ? [...mission.acceptanceCriteria]
      : normalizeStringList(input.proposedAcceptanceCriteria),
    proposedPlan: input.proposedPlan === undefined || input.proposedPlan === null
      ? [...mission.plan]
      : normalizeStringList(input.proposedPlan),
  };
}

function isEquivalentPlanChangeRequest(
  changeRequest: MissionDetailView['planChangeRequests'][number],
  proposed: ReturnType<typeof resolvePlanChangeProposal>,
): boolean {
  return changeRequest.rationale === proposed.rationale
    && (normalizeText(changeRequest.proposedExpectedOutput) ?? null) === proposed.proposedExpectedOutput
    && isSameStringList(changeRequest.proposedAcceptanceCriteria, proposed.proposedAcceptanceCriteria)
    && isSameStringList(changeRequest.proposedPlan, proposed.proposedPlan);
}

function enterScopeChangePending(
  mission: Mission,
  options: {
    at: number;
    requestId: string;
    rationale: string;
  },
): Mission {
  const blocker = 'Resolve the proposed checklist scope change before continuing the mission.';
  const pendingApproval = buildPlanChangeApproval(options.requestId, options.at);
  if (mission.status === 'scope_change_pending') {
    return {
      ...mission,
      pendingApproval,
      statusReason: blocker,
      lastError: blocker,
      updatedAt: options.at,
      workpad: {
        ...mission.workpad,
        summary: 'Mission paused pending scope change confirmation.',
        latestBlocker: blocker,
        latestVerifierSummary: options.rationale,
        updatedAt: options.at,
      },
    };
  }
  return transitionMission(mission, 'scope_change_pending', {
    at: options.at,
    reason: blocker,
    pendingApproval,
    lastError: blocker,
    workpad: {
      ...mission.workpad,
      summary: 'Mission paused pending scope change confirmation.',
      latestBlocker: blocker,
      latestVerifierSummary: options.rationale,
      updatedAt: options.at,
    },
  });
}

function buildPlanChangeApproval(
  requestId: string,
  at: number,
): MissionPendingApproval {
  return {
    requestId,
    kind: 'workflow',
    summary: 'Resolve the proposed checklist scope change before continuing autonomous execution.',
    options: [
      {
        index: 1,
        label: 'Approve scope change',
        description: 'Apply the proposed checklist scope change and continue the mission.',
      },
      {
        index: 2,
        label: 'Keep current checklist',
        description: 'Reject the proposed scope change and continue with the current checklist.',
      },
    ],
    createdAt: at,
  };
}

function canSubmitPausedMissionApproval(mission: Mission): boolean {
  return mission.status === 'waiting_user'
    || mission.status === 'needs_human'
    || mission.status === 'handoff'
    || mission.status === 'blocked';
}

function buildMissionApprovalResponseText(input: {
  decision: SubmitApprovalInput['decision'];
  pendingApproval: MissionPendingApproval | null;
  responseText: string | null | undefined;
}): string {
  const lines = [
    input.decision === 'reject'
      ? 'Human rejected the pending request.'
      : 'Human approved the pending request.',
  ];
  const summary = normalizeText(input.pendingApproval?.summary);
  if (summary) {
    lines.push(`Pending request: ${summary}`);
  }
  const responseText = normalizeText(input.responseText);
  if (responseText) {
    lines.push(`Human input: ${responseText}`);
  }
  return lines.join(' ').trim();
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

function isSameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}
