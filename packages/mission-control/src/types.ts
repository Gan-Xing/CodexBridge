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

export interface Mission {
  id: string;
  source: MissionSource;
  sourceRef: string | null;
  platform: string;
  externalScopeId: string;
  title: string;
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
  kind: MissionEventKind;
  summary: string;
  detail: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface CreateMissionInput {
  id: string;
  source: MissionSource;
  sourceRef?: string | null;
  platform: string;
  externalScopeId: string;
  title: string;
  goal: string;
  expectedOutput: string;
  acceptanceCriteria?: string[];
  plan?: string[];
  priority?: MissionPriority;
  riskLevel?: MissionRiskLevel;
  cwd?: string | null;
  workspacePath?: string | null;
  workflowPath?: string | null;
  providerProfileId: string;
  bridgeSessionId?: string | null;
  codexThreadId?: string | null;
  maxAttempts?: number;
  maxTurns?: number;
  now?: number;
}
