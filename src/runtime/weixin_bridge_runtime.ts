import { parseSlashCommand } from '../core/command_parser.js';
import { writeSequencedDebugLog } from '../core/sequenced_stderr.js';
import { WeixinPoller } from '../platforms/weixin/poller.js';
import { createI18n, type Translator } from '../i18n/index.js';
import type {
  InboundTextEvent,
  PlatformMediaDeliveryResult,
} from '../types/platform.js';
import type { OutputArtifact, ProviderApprovalRequest, ProviderTurnProgress } from '../types/provider.js';

interface DeliveryResult {
  success: boolean;
  deliveredCount: number;
  deliveredText: string;
  failedIndex: number | null;
  failedText: string;
  error: string;
  errorCode?: number | null;
}

interface RuntimeResponseMessage {
  text?: string | null;
  artifact?: OutputArtifact | null;
  mediaPath?: string | null;
  caption?: string | null;
}

interface RuntimeResponse {
  type?: string | null;
  messages?: RuntimeResponseMessage[] | null;
  meta?: {
    codexTurn?: {
      outputState?: string | null;
      previewText?: string | null;
      finalSource?: string | null;
      errorMessage?: string | null;
    } | null;
    systemAction?: {
      kind?: string | null;
    } | null;
  } | null;
}

interface PlatformPluginLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  pollOnce(): Promise<{ syncCursor?: string | null; events: InboundTextEvent[] }>;
  commitSyncCursor?(syncCursor: string | null | undefined): Promise<void> | void;
  sendText(params: { externalScopeId: string; content: string }): Promise<DeliveryResult | null | undefined>;
  sendTyping?(params: { externalScopeId: string; status: 'start' | 'stop' }): Promise<void> | void;
  sendMedia?(params: { externalScopeId: string; filePath: string; caption?: string | null }): Promise<PlatformMediaDeliveryResult | null | undefined>;
}

interface BridgeCoordinatorLike {
  handleInboundEvent(
    event: InboundTextEvent,
    options: {
      onProgress?: ((progress: ProviderTurnProgress) => Promise<void>) | null;
      onApprovalRequest?: ((request: ProviderApprovalRequest) => Promise<void>) | null;
    },
  ): Promise<RuntimeResponse>;
  renderApprovalPrompt?(event: InboundTextEvent): Promise<string | null> | string | null;
  restartBridge?(params: { event: InboundTextEvent }): Promise<void>;
  runAgentJob?(
    job: any,
    options: {
      onProgress?: ((progress: ProviderTurnProgress) => Promise<void>) | null;
      onApprovalRequest?: ((request: ProviderApprovalRequest) => Promise<void>) | null;
    },
  ): Promise<RuntimeResponse>;
}

interface StreamState {
  lastObservedFinal: string;
  pendingPreview: string;
  previewPumpPromise: Promise<void> | null;
  previewStopped: boolean;
  firstPreviewSent: boolean;
  nextPreviewAt: number;
  streamedText: string;
  sentChunkCount: number;
  streamingDisabled: boolean;
}

interface ScheduledDispatch {
  type: 'scheduled';
  completion: Promise<RuntimeResponse>;
  afterCommit?: (() => Promise<void> | void) | null;
}

interface FinalDelivery {
  source: string;
  mode: string;
  finalText: string;
  sentContent: string;
}

interface PendingInboundMerge {
  event: InboundTextEvent;
  timer: ReturnType<typeof setTimeout> | null;
  completion: Promise<RuntimeResponse>;
  resolve: (response: RuntimeResponse) => void;
  reject: (error: unknown) => void;
}

interface PendingScopeNotice {
  content: string;
  queuedAt: number;
}

interface WeixinBridgeRuntimeOptions {
  platformPlugin: PlatformPluginLike;
  bridgeCoordinator: BridgeCoordinatorLike;
  automationJobs?: any;
  agentJobs?: any;
  assistantRecords?: any;
  onError?: (error: unknown) => Promise<void> | void;
  previewSoftTargetBytes?: number;
  previewHardLimitBytes?: number;
  previewIntervalMs?: number;
  typingKeepaliveMs?: number;
  inboundAttachmentMergeWindowMs?: number;
  automationPollMs?: number;
  locale?: string | null;
}

export class WeixinBridgeRuntime {
  static readonly NOTICE_COOLDOWN_MS = 30_000;
  static readonly DEFAULT_TYPING_KEEPALIVE_MS = 8_000;

  platformPlugin: PlatformPluginLike;

  bridgeCoordinator: BridgeCoordinatorLike;

  automationJobs: any;
  agentJobs: any;
  assistantRecords: any;

  onError: (error: unknown) => Promise<void> | void;

  previewSoftTargetBytes: number;

  previewHardLimitBytes: number;

  previewIntervalMs: number;

  typingKeepaliveMs: number;

  inboundAttachmentMergeWindowMs: number;

  automationPollMs: number;

  i18n: Translator;

  poller: WeixinPoller | null;

  backgroundTasks: Set<Promise<RuntimeResponse>>;

  scopeChains: Map<string, Promise<RuntimeResponse>>;

  pendingInboundMerges: Map<string, PendingInboundMerge>;

  pendingScopeNotices: Map<string, PendingScopeNotice>;

  recentScopeNotices: Map<string, { content: string; sentAt: number }>;

  automationSweepTimer: ReturnType<typeof setInterval> | null;

  automationSweepInFlight: Promise<void> | null;

  constructor({
    platformPlugin,
    bridgeCoordinator,
    automationJobs = null,
    agentJobs = null,
    assistantRecords = null,
    onError = async () => {},
    previewSoftTargetBytes = 2048,
    previewHardLimitBytes = 2048,
    previewIntervalMs = 3000,
    typingKeepaliveMs = WeixinBridgeRuntime.DEFAULT_TYPING_KEEPALIVE_MS,
    inboundAttachmentMergeWindowMs = 3000,
    automationPollMs = 30_000,
    locale = null,
  }) {
    this.platformPlugin = platformPlugin;
    this.bridgeCoordinator = bridgeCoordinator;
    this.automationJobs = automationJobs;
    this.agentJobs = agentJobs;
    this.assistantRecords = assistantRecords;
    this.onError = onError;
    this.previewSoftTargetBytes = previewSoftTargetBytes;
    this.previewHardLimitBytes = previewHardLimitBytes;
    this.previewIntervalMs = previewIntervalMs;
    this.typingKeepaliveMs = typingKeepaliveMs;
    this.inboundAttachmentMergeWindowMs = inboundAttachmentMergeWindowMs;
    this.automationPollMs = automationPollMs;
    this.i18n = createI18n(locale);
    this.poller = null;
    this.backgroundTasks = new Set();
    this.scopeChains = new Map();
    this.pendingInboundMerges = new Map();
    this.pendingScopeNotices = new Map();
    this.recentScopeNotices = new Map();
    this.automationSweepTimer = null;
    this.automationSweepInFlight = null;
  }

  async start(): Promise<void> {
    await this.platformPlugin.start();
    this.automationJobs?.resetRunningJobs?.();
    this.agentJobs?.resetRunningJobs?.();
    this.startAutomationScheduler();
    this.poller = new WeixinPoller({
      plugin: this.platformPlugin,
      onEvent: async (event) => this.dispatchInboundEvent(event),
      onError: async (error) => {
        await this.onError(error);
      },
    } as any);
    return this.poller.start();
  }

  async stop() {
    this.poller?.stop();
    this.poller = null;
    this.stopAutomationScheduler();
    await this.flushAllPendingInboundMerges();
    await this.waitForIdle();
    await this.platformPlugin.stop();
  }

  async runOnce(): Promise<{ syncCursor?: string | null; events: InboundTextEvent[] }> {
    const result = await this.platformPlugin.pollOnce();
    const dispatch = await this.dispatchEvents(result.events ?? []);
    await dispatch.completion;
    await this.platformPlugin.commitSyncCursor?.(result.syncCursor);
    for (const afterCommit of dispatch.afterCommitActions) {
      await afterCommit();
    }
    return result;
  }

  async handleInboundEvent(event: InboundTextEvent): Promise<RuntimeResponse> {
    return this.scheduleInboundEvent(event);
  }

  async dispatchInboundEvent(event: InboundTextEvent): Promise<any> {
    const command = parseSlashCommand(String(event?.text ?? ''));
    if (command) {
      await this.flushPendingInboundMerge(event.externalScopeId);
      if (shouldScheduleSlashCommand(command)) {
        const task = this.processInboundEventWithOptions(event, { deferPostResponseAction: true }).catch(async (error) => {
          await this.onError(error);
          throw error;
        });
        this.trackBackgroundTask(task);
        return {
          type: 'scheduled',
          completion: task,
        };
      }
      const response = await this.processInboundEventWithOptions(event, { deferPostResponseAction: true });
      const afterCommit = this.buildAfterCommitAction(response, event);
      return afterCommit ? { afterCommit } : undefined;
    }
    const task = this.scheduleInboundEvent(event)
      .catch(async (error) => {
        await this.onError(error);
        throw error;
      });
    this.trackBackgroundTask(task);
    return {
      type: 'scheduled',
      completion: task,
    };
  }

  async waitForIdle(): Promise<void> {
    await this.flushAllPendingInboundMerges();
    if (this.automationSweepInFlight) {
      await this.automationSweepInFlight.catch(() => {});
    }
    const tasks = [...this.backgroundTasks];
    if (tasks.length === 0) {
      return;
    }
    await Promise.allSettled(tasks);
  }

  async dispatchEvents(events: InboundTextEvent[]): Promise<{
    completion: Promise<void>;
    afterCommitActions: Array<() => Promise<void> | void>;
  }> {
    const completions: Promise<void>[] = [];
    const afterCommitActions: Array<() => Promise<void> | void> = [];
    for (const event of events) {
      const outcome = await this.dispatchInboundEvent(event);
      const completion = extractCompletionPromise(outcome);
      if (completion) {
        completions.push(completion);
      }
      const afterCommit = extractAfterCommitAction(outcome);
      if (afterCommit) {
        afterCommitActions.push(afterCommit);
      }
    }
    return {
      completion: completions.length === 0 ? Promise.resolve() : Promise.all(completions).then(() => {}),
      afterCommitActions,
    };
  }

  scheduleInboundEvent(event: InboundTextEvent): Promise<RuntimeResponse> {
    const scopeId = String(event?.externalScopeId ?? '');
    if (!scopeId) {
      return this.processInboundEvent(event);
    }

    const pending = this.pendingInboundMerges.get(scopeId) ?? null;
    if (pending) {
      if (parseSlashCommand(String(event?.text ?? ''))) {
        void this.flushPendingInboundMerge(scopeId);
        return this.enqueueScopeWork(scopeId, async () => this.processInboundEvent(event));
      }
      const mergedEvent = mergeInboundEvents(pending.event, event);
      if (shouldDelayInboundEvent(mergedEvent)) {
        pending.event = mergedEvent;
        debugRuntime('pending_inbound_merge_updated', {
          scopeId,
          attachmentCount: Array.isArray(mergedEvent.attachments) ? mergedEvent.attachments.length : 0,
          hasText: Boolean(String(mergedEvent.text ?? '').trim()),
        });
        this.armPendingInboundMerge(scopeId, pending);
        return pending.completion;
      }
      this.pendingInboundMerges.delete(scopeId);
      this.clearPendingInboundTimer(pending);
      const operation = this.enqueueScopeWork(scopeId, async () => this.processInboundEvent(mergedEvent));
      operation.then(pending.resolve, pending.reject);
      return operation;
    }

    if (this.scopeChains.has(scopeId)) {
      debugRuntime('scope_busy_rejected', {
        scopeId,
        textPreview: truncateDebugText(event?.text),
        attachmentCount: Array.isArray(event?.attachments) ? event.attachments.length : 0,
      });
      return this.respondWhileScopeBusy(event);
    }

    if (shouldDelayInboundEvent(event)) {
      const deferred = createPendingInboundMerge(event);
      this.pendingInboundMerges.set(scopeId, deferred);
      debugRuntime('pending_inbound_merge_started', {
        scopeId,
        attachmentCount: Array.isArray(event.attachments) ? event.attachments.length : 0,
      });
      this.armPendingInboundMerge(scopeId, deferred);
      return deferred.completion;
    }

    return this.enqueueScopeWork(scopeId, async () => this.processInboundEvent(event));
  }

  async respondWhileScopeBusy(event: InboundTextEvent): Promise<RuntimeResponse> {
    const content = [
      this.i18n.t('coordinator.blocked.active'),
      this.i18n.t('coordinator.blocked.waitOrStop'),
    ].join('\n');
    const typingStart = this.safeSendTyping(event.externalScopeId, 'start');
    try {
      const delivery = await this.sendTextWithRetry({
        externalScopeId: event.externalScopeId,
        content,
      });
      if (!delivery.success && this.isRateLimitedDeliveryFailure(delivery)) {
        await this.ensureScopeNoticeDelivered(
          event.externalScopeId,
          this.i18n.t('runtime.error.weixinRateLimitedNotice'),
        );
      }
      return {
        type: 'message',
        messages: [{ text: content }],
      };
    } finally {
      await typingStart;
      await this.safeSendTyping(event.externalScopeId, 'stop');
    }
  }

  armPendingInboundMerge(scopeId: string, pending: PendingInboundMerge): void {
    this.clearPendingInboundTimer(pending);
    pending.timer = setTimeout(() => {
      void this.flushPendingInboundMerge(scopeId);
    }, this.inboundAttachmentMergeWindowMs);
  }

  clearPendingInboundTimer(pending: PendingInboundMerge): void {
    if (!pending.timer) {
      return;
    }
    clearTimeout(pending.timer);
    pending.timer = null;
  }

  async flushPendingInboundMerge(externalScopeId: string): Promise<void> {
    const scopeId = String(externalScopeId ?? '');
    if (!scopeId) {
      return;
    }
    const pending = this.pendingInboundMerges.get(scopeId);
    if (!pending) {
      return;
    }
    this.pendingInboundMerges.delete(scopeId);
    this.clearPendingInboundTimer(pending);
    debugRuntime('pending_inbound_merge_flushed', {
      scopeId,
      attachmentCount: Array.isArray(pending.event.attachments) ? pending.event.attachments.length : 0,
      hasText: Boolean(String(pending.event.text ?? '').trim()),
    });
    const operation = this.enqueueScopeWork(scopeId, async () => this.processInboundEvent(pending.event));
    operation.then(pending.resolve, pending.reject);
    await operation.catch(() => {});
  }

  async flushAllPendingInboundMerges(): Promise<void> {
    const scopeIds = [...this.pendingInboundMerges.keys()];
    if (scopeIds.length === 0) {
      return;
    }
    await Promise.all(scopeIds.map(async (scopeId) => {
      await this.flushPendingInboundMerge(scopeId);
    }));
  }

  async processInboundEvent(event: InboundTextEvent): Promise<RuntimeResponse> {
    return this.processInboundEventWithOptions(event, { deferPostResponseAction: false });
  }

  async processInboundEventWithOptions(
    event: InboundTextEvent,
    options: { deferPostResponseAction?: boolean } = {},
  ): Promise<RuntimeResponse> {
    await this.flushPendingScopeNotice(event.externalScopeId);
    const streamState = createStreamState();
    debugRuntime('process_inbound_event_start', {
      scopeId: event.externalScopeId,
      deferPostResponseAction: Boolean(options.deferPostResponseAction),
      textPreview: truncateDebugText(event?.text),
      attachmentCount: Array.isArray(event?.attachments) ? event.attachments.length : 0,
    });
    const typingStart = this.safeSendTyping(event.externalScopeId, 'start');
    const stopTypingKeepalive = this.startTypingKeepalive(event.externalScopeId);
    try {
      const response = await this.bridgeCoordinator.handleInboundEvent(event, {
        onProgress: async (progress) => {
          await this.handleProgressUpdate(event, streamState, progress);
        },
        onApprovalRequest: async () => {
          await this.notifyApprovalPrompt(event);
        },
      });
      debugRuntime('coordinator_response', {
        scopeId: event.externalScopeId,
        type: response?.type ?? null,
        messageCount: Array.isArray(response?.messages) ? response.messages.length : null,
        messages: Array.isArray(response?.messages)
          ? response.messages.map((message) => ({
            text: truncateDebugText(message?.text),
            artifactKind: message?.artifact?.kind ?? null,
            artifactPath: String(message?.artifact?.path ?? ''),
            mediaPath: String(message?.mediaPath ?? ''),
            caption: truncateDebugText(message?.caption),
          }))
          : null,
      });
      if (response?.type !== 'message') {
        debugRuntime('skip_non_message_response', {
          scopeId: event.externalScopeId,
          type: response?.type ?? null,
        });
        return response;
      }
      const codexTurnMeta = response?.meta?.codexTurn ?? null;
      const finalText = extractResponseMessageText(response);
      const artifactMessages = extractResponseArtifactMessages(response);
      const hasComparableFinalText = Boolean(normalizeComparableText(finalText));
      const hasCompleteMediaOnlyFinal = !hasComparableFinalText
        && artifactMessages.length > 0
        && (codexTurnMeta?.outputState ?? 'complete') === 'complete';
      if (hasCompleteMediaOnlyFinal) {
        await this.stopPreviewStreaming(streamState);
        debugRuntime('final_delivery_decision', {
          scopeId: event.externalScopeId,
          outputState: codexTurnMeta?.outputState ?? null,
          finalSource: codexTurnMeta?.finalSource ?? 'thread_items_media',
          finalText: '',
          streamedPreview: truncateDebugText(streamState.streamedText),
          previewChunkCount: streamState.sentChunkCount,
          completionMode: 'media_only_final',
          deliveryContent: '',
        });
      } else if (hasComparableFinalText || codexTurnMeta) {
        const finalDelivery = await this.ensureFinalDelivered(event, streamState, response, codexTurnMeta);
        debugRuntime('final_delivery_decision', {
          scopeId: event.externalScopeId,
          outputState: codexTurnMeta?.outputState ?? null,
          finalSource: finalDelivery.source,
          finalText: truncateDebugText(finalDelivery.finalText),
          streamedPreview: truncateDebugText(streamState.streamedText),
          previewChunkCount: streamState.sentChunkCount,
          completionMode: finalDelivery.mode,
          deliveryContent: truncateDebugText(finalDelivery.sentContent),
        });
      } else {
        await this.stopPreviewStreaming(streamState);
      }
      if (artifactMessages.length > 0) {
        await this.deliverArtifactMessages(event, artifactMessages);
      }
      if (!options.deferPostResponseAction) {
        await this.runPostResponseAction(response, event);
      }
      return response;
    } finally {
      await typingStart;
      await stopTypingKeepalive();
    }
  }

  async handleProgressUpdate(
    event: InboundTextEvent,
    streamState: StreamState,
    progress: ProviderTurnProgress | null | undefined,
  ): Promise<void> {
    if (
      !progress
      || !['commentary', 'final_answer'].includes(progress.outputKind)
      || streamState.streamingDisabled
      || streamState.previewStopped
    ) {
      return;
    }
    debugRuntime('progress_update_received', {
      scopeId: event.externalScopeId,
      outputKind: progress.outputKind,
      deltaPreview: truncateDebugText(progress.delta, 120),
      textLength: String(progress.text ?? '').length,
      pendingPreviewLength: streamState.pendingPreview.length,
      streamedLength: streamState.streamedText.length,
    });
    if (progress.outputKind === 'final_answer') {
      const nextText = String(progress.text ?? '');
      if (nextText) {
        if (streamState.lastObservedFinal && !nextText.startsWith(streamState.lastObservedFinal)) {
          if (streamState.lastObservedFinal.startsWith(nextText)) {
            return;
          }
          streamState.streamingDisabled = true;
          streamState.pendingPreview = '';
          streamState.lastObservedFinal = nextText;
          return;
        }
        streamState.lastObservedFinal = nextText;
      }
    }

    const delta = String(progress.delta ?? progress.text ?? '');
    if (!delta) {
      return;
    }

    streamState.pendingPreview += delta;

    if (!streamState.firstPreviewSent) {
      const firstChunk = extractImmediatePreviewChunk(streamState.pendingPreview, this.previewHardLimitBytes);
      if (firstChunk) {
        streamState.pendingPreview = streamState.pendingPreview.slice(firstChunk.length).replace(/^[\s\n]+/u, '');
        await this.sendPreviewChunk(event, streamState, firstChunk.trim());
        if (streamState.streamingDisabled || streamState.previewStopped) {
          return;
        }
        streamState.firstPreviewSent = true;
        streamState.nextPreviewAt = Date.now() + this.previewIntervalMs;
      }
    }

    this.ensurePreviewPump(event, streamState);
  }

  ensurePreviewPump(event: InboundTextEvent, streamState: StreamState): void {
    if (streamState.previewPumpPromise || streamState.previewStopped || streamState.streamingDisabled || !streamState.firstPreviewSent) {
      return;
    }
    streamState.previewPumpPromise = this.runPreviewPump(event, streamState)
      .finally(() => {
        streamState.previewPumpPromise = null;
        if (
          streamState.pendingPreview &&
          !streamState.previewStopped &&
          !streamState.streamingDisabled &&
          streamState.firstPreviewSent
        ) {
          this.ensurePreviewPump(event, streamState);
        }
      });
  }

  async runPreviewPump(event: InboundTextEvent, streamState: StreamState): Promise<void> {
    while (!streamState.previewStopped && !streamState.streamingDisabled) {
      if (!streamState.pendingPreview) {
        return;
      }
      const waitMs = Math.max(0, streamState.nextPreviewAt - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs);
        if (streamState.previewStopped || streamState.streamingDisabled) {
          return;
        }
      }
      if (!streamState.pendingPreview) {
        return;
      }
      const chunk = extractTimedPreviewChunk(streamState.pendingPreview, this.previewSoftTargetBytes);
      if (!chunk) {
        return;
      }
      streamState.pendingPreview = streamState.pendingPreview.slice(chunk.length).replace(/^[\s\n]+/u, '');
      await this.sendPreviewChunk(event, streamState, chunk.trim());
      if (streamState.streamingDisabled || streamState.previewStopped) {
        return;
      }
      streamState.nextPreviewAt = Date.now() + this.previewIntervalMs;
    }
  }

  async sendPreviewChunk(event: InboundTextEvent, streamState: StreamState, chunk: string): Promise<void> {
    const normalizedChunk = String(chunk ?? '').trim();
    if (!normalizedChunk) {
      return;
    }
    const delivery = await this.sendTextWithRetry({
      externalScopeId: event.externalScopeId,
      content: normalizedChunk,
    });
    if (!delivery.success) {
      streamState.streamingDisabled = true;
      streamState.pendingPreview = '';
      debugRuntime('preview_delivery_failed', {
        scopeId: event.externalScopeId,
        failedText: truncateDebugText(delivery.failedText),
        deliveredText: truncateDebugText(delivery.deliveredText),
        error: delivery.error,
      });
      if (delivery.deliveredText) {
        appendPreviewText(streamState, delivery.deliveredText);
      }
      return;
    }
    appendPreviewText(streamState, delivery.deliveredText || normalizedChunk);
  }

  async stopPreviewStreaming(streamState: StreamState): Promise<void> {
    streamState.previewStopped = true;
    streamState.pendingPreview = '';
    const pump = streamState.previewPumpPromise;
    if (pump) {
      await pump;
    }
  }

  async ensureFinalDelivered(
    event: InboundTextEvent,
    streamState: StreamState,
    response: RuntimeResponse,
    codexTurnMeta: RuntimeResponse['meta'] extends infer T
      ? T extends { codexTurn?: infer U | null }
        ? U | null
        : null
      : null,
  ): Promise<FinalDelivery> {
    await this.stopPreviewStreaming(streamState);

    const outputState = codexTurnMeta?.outputState ?? 'complete';
    const errorMessage = String(codexTurnMeta?.errorMessage ?? '').trim();
    const finalText = extractResponseMessageText(response);
    const artifactMessages = extractResponseArtifactMessages(response);
    const normalizedFinal = normalizeComparableText(finalText);
    debugRuntime('final_delivery_begin', {
      scopeId: event.externalScopeId,
      outputState,
      finalSource: codexTurnMeta?.finalSource ?? null,
      errorMessage,
      finalTextPreview: truncateDebugText(finalText),
      artifactCount: artifactMessages.length,
      streamedPreview: truncateDebugText(streamState.streamedText),
      previewChunkCount: streamState.sentChunkCount,
    });
    if (outputState !== 'complete') {
      let partialCommitDelivery: DeliveryResult | null = null;
      if (outputState === 'partial' && normalizedFinal) {
        const previewText = isComparablePrefix(streamState.streamedText, finalText) ? streamState.streamedText : '';
        const commitContent = resolveFinalCommitContent(finalText, previewText);
        if (!commitContent) {
          return {
            source: codexTurnMeta?.finalSource ?? 'progress_only',
            mode: 'partial_preview_already_sent',
            finalText,
            sentContent: '',
          };
        }
        const delivery = await this.sendTextWithRetry({
          externalScopeId: event.externalScopeId,
          content: commitContent,
        });
        partialCommitDelivery = delivery;
        if (delivery.success) {
          return {
            source: codexTurnMeta?.finalSource ?? 'progress_only',
            mode: 'partial_preview_commit',
            finalText,
            sentContent: delivery.deliveredText || commitContent,
          };
        }
      }
      const failureMessage = errorMessage
        ? this.formatProviderFailureMessage(errorMessage)
        : outputState === 'interrupted'
          ? this.i18n.t('runtime.error.interrupted')
          : outputState === 'timeout'
            ? this.i18n.t('runtime.error.timeout')
            : outputState === 'stale_session'
              ? this.i18n.t('runtime.error.staleSession')
              : this.i18n.t('runtime.error.incomplete');
      const failureDelivery = await this.sendTextWithRetry({
        externalScopeId: event.externalScopeId,
        content: failureMessage,
      });
      if (
        !failureDelivery.success
        && (
          this.isRateLimitedDeliveryFailure(failureDelivery)
          || this.isRateLimitedDeliveryFailure(partialCommitDelivery)
        )
      ) {
        await this.ensureScopeNoticeDelivered(
          event.externalScopeId,
          this.i18n.t('runtime.error.weixinRateLimitedNotice'),
        );
      }
      const failureMode = outputState === 'partial'
        ? 'explicit_partial_failure'
        : outputState === 'interrupted'
          ? 'explicit_interrupted_failure'
          : outputState === 'timeout'
            ? 'explicit_timeout_failure'
            : outputState === 'stale_session'
              ? 'explicit_stale_session_failure'
              : outputState === 'provider_error'
                ? 'explicit_provider_error_failure'
              : 'explicit_missing_failure';
      return {
        source: codexTurnMeta?.finalSource ?? 'none',
        mode: failureMode,
        finalText: '',
        sentContent: failureDelivery.deliveredText || failureMessage,
      };
    }
    if (!normalizedFinal) {
      if (artifactMessages.length > 0) {
        return {
          source: codexTurnMeta?.finalSource ?? 'thread_items_media',
          mode: 'media_only_complete',
          finalText: '',
          sentContent: '',
        };
      }
      throw new Error(this.i18n.t('runtime.error.finalTextMissing', { scopeId: event.externalScopeId }));
    }

    const previewText = isComparablePrefix(streamState.streamedText, finalText) ? streamState.streamedText : '';
    if (normalizeComparableText(previewText) === normalizedFinal) {
      return {
        source: codexTurnMeta?.finalSource ?? 'thread_items',
        mode: 'preview_already_complete',
        finalText,
        sentContent: '',
      };
    }

    let lastAttemptedContent = '';
    let lastFailedDelivery: DeliveryResult | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const commitContent = resolveFinalCommitContent(finalText, previewText);
      if (!commitContent) {
        return {
          source: codexTurnMeta?.finalSource ?? 'thread_items',
          mode: attempt === 1 ? 'preview_already_complete' : 'final_resumed_complete',
          finalText,
          sentContent: '',
        };
      }
      lastAttemptedContent = commitContent;
      debugRuntime('final_delivery_attempt', {
        scopeId: event.externalScopeId,
        attempt,
        contentPreview: truncateDebugText(commitContent),
      });
      const delivery = await this.sendTextWithRetry({
        externalScopeId: event.externalScopeId,
        content: commitContent,
      });
      if (delivery.success) {
        return {
          source: codexTurnMeta?.finalSource ?? 'thread_items',
          mode: commitContent === finalText ? 'full_final_commit' : 'tail_final_commit',
          finalText,
          sentContent: delivery.deliveredText || commitContent,
        };
      }
      lastFailedDelivery = delivery;
      debugRuntime('final_delivery_attempt_failed', {
        scopeId: event.externalScopeId,
        attempt,
        deliveredText: truncateDebugText(delivery.deliveredText),
        failedText: truncateDebugText(delivery.failedText),
        error: delivery.error,
      });
    }

    if (this.isRateLimitedDeliveryFailure(lastFailedDelivery)) {
      await this.ensureScopeNoticeDelivered(
        event.externalScopeId,
        this.i18n.t('runtime.error.weixinRateLimitedNotice'),
      );
    }

    return {
      source: codexTurnMeta?.finalSource ?? 'thread_items',
      mode: 'final_delivery_incomplete',
      finalText,
      sentContent: lastAttemptedContent,
    };
  }

  formatProviderFailureMessage(errorMessage: string): string {
    const normalized = String(errorMessage ?? '').trim();
    const detail = normalized.replace(/[。.!！]+$/u, '');
    if (/subscription credits are exhausted/i.test(normalized)) {
      return this.i18n.t('runtime.error.codexCreditsExhausted', {
        detail,
      });
    }
    if (/usage limit reached/i.test(normalized)) {
      return this.i18n.t('runtime.error.codexUsageLimitReached', {
        detail,
      });
    }
    return this.i18n.t('runtime.error.codex', { error: normalized });
  }

  async safeSendTyping(externalScopeId: string, status: 'start' | 'stop'): Promise<void> {
    if (typeof this.platformPlugin.sendTyping !== 'function') {
      return;
    }
    try {
      await this.platformPlugin.sendTyping({ externalScopeId, status });
    } catch {
      // Ignore WeChat typing failures; progress delivery matters more than presence.
    }
  }

  startTypingKeepalive(externalScopeId: string): () => Promise<void> {
    if (typeof this.platformPlugin.sendTyping !== 'function' || this.typingKeepaliveMs <= 0) {
      return async () => {
        await this.safeSendTyping(externalScopeId, 'stop');
      };
    }
    const timer = setInterval(() => {
      void this.safeSendTyping(externalScopeId, 'start');
    }, this.typingKeepaliveMs);
    return async () => {
      clearInterval(timer);
      await this.safeSendTyping(externalScopeId, 'stop');
    };
  }

  async sendTextWithRetry({
    externalScopeId,
    content,
  }: {
    externalScopeId: string;
    content: string;
  }): Promise<DeliveryResult> {
    const result = await this.platformPlugin.sendText({ externalScopeId, content });
    return this.normalizeTextDeliveryResult(result, content);
  }

  normalizeTextDeliveryResult(
    result: DeliveryResult | null | undefined,
    content: string,
  ): DeliveryResult {
    return result ?? {
      success: false,
      deliveredCount: 0,
      deliveredText: '',
      failedIndex: 0,
      failedText: String(content ?? '').trim(),
      error: this.i18n.t('runtime.error.unknownDeliveryFailure'),
      errorCode: null,
    };
  }

  async sendSystemTextDirect({
    externalScopeId,
    content,
  }: {
    externalScopeId: string;
    content: string;
  }): Promise<DeliveryResult> {
    const result = await this.platformPlugin.sendText({ externalScopeId, content });
    return this.normalizeTextDeliveryResult(result, content);
  }

  async sendMediaWithRetry({
    externalScopeId,
    filePath,
    caption,
  }: {
    externalScopeId: string;
    filePath: string;
    caption?: string | null;
  }): Promise<PlatformMediaDeliveryResult> {
    if (typeof this.platformPlugin.sendMedia !== 'function') {
      return {
        success: false,
        messageId: null,
        sentPath: String(filePath ?? ''),
        sentCaption: String(caption ?? '').trim(),
        error: this.i18n.t('runtime.error.unknownDeliveryFailure'),
      };
    }
    let lastResult: PlatformMediaDeliveryResult | null | undefined = null;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) {
        await sleep(Math.max(0, this.previewIntervalMs));
      }
      debugRuntime('artifact_delivery_attempt', {
        scopeId: externalScopeId,
        filePath: String(filePath ?? ''),
        caption: truncateDebugText(caption),
        attempt,
        maxAttempts,
      });
      const result = await this.platformPlugin.sendMedia({
        externalScopeId,
        filePath,
        caption,
      });
      lastResult = result;
      debugRuntime('artifact_delivery_result', {
        scopeId: externalScopeId,
        filePath: String(filePath ?? ''),
        success: Boolean(result?.success),
        messageId: result?.messageId ?? null,
        sentPath: result?.sentPath ?? null,
        sentCaption: truncateDebugText(result?.sentCaption),
        error: result?.error ?? null,
        errorCode: result?.errorCode ?? null,
        attempt,
      });
      if (result?.success || !this.isRateLimitedDeliveryFailure(result) || attempt >= maxAttempts) {
        break;
      }
    }
    return lastResult ?? {
      success: false,
      messageId: null,
      sentPath: String(filePath ?? ''),
      sentCaption: String(caption ?? '').trim(),
      error: this.i18n.t('runtime.error.unknownDeliveryFailure'),
      errorCode: null,
    };
  }

  async deliverArtifactMessages(
    event: InboundTextEvent,
    artifacts: OutputArtifact[],
  ): Promise<void> {
    debugRuntime('artifact_delivery_begin', {
      scopeId: event.externalScopeId,
      artifactCount: artifacts.length,
      artifacts: artifacts.map((artifact) => ({
        kind: artifact?.kind ?? null,
        path: String(artifact?.path ?? ''),
        caption: truncateDebugText(artifact?.caption),
      })),
    });
    const deliveryErrors: string[] = [];
    let rateLimitedFailure = false;
    for (const artifact of artifacts) {
      const filePath = String(artifact?.path ?? '').trim();
      if (!filePath) {
        continue;
      }
      const result = await this.sendMediaWithRetry({
        externalScopeId: event.externalScopeId,
        filePath,
        caption: artifact.caption ?? null,
      });
      if (!result.success) {
        rateLimitedFailure ||= this.isRateLimitedDeliveryFailure(result);
        const errorMessage = this.describeDeliveryFailure(result, result.sentPath);
        deliveryErrors.push(errorMessage);
        debugRuntime('artifact_delivery_failed', {
          scopeId: event.externalScopeId,
          filePath,
          error: errorMessage,
        });
      } else {
        debugRuntime('artifact_delivery_succeeded', {
          scopeId: event.externalScopeId,
          filePath,
          messageId: result.messageId ?? null,
          sentPath: result.sentPath ?? null,
        });
      }
    }
    if (deliveryErrors.length === 0) {
      debugRuntime('artifact_delivery_complete', {
        scopeId: event.externalScopeId,
        artifactCount: artifacts.length,
        errorCount: 0,
      });
      return;
    }
    debugRuntime('artifact_delivery_complete', {
      scopeId: event.externalScopeId,
      artifactCount: artifacts.length,
      errorCount: deliveryErrors.length,
      firstError: deliveryErrors[0] ?? null,
    });
    const failureDelivery = await this.sendTextWithRetry({
      externalScopeId: event.externalScopeId,
      content: this.i18n.t('runtime.error.attachmentDeliveryFailed', {
        error: deliveryErrors[0] ?? this.i18n.t('runtime.error.unknownDeliveryFailure'),
      }),
    });
    if (!failureDelivery.success && (rateLimitedFailure || this.isRateLimitedDeliveryFailure(failureDelivery))) {
      await this.ensureScopeNoticeDelivered(
        event.externalScopeId,
        this.i18n.t('runtime.error.weixinRateLimitedNotice'),
      );
    }
  }

  async runPostResponseAction(response: RuntimeResponse, event: InboundTextEvent): Promise<void> {
    const action = response?.meta?.systemAction ?? null;
    if (!action) {
      return;
    }
    if (action.kind === 'run_agent_sweep') {
      await this.runAutomationSweep();
      return;
    }
    if (action.kind === 'restart_bridge') {
      if (typeof this.bridgeCoordinator?.restartBridge !== 'function') {
        return;
      }
      await this.bridgeCoordinator.restartBridge({ event });
    }
  }

  buildAfterCommitAction(
    response: RuntimeResponse,
    event: InboundTextEvent,
  ): (() => Promise<void>) | null {
    const action = response?.meta?.systemAction ?? null;
    if (!action || !['restart_bridge', 'run_agent_sweep'].includes(String(action.kind ?? ''))) {
      return null;
    }
    return async () => {
      await this.runPostResponseAction(response, event);
    };
  }

  async enqueueScopeWork(
    externalScopeId: string,
    operation: () => Promise<RuntimeResponse>,
  ): Promise<RuntimeResponse> {
    const scopeId = String(externalScopeId ?? '');
    const previous = this.scopeChains.get(scopeId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.scopeChains.set(scopeId, next);
    try {
      return await next;
    } finally {
      if (this.scopeChains.get(scopeId) === next) {
        this.scopeChains.delete(scopeId);
      }
    }
  }

  trackBackgroundTask(task: Promise<RuntimeResponse>): void {
    this.backgroundTasks.add(task);
    task
      .catch(() => {})
      .finally(() => {
        this.backgroundTasks.delete(task);
      });
  }

  async notifyApprovalPrompt(event: InboundTextEvent): Promise<void> {
    try {
      const content = await this.buildApprovalPromptText(event);
      if (!content) {
        return;
      }
      let rateLimitedFailure = false;
      let delivery = await this.sendTextWithRetry({
        externalScopeId: event.externalScopeId,
        content,
      });
      rateLimitedFailure ||= this.isRateLimitedDeliveryFailure(delivery);
      if (delivery.success) {
        return;
      }
      debugRuntime('approval_prompt_delivery_failed', {
        scopeId: event.externalScopeId,
        failedText: truncateDebugText(delivery.failedText || content),
        error: delivery.error,
      });
      const fallback = this.i18n.t('coordinator.allow.promptFallback');
      if (!fallback || fallback === content) {
        throw new Error(delivery.error || this.i18n.t('runtime.error.unknownDeliveryFailure'));
      }
      delivery = await this.sendTextWithRetry({
        externalScopeId: event.externalScopeId,
        content: fallback,
      });
      rateLimitedFailure ||= this.isRateLimitedDeliveryFailure(delivery);
      if (delivery.success) {
        return;
      }
      debugRuntime('approval_prompt_fallback_failed', {
        scopeId: event.externalScopeId,
        failedText: truncateDebugText(delivery.failedText || fallback),
        error: delivery.error,
      });
      if (rateLimitedFailure) {
        await this.ensureScopeNoticeDelivered(
          event.externalScopeId,
          this.i18n.t('runtime.error.weixinRateLimitedApprovalNotice'),
        );
      }
      throw new Error(delivery.error || this.i18n.t('runtime.error.unknownDeliveryFailure'));
    } catch (error) {
      await this.onError(error);
    }
  }

  startAutomationScheduler(): void {
    if ((!this.automationJobs && !this.agentJobs && !this.assistantRecords) || this.automationPollMs <= 0) {
      return;
    }
    this.stopAutomationScheduler();
    void this.runAutomationSweep();
    this.automationSweepTimer = setInterval(() => {
      void this.runAutomationSweep();
    }, this.automationPollMs);
  }

  stopAutomationScheduler(): void {
    if (!this.automationSweepTimer) {
      return;
    }
    clearInterval(this.automationSweepTimer);
    this.automationSweepTimer = null;
  }

  async runAutomationSweep(): Promise<void> {
    if (!this.automationJobs && !this.agentJobs && !this.assistantRecords) {
      return;
    }
    if (this.automationSweepInFlight) {
      return this.automationSweepInFlight;
    }
    const task = this.runAutomationSweepInternal()
      .catch(async (error) => {
        await this.onError(error);
      })
      .finally(() => {
        if (this.automationSweepInFlight === task) {
          this.automationSweepInFlight = null;
        }
      });
    this.automationSweepInFlight = task;
    return task;
  }

  async runAutomationSweepInternal(): Promise<void> {
    const automationJobs = this.automationJobs?.claimDueJobs?.('weixin') ?? [];
    if (Array.isArray(automationJobs)) {
      for (const job of automationJobs) {
        const task = this.runAutomationJob(job);
        this.trackBackgroundTask(task);
      }
    }
    const agentJobs = this.agentJobs?.claimQueuedJobs?.('weixin') ?? [];
    if (!Array.isArray(agentJobs)) {
      return;
    }
    for (const job of agentJobs) {
      const task = this.runAgentJob(job);
      this.trackBackgroundTask(task);
    }
    const reminders = this.assistantRecords?.claimDueReminders?.('weixin') ?? [];
    if (Array.isArray(reminders)) {
      for (const reminder of reminders) {
        const task = this.deliverAssistantReminder(reminder);
        this.trackBackgroundTask(task);
      }
    }
  }

  async deliverAssistantReminder(record: any): Promise<RuntimeResponse> {
    const scopeId = String(record?.scopeId ?? '');
    if (!scopeId) {
      return { type: 'message', messages: [] };
    }
    const content = renderAssistantReminderMessage(record, this.i18n);
    if (!content) {
      return { type: 'message', messages: [] };
    }
    await this.sendTextWithRetry({
      externalScopeId: scopeId,
      content,
    });
    return { type: 'message', messages: [{ text: content }] };
  }

  async runAgentJob(job: any): Promise<RuntimeResponse> {
    const scopeId = String(job?.externalScopeId ?? '');
    if (!scopeId || await this.isScopeBusyForAgent(job)) {
      if (job?.id) {
        this.agentJobs?.updateJob?.(job.id, {
          status: 'queued',
          running: false,
        });
      }
      return {
        type: 'message',
        messages: [],
      };
    }
    if (typeof this.bridgeCoordinator?.runAgentJob !== 'function') {
      const error = 'Bridge coordinator does not support agent jobs.';
      if (job?.id) {
        this.agentJobs?.failJob?.(job.id, { error });
      }
      await this.sendTextWithRetry({
        externalScopeId: scopeId,
        content: this.i18n.t('runtime.error.agentFailed', {
          title: String(job?.title ?? 'agent'),
          error,
        }),
      });
      return {
        type: 'message',
        messages: [],
      };
    }
    const event: InboundTextEvent = {
      platform: String(job.platform ?? 'weixin'),
      externalScopeId: scopeId,
      text: `/agent job ${job.id}`,
      cwd: typeof job.cwd === 'string' ? job.cwd : null,
      locale: typeof job.locale === 'string' ? job.locale : null,
      metadata: {
        codexbridge: {
          agentJobId: job.id,
        },
      },
    };
    try {
      return await this.enqueueScopeWork(scopeId, async () => this.processAgentJobEvent(event, job));
    } catch (error) {
      const message = formatAutomationError(error);
      this.agentJobs?.failJob?.(job.id, {
        error: message,
      });
      await this.sendTextWithRetry({
        externalScopeId: scopeId,
        content: this.i18n.t('runtime.error.agentFailed', {
          title: String(job.title ?? 'agent'),
          error: message,
        }),
      });
      throw error;
    }
  }

  async processAgentJobEvent(event: InboundTextEvent, job: any): Promise<RuntimeResponse> {
    await this.flushPendingScopeNotice(event.externalScopeId);
    const streamState = createStreamState();
    const typingStart = this.safeSendTyping(event.externalScopeId, 'start');
    const stopTypingKeepalive = this.startTypingKeepalive(event.externalScopeId);
    try {
      const response = await this.bridgeCoordinator.runAgentJob?.(job, {
        onProgress: async (progress) => {
          await this.handleProgressUpdate(event, streamState, progress);
        },
        onApprovalRequest: async () => {
          await this.notifyApprovalPrompt(event);
        },
      }) ?? {
        type: 'message',
        messages: [],
      };
      if (response?.type !== 'message') {
        return response;
      }
      const codexTurnMeta = response?.meta?.codexTurn ?? null;
      const finalText = extractResponseMessageText(response);
      const artifactMessages = extractResponseArtifactMessages(response);
      if (normalizeComparableText(finalText) || codexTurnMeta) {
        await this.ensureFinalDelivered(event, streamState, response, codexTurnMeta);
      } else {
        await this.stopPreviewStreaming(streamState);
      }
      if (artifactMessages.length > 0) {
        await this.deliverArtifactMessages(event, artifactMessages);
      }
      return response;
    } finally {
      await typingStart;
      await stopTypingKeepalive();
    }
  }

  async runAutomationJob(job: any): Promise<RuntimeResponse> {
    const scopeId = String(job?.externalScopeId ?? '');
    if (!scopeId || await this.isScopeBusyForAutomation(job)) {
      this.automationJobs?.deferJob?.(job.id, Date.now() + 60_000);
      return {
        type: 'message',
        messages: [],
      };
    }

    const event: InboundTextEvent = {
      platform: String(job.platform ?? 'weixin'),
      externalScopeId: scopeId,
      text: String(job.prompt ?? '').trim(),
      cwd: typeof job.cwd === 'string' ? job.cwd : null,
      locale: typeof job.locale === 'string' ? job.locale : null,
      metadata: {
        codexbridge: {
          overrideBridgeSessionId: job.bridgeSessionId,
          automationJobId: job.id,
          automationMode: job.mode,
        },
      },
    };

    try {
      const response = await this.enqueueScopeWork(scopeId, async () => this.processInboundEventWithOptions(event, {
        deferPostResponseAction: false,
      }));
      const preview = buildAutomationResultPreview(response);
      this.automationJobs?.completeJob?.(job.id, {
        resultPreview: preview,
        error: null,
        deliveredAt: Date.now(),
      });
      return response;
    } catch (error) {
      const message = formatAutomationError(error);
      this.automationJobs?.completeJob?.(job.id, {
        resultPreview: null,
        error: message,
        deliveredAt: Date.now(),
      });
      await this.sendTextWithRetry({
        externalScopeId: scopeId,
        content: this.i18n.t('runtime.error.automationFailed', {
          title: String(job.title ?? 'automation'),
          error: message,
        }),
      });
      throw error;
    }
  }

  async isScopeBusyForAutomation(job: any): Promise<boolean> {
    const scopeId = String(job?.externalScopeId ?? '');
    if (!scopeId) {
      return true;
    }
    if (this.pendingInboundMerges.has(scopeId) || this.scopeChains.has(scopeId)) {
      return true;
    }
    const scopeRef = {
      platform: String(job?.platform ?? 'weixin'),
      externalScopeId: scopeId,
    };
    if (typeof (this.bridgeCoordinator as any)?.reconcileActiveTurn === 'function') {
      const activeTurn = await (this.bridgeCoordinator as any).reconcileActiveTurn(scopeRef);
      if (activeTurn) {
        return true;
      }
    }
    return false;
  }

  async isScopeBusyForAgent(job: any): Promise<boolean> {
    const scopeId = String(job?.externalScopeId ?? '');
    if (!scopeId) {
      return true;
    }
    if (this.pendingInboundMerges.has(scopeId) || this.scopeChains.has(scopeId)) {
      return true;
    }
    const scopeRef = {
      platform: String(job?.platform ?? 'weixin'),
      externalScopeId: scopeId,
    };
    if (typeof (this.bridgeCoordinator as any)?.reconcileActiveTurn === 'function') {
      const activeTurn = await (this.bridgeCoordinator as any).reconcileActiveTurn(scopeRef);
      if (activeTurn) {
        return true;
      }
    }
    return false;
  }

  async flushPendingScopeNotice(externalScopeId: string): Promise<void> {
    const scopeId = String(externalScopeId ?? '').trim();
    if (!scopeId) {
      return;
    }
    const pending = this.pendingScopeNotices.get(scopeId);
    if (!pending) {
      return;
    }
    if (this.shouldSuppressScopeNotice(scopeId, pending.content)) {
      this.pendingScopeNotices.delete(scopeId);
      return;
    }
    const delivery = await this.sendSystemTextDirect({
      externalScopeId: scopeId,
      content: pending.content,
    });
    if (!delivery.success) {
      debugRuntime('pending_scope_notice_failed', {
        scopeId,
        contentPreview: truncateDebugText(pending.content),
        error: delivery.error,
        errorCode: delivery.errorCode ?? null,
      });
      return;
    }
    this.pendingScopeNotices.delete(scopeId);
    this.noteScopeNoticeDelivered(scopeId, pending.content);
  }

  shouldSuppressScopeNotice(scopeId: string, content: string): boolean {
    const recent = this.recentScopeNotices.get(scopeId);
    if (!recent || recent.content !== content) {
      return false;
    }
    return (Date.now() - recent.sentAt) < WeixinBridgeRuntime.NOTICE_COOLDOWN_MS;
  }

  noteScopeNoticeDelivered(scopeId: string, content: string): void {
    this.recentScopeNotices.set(scopeId, {
      content,
      sentAt: Date.now(),
    });
  }

  async ensureScopeNoticeDelivered(externalScopeId: string, content: string): Promise<void> {
    const scopeId = String(externalScopeId ?? '').trim();
    const normalizedContent = String(content ?? '').trim();
    if (!scopeId || !normalizedContent) {
      return;
    }
    if (this.shouldSuppressScopeNotice(scopeId, normalizedContent)) {
      return;
    }
    const delivery = await this.sendSystemTextDirect({
      externalScopeId: scopeId,
      content: normalizedContent,
    });
    if (delivery.success) {
      this.pendingScopeNotices.delete(scopeId);
      this.noteScopeNoticeDelivered(scopeId, normalizedContent);
      return;
    }
    this.pendingScopeNotices.set(scopeId, {
      content: normalizedContent,
      queuedAt: Date.now(),
    });
    debugRuntime('scope_notice_queued', {
      scopeId,
      contentPreview: truncateDebugText(normalizedContent),
      error: delivery.error,
      errorCode: delivery.errorCode ?? null,
    });
  }

  isRateLimitedDeliveryFailure(detail: { error?: string | null; errorCode?: number | null } | null | undefined): boolean {
    const errorCode = typeof detail?.errorCode === 'number' ? detail.errorCode : null;
    if (errorCode === -2) {
      return true;
    }
    const message = String(detail?.error ?? '').trim();
    return /\b(?:ret|errcode)\b[^-\d]*-2\b/i.test(message)
      || /:\s*-2\b/.test(message);
  }

  describeDeliveryFailure(
    detail: { error?: string | null; errorCode?: number | null } | null | undefined,
    fallback: string,
  ): string {
    if (this.isRateLimitedDeliveryFailure(detail)) {
      return this.i18n.t('runtime.error.weixinRateLimited');
    }
    return String(
      detail?.error
      || fallback
      || this.i18n.t('runtime.error.unknownDeliveryFailure'),
    ).trim();
  }

  async buildApprovalPromptText(event: InboundTextEvent): Promise<string> {
    const compactPrompt = typeof this.bridgeCoordinator.renderApprovalPrompt === 'function'
      ? await this.bridgeCoordinator.renderApprovalPrompt(event)
      : '';
    if (String(compactPrompt ?? '').trim()) {
      return String(compactPrompt).trim();
    }
    const response = await this.bridgeCoordinator.handleInboundEvent({
      ...event,
      text: '/allow',
    }, {});
    return extractResponseMessageText(response);
  }
}

function createStreamState(): StreamState {
  return {
    lastObservedFinal: '',
    pendingPreview: '',
    previewPumpPromise: null,
    previewStopped: false,
    firstPreviewSent: false,
    nextPreviewAt: 0,
    streamedText: '',
    sentChunkCount: 0,
    streamingDisabled: false,
  };
}

function extractResponseMessageText(response: RuntimeResponse): string {
  return Array.isArray(response?.messages)
    ? response.messages
      .filter((message) => !String(message?.artifact?.path ?? message?.mediaPath ?? '').trim())
      .map((message) => String(message?.text ?? '').trim())
      .filter(Boolean)
      .join('\n\n')
      .trim()
    : '';
}

function extractResponseArtifactMessages(response: RuntimeResponse): OutputArtifact[] {
  if (!Array.isArray(response?.messages)) {
    return [];
  }
  return response.messages
    .map((message) => normalizeResponseArtifact(message))
    .filter(Boolean) as OutputArtifact[];
}

function buildAutomationResultPreview(response: RuntimeResponse): string | null {
  const finalText = extractResponseMessageText(response);
  if (finalText) {
    return truncateDebugText(finalText, 160) || finalText.slice(0, 160);
  }
  const artifacts = extractResponseArtifactMessages(response);
  if (artifacts.length > 0) {
    const first = artifacts[0];
    return `${first.kind}: ${first.displayName ?? first.path}`;
  }
  return null;
}

function formatAutomationError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? 'unknown error');
}

function normalizeResponseArtifact(message: RuntimeResponseMessage): OutputArtifact | null {
  const direct = message?.artifact && typeof message.artifact === 'object'
    ? message.artifact
    : null;
  const artifactPath = String(direct?.path ?? message?.mediaPath ?? '').trim();
  if (!artifactPath) {
    return null;
  }
  return {
    kind: direct?.kind ?? inferRuntimeArtifactKind(artifactPath),
    path: artifactPath,
    displayName: direct?.displayName ?? null,
    mimeType: direct?.mimeType ?? null,
    sizeBytes: direct?.sizeBytes ?? null,
    caption: typeof message?.caption === 'string' ? message.caption : (direct?.caption ?? null),
    source: direct?.source ?? 'provider_native',
    turnId: direct?.turnId ?? null,
  };
}

function inferRuntimeArtifactKind(filePath: string): OutputArtifact['kind'] {
  const normalized = String(filePath ?? '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp)(?:$|\?)/iu.test(normalized)) {
    return 'image';
  }
  if (/\.(mp4|mov|mkv|webm)(?:$|\?)/iu.test(normalized)) {
    return 'video';
  }
  if (/\.(mp3|wav|ogg|m4a|flac|amr)(?:$|\?)/iu.test(normalized)) {
    return 'audio';
  }
  return 'file';
}

function resolveFinalCommitContent(finalText: string, previewText: string): string {
  const finalContent = String(finalText ?? '').trim();
  const previewContent = String(previewText ?? '').trim();
  if (!previewContent) {
    return finalContent;
  }
  if (finalContent.startsWith(previewContent)) {
    const trailing = finalContent.slice(previewContent.length).trim();
    return trailing || '';
  }
  return finalContent;
}

function isComparablePrefix(prefixText: string, fullText: string): boolean {
  const prefix = normalizeComparableText(prefixText);
  const full = normalizeComparableText(fullText);
  if (!prefix) {
    return false;
  }
  return full.startsWith(prefix);
}

function appendPreviewText(streamState: StreamState, chunk: string): void {
  streamState.sentChunkCount += 1;
  streamState.streamedText = streamState.streamedText
    ? `${streamState.streamedText}\n\n${chunk}`
    : chunk;
}

function extractImmediatePreviewChunk(text: string, hardLimitBytes: number): string {
  const boundary = findSentenceBoundary(text, hardLimitBytes);
  if (boundary > 0) {
    return text.slice(0, boundary);
  }
  return '';
}

function extractTimedPreviewChunk(text: string, softTargetBytes: number): string {
  const bytes = utf8ByteLength(text);
  if (bytes <= 0) {
    return '';
  }
  if (bytes <= softTargetBytes) {
    return text;
  }
  return sliceByUtf8Bytes(text, softTargetBytes);
}

function findSentenceBoundary(text: string, byteLimit: number): number {
  let sentenceBoundary = -1;
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    bytes += utf8ByteLength(text[index]);
    if (bytes > byteLimit) {
      break;
    }
    if (text[index] === '\n' && text[index + 1] === '\n') {
      return index + 2;
    }
    if ('。！？.!?；;'.includes(text[index])) {
      sentenceBoundary = index + 1;
      break;
    }
  }
  return sentenceBoundary;
}

function sliceByUtf8Bytes(text: string, byteLimit: number): string {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const next = utf8ByteLength(text[index]);
    if (bytes + next > byteLimit) {
      break;
    }
    bytes += next;
    index += 1;
  }
  return text.slice(0, index);
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

function debugRuntime(event, payload) {
  writeSequencedDebugLog('weixin-runtime', event, payload, { envVar: null });
}

function truncateDebugText(value, limit = 240) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (!text) {
    return '';
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createPendingInboundMerge(event: InboundTextEvent): PendingInboundMerge {
  let resolve: (response: RuntimeResponse) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const completion = new Promise<RuntimeResponse>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    event,
    timer: null,
    completion,
    resolve,
    reject,
  };
}

function shouldScheduleSlashCommand(command: { name?: string | null; args?: string[] | null } | null | undefined): boolean {
  const name = String(command?.name ?? '').trim().toLowerCase();
  if (!name || !['review', 'rv'].includes(name)) {
    return false;
  }
  const args = Array.isArray(command?.args) ? command.args : [];
  return !args.some((arg) => ['-h', '--help', '-help', '-helps'].includes(String(arg ?? '').trim().toLowerCase()));
}

function shouldDelayInboundEvent(event: InboundTextEvent): boolean {
  return !parseSlashCommand(String(event?.text ?? ''))
    && hasAttachments(event)
    && !String(event?.text ?? '').trim();
}

function hasAttachments(event: InboundTextEvent | null | undefined): boolean {
  return Array.isArray(event?.attachments) && event.attachments.length > 0;
}

function mergeInboundEvents(baseEvent: InboundTextEvent, nextEvent: InboundTextEvent): InboundTextEvent {
  return {
    ...baseEvent,
    ...nextEvent,
    text: combineEventText(baseEvent.text, nextEvent.text),
    attachments: [
      ...(Array.isArray(baseEvent.attachments) ? baseEvent.attachments : []),
      ...(Array.isArray(nextEvent.attachments) ? nextEvent.attachments : []),
    ],
    cwd: nextEvent.cwd ?? baseEvent.cwd ?? null,
    locale: nextEvent.locale ?? baseEvent.locale ?? null,
    metadata: mergeEventMetadata(baseEvent.metadata, nextEvent.metadata),
  };
}

function combineEventText(baseText: string, nextText: string): string {
  const current = String(baseText ?? '').trim();
  const incoming = String(nextText ?? '').trim();
  if (!current) {
    return incoming;
  }
  if (!incoming) {
    return current;
  }
  return `${current}\n\n${incoming}`;
}

function mergeEventMetadata(
  baseMetadata: Record<string, unknown> | undefined,
  nextMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!baseMetadata && !nextMetadata) {
    return undefined;
  }
  const merged = {
    ...(baseMetadata ?? {}),
    ...(nextMetadata ?? {}),
  } as Record<string, unknown>;
  const baseWeixin = isRecord(baseMetadata?.weixin) ? baseMetadata?.weixin : null;
  const nextWeixin = isRecord(nextMetadata?.weixin) ? nextMetadata?.weixin : null;
  if (baseWeixin || nextWeixin) {
    const weixin = {
      ...(baseWeixin ?? {}),
      ...(nextWeixin ?? {}),
    } as Record<string, unknown>;
    const attachmentCount = Number(baseWeixin?.attachmentCount ?? 0) + Number(nextWeixin?.attachmentCount ?? 0);
    if (attachmentCount > 0) {
      weixin.attachmentCount = attachmentCount;
    }
    const attachmentErrors = [
      ...extractStringArray(baseWeixin?.attachmentErrors),
      ...extractStringArray(nextWeixin?.attachmentErrors),
    ];
    if (attachmentErrors.length > 0) {
      weixin.attachmentErrors = attachmentErrors;
    }
    merged.weixin = weixin;
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

function renderAssistantReminderMessage(record: any, i18n: Translator): string {
  const title = String(record?.title ?? '').trim() || i18n.t('runtime.assistant.untitledReminder');
  const content = String(record?.content ?? '').trim();
  const lines = [
    i18n.t('runtime.assistant.reminderTitle', { title }),
  ];
  if (content && content !== title) {
    lines.push(content);
  }
  if (Array.isArray(record?.attachments) && record.attachments.length > 0) {
    lines.push(i18n.t('runtime.assistant.attachmentCount', { count: record.attachments.length }));
    for (const attachment of record.attachments.slice(0, 3)) {
      const storagePath = String(attachment?.storagePath ?? '').trim();
      if (storagePath) {
        lines.push(storagePath);
      }
    }
  }
  lines.push(i18n.t('runtime.assistant.reminderActions'));
  return lines.join('\n');
}

function extractCompletionPromise(outcome: any): Promise<void> | null {
  const completion = outcome?.completion;
  if (!completion || typeof completion.then !== 'function') {
    return null;
  }
  return Promise.resolve(completion).then(() => {});
}

function extractAfterCommitAction(outcome: any): (() => Promise<void> | void) | null {
  if (!outcome || typeof outcome.afterCommit !== 'function') {
    return null;
  }
  return outcome.afterCommit;
}

function normalizeComparableText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
