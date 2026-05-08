import type { MissionCycleResult } from './cycle_result.js';
import type { MissionLoopSnapshotView } from './api_contract.js';
import type { MissionProviderArtifact } from './provider.js';
import type {
  MissionPendingApprovalOption,
  MissionStatus,
} from './types.js';

export interface MissionHostContext {
  missionId: string;
  platform: string;
  externalScopeId: string;
  hostSessionId: string | null;
  bridgeSessionId?: string | null;
  providerThreadId: string | null;
  actorId: string | null;
  actorDisplayName: string | null;
  locale: string | null;
  authContext: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

export interface MissionHostThreadBinding {
  missionId: string;
  hostSessionId: string | null;
  bridgeSessionId?: string | null;
  providerThreadId: string | null;
}

export interface MissionHostProgressUpdate {
  missionId: string;
  attemptId: string | null;
  status: MissionStatus;
  text: string;
  outputKind: 'commentary' | 'status';
  details?: Record<string, unknown> | null;
}

export interface MissionHostApprovalRequest {
  missionId: string;
  attemptId: string | null;
  requestId: string;
  kind: 'provider' | 'workflow' | 'manual';
  summary: string;
  options: MissionPendingApprovalOption[];
  details?: Record<string, unknown> | null;
}

export interface MissionHostArtifactPublication {
  missionId: string;
  attemptId: string | null;
  artifacts: MissionProviderArtifact[];
}

export interface MissionHostNotification {
  missionId: string;
  attemptId: string | null;
  status: MissionStatus;
  kind?: 'cycle_update' | 'status_update';
  notificationKey?: string | null;
  summary: string;
  loopSnapshot?: MissionLoopSnapshotView | null;
  cycleResult?: MissionCycleResult | null;
  details?: Record<string, unknown> | null;
}

export interface MissionHostAdapter {
  getContext(missionId: string): Promise<MissionHostContext>;
  bindProviderThread(input: MissionHostThreadBinding): Promise<void>;
  publishProgress(update: MissionHostProgressUpdate): Promise<void>;
  requestApproval(request: MissionHostApprovalRequest): Promise<void>;
  publishArtifacts(publication: MissionHostArtifactPublication): Promise<void>;
  notify(notification: MissionHostNotification): Promise<void>;
}

export function createNoopMissionHostAdapter(
  overrides: Partial<MissionHostAdapter> = {},
): MissionHostAdapter {
  return {
    async getContext(missionId) {
      return {
        missionId,
        platform: 'manual',
        externalScopeId: missionId,
        hostSessionId: null,
        bridgeSessionId: null,
        providerThreadId: null,
        actorId: null,
        actorDisplayName: null,
        locale: null,
        authContext: null,
        metadata: null,
      };
    },
    async bindProviderThread() {},
    async publishProgress() {},
    async requestApproval() {},
    async publishArtifacts() {},
    async notify() {},
    ...overrides,
  };
}
