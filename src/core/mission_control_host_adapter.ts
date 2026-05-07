import type {
  MissionHostAdapter,
  MissionHostApprovalRequest,
  MissionHostArtifactPublication,
  MissionHostNotification,
  MissionHostProgressUpdate,
  MissionHostThreadBinding,
} from '../../packages/mission-control/src/index.js';
import type { AgentJob, BridgeSession } from '../types/core.js';
import type { ProviderApprovalRequest, ProviderTurnProgress } from '../types/provider.js';

type ProgressHandler = ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
type ApprovalHandler = ((request: ProviderApprovalRequest) => Promise<void> | void) | null;
type ThreadBindingHandler = ((binding: MissionHostThreadBinding) => Promise<void> | void) | null;
type ArtifactPublicationHandler = ((publication: MissionHostArtifactPublication) => Promise<void> | void) | null;
type NotificationHandler = ((notification: MissionHostNotification) => Promise<void> | void) | null;

export interface CodexBridgeMissionHostAdapterOptions {
  jobId: string;
  resolveJob: () => AgentJob | null;
  resolveSession: () => BridgeSession | null;
  bindThread?: ThreadBindingHandler;
  onProgress?: ProgressHandler;
  onApprovalRequest?: ApprovalHandler;
  onArtifactPublication?: ArtifactPublicationHandler;
  onNotification?: NotificationHandler;
}

export class CodexBridgeMissionHostAdapter implements MissionHostAdapter {
  private readonly bindThread: ThreadBindingHandler;

  private readonly onProgress: ProgressHandler;

  private readonly onApprovalRequest: ApprovalHandler;

  private readonly onArtifactPublication: ArtifactPublicationHandler;

  private readonly onNotification: NotificationHandler;

  constructor(private readonly options: CodexBridgeMissionHostAdapterOptions) {
    this.bindThread = options.bindThread ?? null;
    this.onProgress = options.onProgress ?? null;
    this.onApprovalRequest = options.onApprovalRequest ?? null;
    this.onArtifactPublication = options.onArtifactPublication ?? null;
    this.onNotification = options.onNotification ?? null;
  }

  async getContext(missionId: string) {
    const job = this.requireJob(missionId);
    const session = this.options.resolveSession();
    return {
      missionId: job.id,
      platform: job.platform,
      externalScopeId: job.externalScopeId,
      hostSessionId: session?.id ?? job.bridgeSessionId ?? null,
      bridgeSessionId: session?.id ?? job.bridgeSessionId ?? null,
      providerThreadId: session?.codexThreadId ?? null,
      actorId: null,
      actorDisplayName: null,
      locale: job.locale,
      authContext: null,
      metadata: null,
    };
  }

  async bindProviderThread(input: MissionHostThreadBinding): Promise<void> {
    this.requireJob(input.missionId);
    await this.bindThread?.({
      ...input,
      hostSessionId: input.hostSessionId ?? input.bridgeSessionId ?? null,
      bridgeSessionId: input.bridgeSessionId ?? input.hostSessionId ?? null,
    });
  }

  async publishProgress(update: MissionHostProgressUpdate): Promise<void> {
    this.requireJob(update.missionId);
    const text = normalizeText(update.text);
    if (!text) {
      return;
    }
    await this.onProgress?.({
      text,
      delta: text,
      outputKind: update.outputKind,
    });
  }

  async requestApproval(request: MissionHostApprovalRequest): Promise<void> {
    this.requireJob(request.missionId);
    const session = this.options.resolveSession();
    const details = isRecord(request.details) ? request.details : {};
    await this.onApprovalRequest?.({
      requestId: request.requestId,
      kind: resolveProviderApprovalKind(details),
      threadId: normalizeText(String(session?.codexThreadId ?? '')) ?? '',
      turnId: normalizeText(String(details.turnId ?? '')),
      itemId: normalizeText(String(details.itemId ?? '')),
      reason: normalizeText(request.summary),
      command: normalizeText(String(details.command ?? '')),
      cwd: normalizeText(String(details.cwd ?? '')),
      fileChanges: normalizeStringArray(details.fileChanges),
      grantRoot: normalizeText(String(details.grantRoot ?? '')),
      networkPermission: typeof details.networkPermission === 'boolean'
        ? details.networkPermission
        : null,
      fileReadPermissions: normalizeStringArray(details.fileReadPermissions),
      fileWritePermissions: normalizeStringArray(details.fileWritePermissions),
      availableDecisionKeys: request.options.map((option) => option.label),
      execPolicyAmendment: normalizeStringArray(details.execPolicyAmendment),
    });
  }

  async publishArtifacts(publication: MissionHostArtifactPublication): Promise<void> {
    this.requireJob(publication.missionId);
    await this.onArtifactPublication?.(publication);
  }

  async notify(notification: MissionHostNotification): Promise<void> {
    this.requireJob(notification.missionId);
    await this.onNotification?.(notification);
  }

  private requireJob(missionId: string): AgentJob {
    const job = this.options.resolveJob();
    if (!job || job.id !== missionId) {
      throw new Error(`Unknown mission host binding: ${missionId}`);
    }
    return job;
  }
}

function resolveProviderApprovalKind(details: Record<string, unknown>): ProviderApprovalRequest['kind'] {
  if (normalizeStringArray(details.fileChanges).length > 0) {
    return 'file_change';
  }
  if (normalizeText(String(details.command ?? ''))) {
    return 'command';
  }
  return 'permissions';
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: string[] = [];
  for (const entry of value) {
    const text = normalizeText(String(entry ?? ''));
    if (!text) {
      continue;
    }
    normalized.push(text);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
