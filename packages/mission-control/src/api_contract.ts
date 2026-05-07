import type {
  ChecklistItem,
  ChecklistSnapshot,
  Mission,
  MissionAttempt,
  MissionEvent,
  MissionGeneration,
  MissionLoopPolicy,
  MissionPendingApproval,
  MissionPriority,
  MissionRiskLevel,
  MissionSource,
  MissionStopRequest,
  MissionStatus,
  PlanChangeRequest,
  WorkItem,
} from './types.js';
import type { MissionCycleResult } from './cycle_result.js';
import type { WorkItemSourceSummary } from './source.js';
import type { MissionWorkpadStatusView } from './workpad_view.js';
import type { MissionWorkflowSource } from './workflow.js';

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
  hostSessionId: string | null;
  providerThreadId: string | null;
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

export interface MissionWorkflowStatusView {
  status: 'loaded' | 'invalid';
  source: MissionWorkflowSource;
  error: string | null;
}

export interface MissionChecklistStatusView {
  generationId: string;
  generationIndex: number;
  checklistSnapshotId: string | null;
  checklistSnapshotVersion: number | null;
  sourceRevision: string | null;
  totalItems: number;
  completedItems: number;
  blockedItems: number;
  overallCompletion: number | null;
  currentItem: ChecklistItem | null;
}

export interface MissionSummaryView {
  workItem: WorkItem | null;
  mission: Mission;
  summary: string | null;
  latestBlocker: string | null;
  latestVerifierSummary: string | null;
  latestCycleResult: MissionCycleResult | null;
  finalResultSummary: string | null;
  lastResultPreview: string | null;
  lastError: string | null;
  pendingApproval: MissionPendingApproval | null;
  hostBindings: MissionHostBindingView;
  executionRefs: MissionExecutionRefsView;
  workflow: MissionWorkflowStatusView;
  checklistStatus: MissionChecklistStatusView;
  workpadStatus: MissionWorkpadStatusView;
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
  stopRequest: MissionStopRequest | null;
  pendingApproval: MissionPendingApproval | null;
  latestCycleResult: MissionCycleResult | null;
  hostBindings: MissionHostBindingView;
  executionRefs: MissionExecutionRefsView;
  workflow: MissionWorkflowStatusView;
  checklistStatus: MissionChecklistStatusView;
  workpadStatus: MissionWorkpadStatusView;
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
  hostSessionId?: string | null;
  providerThreadId?: string | null;
  bridgeSessionId?: string | null;
  codexThreadId?: string | null;
  workflowPath?: string | null;
  workspacePath?: string | null;
  actor?: MissionControlActor | null;
}

export interface CreateMissionCommandInput {
  missionId: string;
  workItem: WorkItemSourceSummary;
  platform: string;
  externalScopeId: string;
  providerProfileId: string;
  loopPolicy?: Partial<MissionLoopPolicy> | null;
  priority?: MissionPriority;
  riskLevel?: MissionRiskLevel;
  cwd?: string | null;
  workspacePath?: string | null;
  workflowPath?: string | null;
  hostSessionId?: string | null;
  providerThreadId?: string | null;
  bridgeSessionId?: string | null;
  codexThreadId?: string | null;
  immutableGoal?: string | null;
  immutablePrompt?: string | null;
  maxAttempts?: number | null;
  maxTurns?: number | null;
  initialStatus?: 'draft' | 'queued';
  reason?: string | null;
  actor?: MissionControlActor | null;
}

export interface SyncMissionSourceInput {
  missionId: string;
  workItem: WorkItemSourceSummary;
  reason?: string | null;
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
  createMission(
    request: MissionControlRequest<CreateMissionCommandInput>,
  ): MissionControlResponse<MissionDetailView>;
  syncMissionSource(
    request: MissionControlRequest<SyncMissionSourceInput>,
  ): MissionControlResponse<MissionDetailView>;
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
