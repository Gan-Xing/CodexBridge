export type MissionStatus =
  | 'draft'
  | 'queued'
  | 'planning'
  | 'running'
  | 'verifying'
  | 'repairing'
  | 'waiting_user'
  | 'needs_human'
  | 'handoff'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'archived';

export type MissionSource =
  | 'weixin'
  | 'telegram'
  | 'assistant-record'
  | 'github'
  | 'linear'
  | 'cli'
  | 'manual';

export type MissionPriority = 'low' | 'normal' | 'high';

export type MissionRiskLevel = 'low' | 'medium' | 'high';

export type MissionGenerationTrigger = 'initial' | 'retry' | 'resume';

export type MissionGenerationStatus =
  | 'active'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'blocked'
  | 'waiting_user'
  | 'needs_human'
  | 'handoff'
  | 'superseded';

export type ChecklistItemKind = 'deliverable' | 'acceptance' | 'plan';

export type ChecklistItemStatus = 'pending' | 'completed' | 'blocked' | 'skipped';

export type PlanChangeRequestStatus = 'proposed' | 'approved' | 'rejected' | 'applied';

export type MissionAttemptStatus =
  | 'queued'
  | 'running'
  | 'verifying'
  | 'repairing'
  | 'waiting_user'
  | 'needs_human'
  | 'handoff'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'stopped';

export type MissionVerifierVerdict =
  | 'complete'
  | 'repair'
  | 'blocked'
  | 'waiting_user'
  | 'needs_human'
  | 'handoff'
  | 'failed';

export type MissionEventKind =
  | 'mission.created'
  | 'mission.queued'
  | 'mission.planning'
  | 'mission.started'
  | 'mission.progress'
  | 'mission.verifying'
  | 'mission.retrying'
  | 'mission.waiting_user'
  | 'mission.needs_human'
  | 'mission.handoff'
  | 'mission.blocked'
  | 'mission.completed'
  | 'mission.failed'
  | 'mission.stopped'
  | 'mission.archived'
  | 'attempt.created'
  | 'attempt.started'
  | 'attempt.progress'
  | 'attempt.verifying'
  | 'attempt.completed'
  | 'attempt.failed'
  | 'attempt.stopped'
  | 'workpad.updated'
  | 'lease.acquired'
  | 'lease.heartbeat'
  | 'lease.released';

export interface MissionPendingApprovalOption {
  index: number;
  label: string;
  description?: string | null;
}

export interface MissionPendingApproval {
  requestId: string;
  kind: 'provider' | 'workflow' | 'manual';
  summary: string;
  options: MissionPendingApprovalOption[];
  createdAt: number;
}

export interface MissionLease {
  ownerId: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
  releasedAt: number | null;
}

export interface MissionWorkpad {
  summary: string | null;
  latestPlan: string[];
  latestBlocker: string | null;
  latestVerifierSummary: string | null;
  finalResultSummary: string | null;
  notes: string[];
  updatedAt: number;
}

export interface MissionLoopPolicy {
  maxAttempts: number | null;
  maxTurns: number | null;
  maxCycles: number | null;
  maxNoProgressCycles: number | null;
}

export interface WorkItem {
  id: string;
  source: MissionSource;
  sourceRef: string | null;
  platform: string;
  externalScopeId: string;
  title: string;
  immutableGoal: string;
  immutablePrompt: string;
  expectedOutput: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChecklistItem {
  id: string;
  kind: ChecklistItemKind;
  title: string;
  detail: string | null;
  order: number;
  status: ChecklistItemStatus;
  sourceRef: string | null;
  completionSummary: string | null;
  completedAt: number | null;
}

export interface ChecklistSnapshot {
  id: string;
  missionId: string;
  workItemId: string;
  generationId: string | null;
  version: number;
  source: MissionSource;
  sourceRef: string | null;
  expectedOutput: string | null;
  acceptanceCriteria: string[];
  plan: string[];
  items: ChecklistItem[];
  supersededAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlanChangeRequest {
  id: string;
  missionId: string;
  generationId: string | null;
  checklistSnapshotId: string | null;
  status: PlanChangeRequestStatus;
  rationale: string;
  proposedExpectedOutput: string | null;
  proposedAcceptanceCriteria: string[];
  proposedPlan: string[];
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

export interface MissionGeneration {
  id: string;
  missionId: string;
  workItemId: string;
  index: number;
  trigger: MissionGenerationTrigger;
  parentGenerationId: string | null;
  checklistSnapshotId: string | null;
  status: MissionGenerationStatus;
  attemptCount: number;
  summary: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  supersededAt: number | null;
}

export interface Mission {
  id: string;
  workItemId: string;
  source: MissionSource;
  sourceRef: string | null;
  platform: string;
  externalScopeId: string;
  title: string;
  immutableGoal: string;
  immutablePrompt: string;
  loopPolicy: MissionLoopPolicy;
  activeGenerationId: string;
  activeGenerationIndex: number;
  generationCount: number;
  currentChecklistSnapshotId: string;
  currentChecklistSnapshotVersion: number;
  goal: string;
  expectedOutput: string;
  acceptanceCriteria: string[];
  plan: string[];
  status: MissionStatus;
  priority: MissionPriority;
  riskLevel: MissionRiskLevel;
  cwd: string | null;
  workspacePath: string | null;
  workflowPath: string | null;
  providerProfileId: string;
  bridgeSessionId: string | null;
  codexThreadId: string | null;
  activeAttemptId: string | null;
  attemptCount: number;
  maxAttempts: number;
  maxTurns: number;
  lastRunAt: number | null;
  completedAt: number | null;
  archivedAt: number | null;
  stoppedAt: number | null;
  lastResultPreview: string | null;
  resultText: string | null;
  resultArtifacts: unknown[];
  lastError: string | null;
  statusReason: string | null;
  pendingApproval: MissionPendingApproval | null;
  lease: MissionLease | null;
  workpad: MissionWorkpad;
  createdAt: number;
  updatedAt: number;
}

export interface MissionAttempt {
  id: string;
  missionId: string;
  generationId?: string | null;
  generationIndex?: number | null;
  checklistSnapshotId?: string | null;
  index: number;
  status: MissionAttemptStatus;
  providerRunId: string | null;
  providerThreadId: string | null;
  promptDigest: string | null;
  verifierVerdict: MissionVerifierVerdict | null;
  verifierSummary: string | null;
  missingAcceptanceCriteria: string[];
  outputPreview: string | null;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MissionEvent {
  id: string;
  missionId: string;
  attemptId: string | null;
  generationId?: string | null;
  generationIndex?: number | null;
  kind: MissionEventKind;
  summary: string;
  detail: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface CreateMissionInput {
  id: string;
  workItemId?: string | null;
  source: MissionSource;
  sourceRef?: string | null;
  platform: string;
  externalScopeId: string;
  title: string;
  immutableGoal?: string | null;
  immutablePrompt?: string | null;
  goal: string;
  expectedOutput: string;
  acceptanceCriteria?: string[];
  plan?: string[];
  loopPolicy?: Partial<MissionLoopPolicy> | null;
  priority?: MissionPriority;
  riskLevel?: MissionRiskLevel;
  cwd?: string | null;
  workspacePath?: string | null;
  workflowPath?: string | null;
  providerProfileId: string;
  bridgeSessionId?: string | null;
  codexThreadId?: string | null;
  activeGenerationId?: string | null;
  activeGenerationIndex?: number | null;
  generationCount?: number | null;
  currentChecklistSnapshotId?: string | null;
  currentChecklistSnapshotVersion?: number | null;
  maxAttempts?: number;
  maxTurns?: number;
  now?: number;
}
