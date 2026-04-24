import type { InboundAttachmentKind } from './platform.js';

export interface PlatformScopeRef {
  platform: string;
  externalScopeId: string;
}

export interface BridgeSession {
  id: string;
  providerProfileId: string;
  codexThreadId: string;
  cwd: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionSettings {
  bridgeSessionId: string;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  personality?: 'friendly' | 'pragmatic' | 'none' | null;
  accessPreset?: 'read-only' | 'default' | 'full-access' | null;
  approvalPolicy?: string | null;
  sandboxMode?: string | null;
  locale: string | null;
  metadata: Record<string, unknown>;
  updatedAt: number;
}

export interface UploadBatchItem {
  id: string;
  kind: InboundAttachmentKind;
  localPath: string;
  originalPath: string;
  fileName: string | null;
  mimeType: string | null;
  transcriptText: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  receivedAt: number;
}

export interface UploadBatchState {
  active: boolean;
  batchId: string;
  startedAt: number;
  updatedAt: number;
  items: UploadBatchItem[];
}

export interface ThreadMetadata {
  providerProfileId: string;
  threadId: string;
  alias: string | null;
  updatedAt: number;
}

export type AutomationMode = 'standalone' | 'thread';

export type AutomationStatus = 'active' | 'paused';

export type AutomationSchedule =
  | {
    kind: 'interval';
    everySeconds: number;
    label: string;
  }
  | {
    kind: 'daily';
    hour: number;
    minute: number;
    timeZone: string;
    label: string;
  }
  | {
    kind: 'cron';
    expression: string;
    timeZone: string;
    label: string;
  };

export interface AutomationJob {
  id: string;
  platform: string;
  externalScopeId: string;
  title: string;
  mode: AutomationMode;
  providerProfileId: string;
  bridgeSessionId: string;
  cwd: string | null;
  prompt: string;
  locale: string | null;
  schedule: AutomationSchedule;
  status: AutomationStatus;
  running: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  lastDeliveredAt: number | null;
  lastResultPreview: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TurnArtifactIntent {
  requested: boolean;
  preferredKind: 'image' | 'file' | 'video' | 'audio' | null;
  requestedFormat: string | null;
  requestedExtension: string | null;
  requestedFileName: string | null;
  userDescription: string | null;
  requiresClarification: boolean;
}

export interface TurnArtifactContext {
  requestId: string;
  bridgeSessionId: string;
  artifactDir: string;
  spoolDir: string;
  turnId: string | null;
  intent: TurnArtifactIntent;
}

export type TurnArtifactDeliveryStage =
  | 'pending'
  | 'ready'
  | 'fallback_ready'
  | 'limited'
  | 'ambiguous'
  | 'missing';

export type TurnArtifactRejectionReason =
  | 'path_outside_artifact_dir'
  | 'missing_file'
  | 'not_file'
  | 'symlink'
  | 'invalid_manifest'
  | 'size_limit'
  | 'count_limit'
  | 'ambiguous_candidates';

export type TurnArtifactNoticeCode =
  | 'count_limited'
  | 'size_limited'
  | 'count_and_size_limited'
  | 'ambiguous_candidates'
  | 'missing_deliverable';

export interface TurnArtifactDeliveredItem {
  kind: 'image' | 'file' | 'video' | 'audio';
  path: string;
  displayName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  caption: string | null;
  source: 'provider_native' | 'bridge_declared' | 'bridge_fallback';
  turnId: string | null;
}

export interface TurnArtifactRejectedItem {
  path: string | null;
  displayName: string | null;
  sizeBytes: number | null;
  reason: TurnArtifactRejectionReason;
}

export interface TurnArtifactDeliveryState {
  requestId: string;
  bridgeSessionId: string;
  turnId: string | null;
  requestedByUser: boolean;
  requestedFormat: string | null;
  preferredKind: 'image' | 'file' | 'video' | 'audio' | null;
  requestedByText: string | null;
  artifactDir: string;
  spoolDir: string;
  stage: TurnArtifactDeliveryStage;
  fallbackUsed: boolean;
  manifestDeclaredCount: number;
  scannedCandidateCount: number;
  maxArtifactCount: number;
  maxArtifactSizeBytes: number;
  noticeCode: TurnArtifactNoticeCode | null;
  deliveredArtifacts: TurnArtifactDeliveredItem[];
  rejectedArtifacts: TurnArtifactRejectedItem[];
}
