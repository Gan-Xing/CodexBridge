import { WeixinPoller } from '../platforms/weixin/poller.js';

export class WeixinBridgeRuntime {
  constructor({
    platformPlugin,
    bridgeCoordinator,
    onError = async () => {},
    previewSoftTargetBytes = 600,
    previewHardLimitBytes = 2048,
    previewIntervalMs = 3000,
  }) {
    this.platformPlugin = platformPlugin;
    this.bridgeCoordinator = bridgeCoordinator;
    this.onError = onError;
    this.previewSoftTargetBytes = previewSoftTargetBytes;
    this.previewHardLimitBytes = previewHardLimitBytes;
    this.previewIntervalMs = previewIntervalMs;
    this.poller = null;
    this.scopeChains = new Map();
  }

  async start() {
    await this.platformPlugin.start();
    this.poller = new WeixinPoller({
      plugin: this.platformPlugin,
      onEvent: async (event) => {
        await this.handleInboundEvent(event);
      },
      onError: async (error) => {
        await this.onError(error);
      },
    });
    return this.poller.start();
  }

  async stop() {
    this.poller?.stop();
    this.poller = null;
    await this.platformPlugin.stop();
  }

  async runOnce() {
    const result = await this.platformPlugin.pollOnce();
    for (const event of result.events) {
      await this.handleInboundEvent(event);
    }
    return result;
  }

  async handleInboundEvent(event) {
    return this.enqueueScopeWork(event.externalScopeId, async () => this.processInboundEvent(event));
  }

  async processInboundEvent(event) {
    const streamState = createStreamState();
    await this.safeSendTyping(event.externalScopeId, 'start');
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
          ? response.messages.map((message) => truncateDebugText(message?.text))
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
      await this.runPostResponseAction(response, event);
      return response;
    } finally {
      await this.safeSendTyping(event.externalScopeId, 'stop');
    }
  }

  async handleProgressUpdate(event, streamState, progress) {
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

  ensurePreviewPump(event, streamState) {
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

  async runPreviewPump(event, streamState) {
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

  async sendPreviewChunk(event, streamState, chunk) {
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

  async stopPreviewStreaming(streamState) {
    streamState.previewStopped = true;
    streamState.pendingPreview = '';
    const pump = streamState.previewPumpPromise;
    if (pump) {
      await pump;
    }
  }

  async ensureFinalDelivered(event, streamState, response, codexTurnMeta) {
    await this.stopPreviewStreaming(streamState);

    const outputState = codexTurnMeta?.outputState ?? 'complete';
    const errorMessage = String(codexTurnMeta?.errorMessage ?? '').trim();
    const finalText = extractResponseMessageText(response);
    const normalizedFinal = normalizeComparableText(finalText);
    if (outputState !== 'complete') {
      const failureMessage = errorMessage
        ? `Codex 错误：${errorMessage}`
        : outputState === 'interrupted'
          ? '本轮回复已在 Codex 侧中断，请重试或继续。'
          : outputState === 'timeout'
            ? '本轮回复等待 Codex 超时，请重试。'
            : outputState === 'stale_session'
              ? '当前绑定的 Codex 会话已不可恢复。请使用 /open 重新绑定，或用 /new 新建。'
              : '本轮回复未完整取回，请重试。';
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
      throw new Error(`WeixinBridgeRuntime could not resolve final text for ${event.externalScopeId}`);
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
      await sleep(Math.min(8000, 1000 * (2 ** attempt)));
    }

    return {
      source: codexTurnMeta?.finalSource ?? 'thread_items',
      mode: 'final_delivery_incomplete',
      finalText,
      sentContent: lastAttemptedContent,
    };
  }

  async safeSendTyping(externalScopeId, status) {
    if (typeof this.platformPlugin.sendTyping !== 'function') {
      return;
    }
    try {
      await this.platformPlugin.sendTyping({ externalScopeId, status });
    } catch {
      // Ignore WeChat typing failures; progress delivery matters more than presence.
    }
  }

  async sendTextWithRetry({ externalScopeId, content }) {
    const result = await this.platformPlugin.sendText({ externalScopeId, content });
    return result ?? {
      success: false,
      deliveredCount: 0,
      deliveredText: '',
      failedIndex: 0,
      failedText: String(content ?? '').trim(),
      error: 'Unknown Weixin delivery failure',
    };
  }

  async runPostResponseAction(response, event) {
    const action = response?.meta?.systemAction ?? null;
    if (!action || action.kind !== 'restart_bridge') {
      return;
    }
    if (typeof this.bridgeCoordinator?.restartBridge !== 'function') {
      return;
    }
    await this.bridgeCoordinator.restartBridge({ event });
  }

  async enqueueScopeWork(externalScopeId, operation) {
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
}

function createStreamState() {
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

function extractResponseMessageText(response) {
  return Array.isArray(response?.messages)
    ? response.messages
      .map((message) => String(message?.text ?? '').trim())
      .filter(Boolean)
      .join('\n\n')
      .trim()
    : '';
}

function resolveFinalCommitContent(finalText, previewText) {
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

function isComparablePrefix(prefixText, fullText) {
  const prefix = normalizeComparableText(prefixText);
  const full = normalizeComparableText(fullText);
  if (!prefix) {
    return false;
  }
  return full.startsWith(prefix);
}

function appendPreviewText(streamState, chunk) {
  streamState.sentChunkCount += 1;
  streamState.streamedText = streamState.streamedText
    ? `${streamState.streamedText}\n\n${chunk}`
    : chunk;
}

function extractImmediatePreviewChunk(text, hardLimitBytes) {
  const boundary = findSentenceBoundary(text, hardLimitBytes);
  if (boundary > 0) {
    return text.slice(0, boundary);
  }
  return '';
}

function extractTimedPreviewChunk(text, softTargetBytes) {
  const bytes = utf8ByteLength(text);
  if (bytes <= 0) {
    return '';
  }
  if (bytes <= softTargetBytes) {
    return text;
  }
  return sliceByUtf8Bytes(text, softTargetBytes);
}

function findSentenceBoundary(text, byteLimit) {
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

function sliceByUtf8Bytes(text, byteLimit) {
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

function utf8ByteLength(text) {
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
