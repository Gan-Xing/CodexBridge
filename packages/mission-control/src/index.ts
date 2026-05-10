export const MISSION_CONTROL_PACKAGE_NAME = '@codexbridge/mission-control' as const;

export const MISSION_CONTROL_PACKAGE_PHASE = 'phase-9v-checklist-refinement-gates' as const;

export const MISSION_CONTROL_OWNS = [
  'mission-domain-model',
  'mission-state-machine',
  'workflow-loading',
  'workspace-coordination',
  'lease-coordination',
  'provider-abstraction',
  'run-verify-repair-retry-loop',
  'mission-persistence',
  'attempt-event-workpad-persistence',
  'mission-control-actions',
  'host-adapter-contract',
  'work-item-source-contract',
  'source-backed-mission-creation',
  'progress-sink-contract',
  'supervision-foundation',
  'persisted-stop-intents',
  'environment-stamp-checkpoint-persistence',
] as const;

export const MISSION_CONTROL_DOES_NOT_OWN = [
  'wechat-transport',
  'telegram-transport',
  'slash-commands',
  'i18n',
  'sendgate',
  'bridge-sessions',
  'thread-browsing',
  'provider-profile-cli-management',
  'assistant-records',
  'uploads',
  'artifact-delivery-policy',
] as const;

export type MissionControlOwnedResponsibility = typeof MISSION_CONTROL_OWNS[number];

export type MissionControlExcludedResponsibility =
  typeof MISSION_CONTROL_DOES_NOT_OWN[number];

export { DirectMissionControlApi } from './api.js';
export type { DirectMissionControlApiOptions } from './api.js';
export {
  createMissionRetrySnapshot,
  createMissionResumeSnapshot,
  createMissionStopRequest,
  materializeMissionStop,
  resolveMissionStopReason,
  shouldMissionRetryReuseAccumulatedContext,
  canMissionRequestStop,
  shouldMissionStopImmediately,
} from './control_actions.js';
export type {
  CreateMissionResumeSnapshotOptions,
  CreateMissionRetrySnapshotOptions,
  CreateMissionStopRequestOptions,
  MaterializeMissionStopOptions,
} from './control_actions.js';
export {
  CodexMissionProvider,
  normalizeCodexMissionDriverResult,
  toCodexMissionDriverExecutionInput,
} from './codex_provider.js';
export type {
  CodexMissionDriver,
  CodexMissionDriverExecutionInput,
  CodexMissionDriverStartResult,
  CodexMissionDriverWaitResult,
} from './codex_provider.js';
export {
  MISSION_CYCLE_RESULT_SCHEMA_VERSION,
  applyMissionVerifierResultToChecklistSnapshot,
  completeChecklistSnapshot,
  createMissionCycleResult,
  getActiveChecklistItem,
  getActiveFormalChecklistItem,
  getChecklistProgressItems,
  getLatestMissionCycleResult,
  listMissionCycleResults,
  mapMissionStatusToMissionControlOutcome,
  readMissionCycleResult,
  summarizeChecklistSnapshotProgress,
} from './cycle_result.js';
export type {
  ApplyMissionChecklistResultOptions,
  ChecklistItemSelectorOptions,
  ChecklistProgressSummary,
  CreateMissionCycleResultInput,
  MissionControlOutcome,
  MissionCycleAudit,
  MissionCycleResult,
} from './cycle_result.js';
export {
  buildChecklistSnapshotId,
  buildDefaultImmutablePrompt,
  buildMissionGenerationId,
  buildMissionWorkItemId,
  createMissionChecklistSnapshot,
  createMissionGeneration,
  createMissionRetryAggregate,
  createMissionWorkItem,
  hashChecklistSnapshot,
  mapMissionStatusToGenerationStatus,
  normalizeMissionLoopPolicy,
  normalizeMissionRecord,
  normalizeWorkflowHash,
  normalizeWorkflowResolverReason,
} from './domain_records.js';
export {
  createNoopMissionHostAdapter,
} from './host_adapter.js';
export type {
  MissionHostAdapter,
  MissionHostApprovalRequest,
  MissionHostArtifactPublication,
  MissionHostContext,
  MissionHostNotification,
  MissionHostProgressUpdate,
  MissionHostThreadBinding,
} from './host_adapter.js';
export { InMemoryMissionRepository } from './in_memory_mission_repository.js';
export { JsonFileMissionRepository } from './json_file_mission_repository.js';
export {
  MissionConcurrentLimitError,
  MissionLeaseConflictError,
  MissionLeaseCoordinator,
} from './lease_coordinator.js';
export type { MissionLeaseCoordinatorOptions } from './lease_coordinator.js';
export {
  applyMissionProviderStartToAttempt,
  canScheduleMissionContinuation,
  mapMissionProviderResultToMissionStatus,
} from './provider.js';
export type {
  MissionExecutionInput,
  MissionProvider,
  MissionProviderArtifact,
  MissionProviderArtifactType,
  MissionProviderHandoffState,
  MissionProviderOutcome,
  MissionProviderResult,
  MissionProviderStartResult,
} from './provider.js';
export {
  createMissionAttemptPromptContract,
  renderMissionAttemptPromptContract,
} from './prompt_contract.js';
export type {
  CreateMissionAttemptPromptContractInput,
  MissionAttemptPromptContract,
  MissionPromptChecklistItem,
} from './prompt_contract.js';
export {
  RepositoryMissionProgressSink,
  applyMissionProgressUpdateToWorkpad,
  persistMissionProgressUpdate,
} from './progress.js';
export type {
  MissionProgressKind,
  MissionProgressSink,
  MissionProgressUpdate,
  PersistMissionProgressUpdateOptions,
} from './progress.js';
export type { MissionRepository } from './repository.js';
export { MissionRuntime } from './runtime.js';
export type {
  MissionRunOptions,
  MissionRunResult,
  MissionRuntimeOptions,
} from './runtime.js';
export {
  createManualWorkItemSourceSummary,
  createWorkItemSourceSummary,
  createWorkItemSourceSummaryFromWorkItem,
} from './source.js';
export type {
  WorkItemSourceAdapter,
  WorkItemSourceCreateInput,
  WorkItemSourceListInput,
  WorkItemSourceListResult,
  WorkItemSourceSummary,
  WorkItemSourceUpdateInput,
} from './source.js';
export {
  createMissionAggregateFromSourceSummary,
} from './source_mission.js';
export type {
  CreateMissionAggregateFromSourceSummaryInput,
  MissionAggregateFromSourceSummary,
} from './source_mission.js';
export {
  MISSION_STATUS_TRANSITIONS,
  assertMissionStatusTransition,
  canTransitionMissionStatus,
  createMission,
  createMissionWorkpad,
  isMissionResumable,
  transitionMission,
} from './state_machine.js';
export type { TransitionMissionOptions } from './state_machine.js';
export {
  MissionSupervisor,
  createMissionSupervisionSnapshot,
  didMissionSupervisionProgress,
  isMissionSupervisable,
} from './supervision.js';
export type {
  ListSupervisableMissionOptions,
  MissionSupervisionSnapshot,
  MissionSupervisorCycleRecord,
  MissionSupervisorOptions,
  MissionSupervisorRunOptions,
  MissionSupervisorRunReport,
  MissionSupervisorStopReason,
} from './supervision.js';
export type {
  ChecklistItem,
  ChecklistItemKind,
  ChecklistItemStatus,
  ChecklistSnapshot,
  CreateMissionInput,
  Mission,
  MissionAttempt,
  MissionAttemptStatus,
  MissionCheckpoint,
  MissionEnvironmentStamp,
  MissionEvent,
  MissionEventKind,
  MissionGeneration,
  MissionGenerationStatus,
  MissionGenerationTrigger,
  MissionLease,
  MissionLoopPolicy,
  MissionPendingApproval,
  MissionPendingApprovalOption,
  MissionPriority,
  MissionRiskLevel,
  MissionSource,
  MissionStatus,
  MissionStopRequest,
  MissionVerifierVerdict,
  MissionWorkflowResolverReason,
  MissionWorkpad,
  PlanChangeRequest,
  PlanChangeRequestStatus,
  WorkItem,
} from './types.js';
export {
  applyMissionVerifierResultToAttempt,
  applyMissionVerifierResultToMission,
  applyMissionVerifierResultToWorkpad,
  createMissionRepairPrompt,
  createMissionVerifierResult,
  evaluateMissionVerifierBudget,
  mapMissionVerifierVerdictToAttemptStatus,
  mapMissionVerifierVerdictToMissionStatus,
  normalizeMissionPlanChangeSuggestion,
  normalizeMissionVerifierVerdict,
  resolveMissionPlanChangeSuggestion,
  resolveMissionVerifierBudget,
} from './verifier.js';
export type {
  CreateMissionRepairPromptInput,
  CreateMissionVerifierResultInput,
  MissionPlanChangeSuggestion,
  MissionVerifier,
  MissionVerifierBudget,
  MissionVerifierBudgetUsage,
  MissionVerifierInput,
  MissionVerifierResult,
  ResolvedMissionPlanChangeSuggestion,
} from './verifier.js';
export {
  DEFAULT_MISSION_WORKFLOW_PROMPT_BODY,
  DEFAULT_MISSION_WORKFLOW_RELATIVE_PATH,
  MissionWorkflowError,
  MissionWorkflowLoader,
  hashMissionWorkflowText,
} from './workflow.js';
export type {
  LoadedMissionWorkflow,
  MissionWorkflowContinuationMode,
  MissionWorkflowDefaultHandoffState,
  MissionWorkflowFinalReportSection,
  MissionWorkflowLoadInput,
  MissionWorkflowLoaderOptions,
  MissionWorkflowPolicy,
  MissionWorkflowSource,
} from './workflow.js';
export {
  MissionWorkflowResolver,
} from './workflow_resolver.js';
export type {
  MissionWorkflowResolutionInput,
  MissionWorkflowResolverOptions,
  MissionWorkflowResolverRule,
  MissionWorkflowSelection,
} from './workflow_resolver.js';
export {
  createMissionWorkpadStatusView,
  renderMissionWorkpadStatusView,
} from './workpad_view.js';
export type {
  CreateMissionWorkpadStatusViewInput,
  MissionWorkpadStatusView,
} from './workpad_view.js';
export {
  MissionWorkspaceService,
  defaultMissionWorkspaceRoot,
} from './workspace.js';
export type {
  EnsureMissionWorkspaceOptions,
  MissionWorkspaceAssignment,
  MissionWorkspaceEnvironmentStamp,
  MissionWorkspaceLayout,
  MissionWorkspaceMode,
  MissionWorkspaceServiceOptions,
} from './workspace.js';
export type {
  CreateMissionCommandInput,
  GetMissionAttemptsInput,
  GetMissionDetailInput,
  GetMissionExecutionInput,
  GetMissionLoopSnapshotInput,
  GetMissionTimelineInput,
  ListMissionSummariesInput,
  MissionArtifactRefView,
  MissionAttemptsView,
  MissionControlBoundaryMetadata,
  MissionCheckpointView,
  MissionChecklistStatusView,
  MissionControlActor,
  MissionControlApi,
  MissionControlCommands,
  MissionControlQueries,
  MissionControlRequest,
  MissionControlResponse,
  MissionControlStreams,
  MissionDetailView,
  MissionEnvironmentStampView,
  MissionExecutionRefsView,
  MissionExecutionView,
  MissionHostBindingView,
  MissionLoopSnapshotView,
  MissionStreamFrame,
  MissionSummaryFilter,
  MissionSummaryView,
  MissionTimelineEntry,
  MissionTimelineView,
  MissionWorkflowStatusView,
  ProposePlanChangeInput,
  ResolvePlanChangeInput,
  ResumeMissionInput,
  RetryMissionInput,
  StartMissionInput,
  StopMissionInput,
  StreamMissionInput,
  SubmitApprovalInput,
  SyncMissionSourceInput,
} from './api_contract.js';
