import type {
  ChecklistSnapshot,
  Mission,
  MissionAttempt,
  MissionEvent,
  MissionGeneration,
  MissionPendingApproval,
  MissionSource,
  MissionStatus,
  PlanChangeRequest,
  WorkItem,
} from './types.js';

export interface MissionControlBoundaryMetadata {
  requestId: string;
  correlationId: string | null;
  idempotencyKey: string | null;
}

export interface MissionControlRequest<TInput> {
  meta: MissionControlBoundaryMetadata;
  input: TInput;
}

export interface MissionControlResponse<TData> {
  meta: MissionControlBoundaryMetadata;
  data: TData;
}

export interface MissionControlActor {
  actorId: string | null;
  actorType: 'user' | 'host' | 'system';
}

export interface MissionSummaryFilter {
  platform?: string | null;
  externalScopeId?: string | null;
  providerProfileId?: string | null;
  statuses?: MissionStatus[] | null;
  sources?: MissionSource[] | null;
}

export interface MissionHostBindingView {
  platform: string;
  externalScopeId: string;
  source: MissionSource;
  sourceRef: string | null;
  providerProfileId: string;
  bridgeSessionId: string | null;
  codexThreadId: string | null;
}

export interface MissionArtifactRefView {
  type: string;
  path: string | null;
  name: string | null;
  mimeType: string | null;
  caption: string | null;
}

export interface MissionExecutionRefsView {
  activeAttemptId: string | null;
  providerRunId: string | null;
  providerThreadId: string | null;
  workflowPath: string | null;
  workspacePath: string | null;
}

export interface MissionSummaryView {
  workItem: WorkItem | null;
  mission: Mission;
  summary: string | null;
  latestBlocker: string | null;
  latestVerifierSummary: string | null;
  finalResultSummary: string | null;
  lastResultPreview: string | null;
  lastError: string | null;
  pendingApproval: MissionPendingApproval | null;
  hostBindings: MissionHostBindingView;
  executionRefs: MissionExecutionRefsView;
  artifactRefs: MissionArtifactRefView[];
}

export interface MissionDetailView extends MissionSummaryView {
  activeGeneration: MissionGeneration | null;
  currentChecklistSnapshot: ChecklistSnapshot | null;
  planChangeRequests: PlanChangeRequest[];
  attempts: MissionAttempt[];
}

export type MissionTimelineEntry =
  | {
    type: 'generation';
    createdAt: number;
    generation: MissionGeneration;
  }
  | {
    type: 'checklist_snapshot';
    createdAt: number;
    checklistSnapshot: ChecklistSnapshot;
  }
  | {
    type: 'plan_change_request';
    createdAt: number;
    planChangeRequest: PlanChangeRequest;
  }
  | {
    type: 'attempt';
    createdAt: number;
    attempt: MissionAttempt;
  }
  | {
    type: 'event';
    createdAt: number;
    event: MissionEvent;
  };

export interface MissionTimelineView {
  missionId: string;
  entries: MissionTimelineEntry[];
}

export interface MissionAttemptsView {
  missionId: string;
  attempts: MissionAttempt[];
}

export interface MissionExecutionView {
  missionId: string;
  pendingApproval: MissionPendingApproval | null;
  hostBindings: MissionHostBindingView;
  executionRefs: MissionExecutionRefsView;
  artifactRefs: MissionArtifactRefView[];
}

export interface ListMissionSummariesInput {
  filter?: MissionSummaryFilter | null;
}

export interface GetMissionDetailInput {
  missionId: string;
}

export interface GetMissionTimelineInput {
  missionId: string;
}

export interface GetMissionAttemptsInput {
  missionId: string;
}

export interface GetMissionExecutionInput {
  missionId: string;
}

export interface RetryMissionInput {
  missionId: string;
  reason?: string | null;
  bridgeSessionId?: string | null;
  codexThreadId?: string | null;
  workflowPath?: string | null;
  workspacePath?: string | null;
  actor?: MissionControlActor | null;
}

export interface ResumeMissionInput {
  missionId: string;
  reason?: string | null;
  actor?: MissionControlActor | null;
}

export interface StopMissionInput {
  missionId: string;
  reason?: string | null;
  actor?: MissionControlActor | null;
}

export interface StreamMissionInput {
  missionId: string;
  includeHistory?: boolean;
}

export type MissionStreamFrame =
  | {
    type: 'detail';
    detail: MissionDetailView;
  }
  | {
    type: 'timeline_entry';
    entry: MissionTimelineEntry;
  };

export interface MissionControlCommands {
  retryMission(
    request: MissionControlRequest<RetryMissionInput>,
  ): MissionControlResponse<MissionDetailView>;
  resumeMission(
    request: MissionControlRequest<ResumeMissionInput>,
  ): MissionControlResponse<MissionDetailView>;
  stopMission(
    request: MissionControlRequest<StopMissionInput>,
  ): MissionControlResponse<MissionDetailView>;
}

export interface MissionControlQueries {
  listMissionSummaries(
    request: MissionControlRequest<ListMissionSummariesInput>,
  ): MissionControlResponse<MissionSummaryView[]>;
  getMissionDetail(
    request: MissionControlRequest<GetMissionDetailInput>,
  ): MissionControlResponse<MissionDetailView | null>;
  getMissionTimeline(
    request: MissionControlRequest<GetMissionTimelineInput>,
  ): MissionControlResponse<MissionTimelineView | null>;
  getMissionAttempts(
    request: MissionControlRequest<GetMissionAttemptsInput>,
  ): MissionControlResponse<MissionAttemptsView | null>;
  getMissionExecution(
    request: MissionControlRequest<GetMissionExecutionInput>,
  ): MissionControlResponse<MissionExecutionView | null>;
}

export interface MissionControlStreams {
  streamMission(
    request: MissionControlRequest<StreamMissionInput>,
  ): AsyncIterable<MissionControlResponse<MissionStreamFrame>>;
}

export interface MissionControlApi {
  readonly commands: MissionControlCommands;
  readonly queries: MissionControlQueries;
  readonly streams: MissionControlStreams;
}
