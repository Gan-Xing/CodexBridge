import { parseSlashCommand } from '../core/command_parser.js';
import { WeixinPoller } from '../platforms/weixin/poller.js';
import { createI18n, type Translator } from '../i18n/index.js';
import type {
  InboundTextEvent,
  PlatformMediaDeliveryResult,
} from '../types/platform.js';
import type { ProviderTurnProgress } from '../types/provider.js';

interface DeliveryResult {
  success: boolean;
  deliveredCount: number;
  deliveredText: string;
  failedIndex: number | null;
  failedText: string;
  error: string;
}

interface RuntimeResponseMessage {
  text?: string | null;
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
    options: { onProgress?: ((progress: ProviderTurnProgress) => Promise<void>) | null },
  ): Promise<RuntimeResponse>;
  restartBridge?(params: { event: InboundTextEvent }): Promise<void>;
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

interface WeixinBridgeRuntimeOptions {
  platformPlugin: PlatformPluginLike;
  bridgeCoordinator: BridgeCoordinatorLike;
  onError?: (error: unknown) => Promise<void> | void;
  previewSoftTargetBytes?: number;
  previewHardLimitBytes?: number;
  previewIntervalMs?: number;
  locale?: string | null;
}

export class WeixinBridgeRuntime {
  platformPlugin: PlatformPluginLike;

  bridgeCoordinator: BridgeCoordinatorLike;

  onError: (error: unknown) => Promise<void> | void;

  previewSoftTargetBytes: number;

  previewHardLimitBytes: number;

  previewIntervalMs: number;

  i18n: Translator;

  poller: WeixinPoller | null;

  backgroundTasks: Set<Promise<RuntimeResponse>>;

  scopeChains: Map<string, Promise<RuntimeResponse>>;

  constructor({
    platformPlugin,
    bridgeCoordinator,
    onError = async () => {},
    previewSoftTargetBytes = 2048,
    previewHardLimitBytes = 2048,
    previewIntervalMs = 3000,
    locale = null,
  }) {
    this.platformPlugin = platformPlugin;
    this.bridgeCoordinator = bridgeCoordinator;
    this.onError = onError;
    this.previewSoftTargetBytes = previewSoftTargetBytes;
    this.previewHardLimitBytes = previewHardLimitBytes;
    this.previewIntervalMs = previewIntervalMs;
    this.i18n = createI18n(locale);
    this.poller = null;
    this.backgroundTasks = new Set();
    this.scopeChains = new Map();
  }

  async start(): Promise<void> {
    await this.platformPlugin.start();
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
    await this.waitForIdle();
    await this.platformPlugin.stop();
  }

  async runOnce(): Promise<{ syncCursor?: string | null; events: InboundTextEvent[] }> {
    const result = await this.platformPlugin.pollOnce();
    for (const event of result.events) {
      await this.handleInboundEvent(event);
    }
    await this.platformPlugin.commitSyncCursor?.(result.syncCursor);
    return result;
  }

  async handleInboundEvent(event: InboundTextEvent): Promise<RuntimeResponse> {
    return this.enqueueScopeWork(event.externalScopeId, async () => this.processInboundEvent(event));
  }

  async dispatchInboundEvent(event: InboundTextEvent): Promise<any> {
    const command = parseSlashCommand(String(event?.text ?? ''));
    if (command) {
      const response = await this.processInboundEventWithOptions(event, { deferPostResponseAction: true });
      const afterCommit = this.buildAfterCommitAction(response, event);
      return afterCommit ? { afterCommit } : undefined;
    }
    const task = this.processInboundEvent(event)
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
    const tasks = [...this.backgroundTasks];
    if (tasks.length === 0) {
      return;
    }
    await Promise.allSettled(tasks);
  }

  async processInboundEvent(event: InboundTextEvent): Promise<RuntimeResponse> {
    return this.processInboundEventWithOptions(event, { deferPostResponseAction: false });
  }

  async processInboundEventWithOptions(
    event: InboundTextEvent,
    options: { deferPostResponseAction?: boolean } = {},
  ): Promise<RuntimeResponse> {
    const streamState = createStreamState();
    const typingStart = this.safeSendTyping(event.externalScopeId, 'start');
    try {
      const response = await this.bridgeCoordinator.handleInboundEvent(event, {
        onProgress: async (progress) => {
          await this.handleProgressUpdate(event, streamState, progress);
        },
      });
      debugRuntime('coordinator_response', {
        scopeId: event.externalScopeId,
        type: response?.type ?? null,
        messageCount: Array.isArray(response?.messages) ? response.messages.length : null,
        messages: Array.isArray(response?.messages)
          ? response.messages.map((message) => ({
            text: truncateDebugText(message?.text),
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
      const mediaMessages = extractResponseMediaMessages(response);
      if (normalizeComparableText(finalText) || codexTurnMeta) {
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
      if (mediaMessages.length > 0) {
        await this.deliverMediaMessages(event, mediaMessages);
      }
      if (!options.deferPostResponseAction) {
        await this.runPostResponseAction(response, event);
      }
      return response;
    } finally {
      await typingStart;
      await this.safeSendTyping(event.externalScopeId, 'stop');
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
    const normalizedFinal = normalizeComparableText(finalText);
    if (outputState !== 'complete') {
      const failureMessage = errorMessage
        ? this.i18n.t('runtime.error.codex', { error: errorMessage })
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
    }

    return {
      source: codexTurnMeta?.finalSource ?? 'thread_items',
      mode: 'final_delivery_incomplete',
      finalText,
      sentContent: lastAttemptedContent,
    };
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

  async sendTextWithRetry({
    externalScopeId,
    content,
  }: {
    externalScopeId: string;
    content: string;
  }): Promise<DeliveryResult> {
    const result = await this.platformPlugin.sendText({ externalScopeId, content });
    return result ?? {
      success: false,
      deliveredCount: 0,
      deliveredText: '',
      failedIndex: 0,
      failedText: String(content ?? '').trim(),
      error: this.i18n.t('runtime.error.unknownDeliveryFailure'),
    };
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
    const result = await this.platformPlugin.sendMedia({
      externalScopeId,
      filePath,
      caption,
    });
    return result ?? {
      success: false,
      messageId: null,
      sentPath: String(filePath ?? ''),
      sentCaption: String(caption ?? '').trim(),
      error: this.i18n.t('runtime.error.unknownDeliveryFailure'),
    };
  }

  async deliverMediaMessages(
    event: InboundTextEvent,
    messages: Array<{ mediaPath: string; caption?: string | null }>,
  ): Promise<void> {
    for (const message of messages) {
      const result = await this.sendMediaWithRetry({
        externalScopeId: event.externalScopeId,
        filePath: message.mediaPath,
        caption: message.caption ?? null,
      });
      if (!result.success) {
        throw new Error(`media delivery failed: ${result.error || result.sentPath}`);
      }
    }
  }

  async runPostResponseAction(response: RuntimeResponse, event: InboundTextEvent): Promise<void> {
    const action = response?.meta?.systemAction ?? null;
    if (!action || action.kind !== 'restart_bridge') {
      return;
    }
    if (typeof this.bridgeCoordinator?.restartBridge !== 'function') {
      return;
    }
    await this.bridgeCoordinator.restartBridge({ event });
  }

  buildAfterCommitAction(
    response: RuntimeResponse,
    event: InboundTextEvent,
  ): (() => Promise<void>) | null {
    const action = response?.meta?.systemAction ?? null;
    if (!action || action.kind !== 'restart_bridge') {
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
      .filter((message) => !String(message?.mediaPath ?? '').trim())
      .map((message) => String(message?.text ?? '').trim())
      .filter(Boolean)
      .join('\n\n')
      .trim()
    : '';
}

function extractResponseMediaMessages(response: RuntimeResponse): Array<{ mediaPath: string; caption?: string | null }> {
  if (!Array.isArray(response?.messages)) {
    return [];
  }
  return response.messages
    .map((message) => ({
      mediaPath: String(message?.mediaPath ?? '').trim(),
      caption: typeof message?.caption === 'string' ? message.caption : null,
    }))
    .filter((message) => Boolean(message.mediaPath));
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
  try {
    const serialized = JSON.stringify(payload);
    console.error(`[weixin-runtime] ${event} ${serialized}`);
  } catch {
    console.error(`[weixin-runtime] ${event}`);
  }
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

function normalizeComparableText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
