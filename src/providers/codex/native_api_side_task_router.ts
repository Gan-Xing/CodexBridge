import { CodexNativeRuntime } from './native_runtime.js';
import type { BridgeSession } from '../../types/core.js';
import type { InboundTextEvent } from '../../types/platform.js';
import type {
  ProviderPluginContract,
  ProviderProfile,
  ProviderTurnResult,
} from '../../types/provider.js';

export type CodexNativeApiSideTaskClass =
  | 'intent_classification'
  | 'normalization'
  | 'small_verification'
  | 'side_reasoning';

export type CodexNativeApiSideTaskRoute = 'native_api' | 'direct_native';

export interface CodexNativeApiSideTaskRouterOptions {
  runtime?: CodexNativeRuntime;
  baseUrl?: string | null;
  authToken?: string | null;
  enabledTaskClasses?: CodexNativeApiSideTaskClass[] | null;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface CodexNativeApiSideTaskRequest {
  taskClass: CodexNativeApiSideTaskClass;
  providerProfile: ProviderProfile;
  providerPlugin: ProviderPluginContract;
  cwd?: string | null;
  title: string;
  sessionMetadata?: Record<string, unknown>;
  model?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  locale?: string | null;
  inputText: string;
  event: InboundTextEvent;
}

export interface CodexNativeApiSideTaskExecutionResult {
  route: CodexNativeApiSideTaskRoute;
  responseId: string | null;
  session: BridgeSession | null;
  result: ProviderTurnResult;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 1500;
const ALL_TASK_CLASSES = new Set<CodexNativeApiSideTaskClass>([
  'intent_classification',
  'normalization',
  'small_verification',
  'side_reasoning',
]);

export class CodexNativeApiSideTaskRouter {
  private readonly runtime: CodexNativeRuntime;

  private readonly baseUrl: string | null;

  private readonly authToken: string | null;

  private readonly enabledTaskClasses: Set<CodexNativeApiSideTaskClass>;

  private readonly requestTimeoutMs: number;

  private readonly fetchImpl: typeof fetch;

  constructor({
    runtime = new CodexNativeRuntime(),
    baseUrl = null,
    authToken = null,
    enabledTaskClasses = null,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    fetchImpl = fetch,
  }: CodexNativeApiSideTaskRouterOptions = {}) {
    this.runtime = runtime;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.authToken = normalizeString(authToken) || null;
    this.enabledTaskClasses = normalizeTaskClassSet(enabledTaskClasses);
    this.requestTimeoutMs = Number.isFinite(requestTimeoutMs) && Number(requestTimeoutMs) > 0
      ? Number(requestTimeoutMs)
      : DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = fetchImpl;
  }

  async execute(
    request: CodexNativeApiSideTaskRequest,
  ): Promise<CodexNativeApiSideTaskExecutionResult> {
    if (this.shouldUseNativeApi(request.taskClass)) {
      const nativeApiResult = await this.tryExecuteViaNativeApi(request);
      if (nativeApiResult) {
        return nativeApiResult;
      }
    }
    return this.executeDirect(request);
  }

  private shouldUseNativeApi(taskClass: CodexNativeApiSideTaskClass): boolean {
    return Boolean(this.baseUrl) && this.enabledTaskClasses.has(taskClass);
  }

  private async tryExecuteViaNativeApi(
    request: CodexNativeApiSideTaskRequest,
  ): Promise<CodexNativeApiSideTaskExecutionResult | null> {
    const baseUrl = this.baseUrl;
    if (!baseUrl) {
      return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: omitUndefined({
          'Content-Type': 'application/json',
          Authorization: this.authToken ? `Bearer ${this.authToken}` : undefined,
        }),
        body: JSON.stringify(buildNativeApiRequestBody(request)),
        signal: controller.signal,
      });
      const body = await readJsonResponse(response);
      if (!response.ok) {
        if (shouldFallbackToDirectNative(response.status, body)) {
          return null;
        }
        throw new Error(readErrorMessage(body) || `Codex native API side-task request failed with status ${response.status}.`);
      }
      const outputText = extractResponseOutputText(body);
      if (!outputText) {
        throw new Error('Codex native API side-task response returned no output text.');
      }
      return {
        route: 'native_api',
        responseId: normalizeNullableString(body?.id),
        session: extractBridgeSession(body),
        result: {
          outputText,
          previewText: '',
          outputState: normalizeNullableString(body?.status) === 'completed' ? 'complete' : 'incomplete',
          finalSource: 'thread_items',
          errorMessage: null,
          turnId: normalizeNullableString(body?.native_runtime?.turn_id),
          threadId: normalizeNullableString(body?.native_runtime?.thread_id),
          title: null,
          status: normalizeNullableString(body?.status),
          outputArtifacts: [],
          outputMedia: [],
        },
      };
    } catch (error) {
      if (isNativeApiFallbackError(error)) {
        return null;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async executeDirect(
    request: CodexNativeApiSideTaskRequest,
  ): Promise<CodexNativeApiSideTaskExecutionResult> {
    const execution = await this.runtime.runIsolatedTurn({
      providerProfile: request.providerProfile,
      providerPlugin: request.providerPlugin,
      cwd: request.cwd,
      title: request.title,
      metadata: request.sessionMetadata ?? {},
      model: request.model ?? null,
      reasoningEffort: request.reasoningEffort ?? null,
      serviceTier: request.serviceTier ?? null,
      prepareTurn: (session) => ({
        inputText: request.inputText,
        locale: request.locale ?? request.event.locale ?? null,
        event: {
          ...request.event,
          cwd: session.cwd ?? request.event.cwd ?? null,
          locale: request.locale ?? request.event.locale ?? null,
          attachments: Array.isArray(request.event.attachments) ? request.event.attachments : [],
        },
      }),
    });
    return {
      route: 'direct_native',
      responseId: null,
      session: execution.session,
      result: execution.result,
    };
  }
}

function buildNativeApiRequestBody(request: CodexNativeApiSideTaskRequest): Record<string, unknown> {
  const eventCodexbridgeMetadata = extractCodexbridgeMetadata(request.event);
  const metadata = omitUndefined({
    cwd: normalizeNullableString(request.cwd),
    locale: normalizeNullableString(request.locale ?? request.event.locale),
    codexbridge: omitUndefined({
      taskClass: request.taskClass,
      eventMetadata: eventCodexbridgeMetadata ?? undefined,
      threadMetadata: request.sessionMetadata && Object.keys(request.sessionMetadata).length > 0
        ? request.sessionMetadata
        : undefined,
    }),
  });
  return omitUndefined({
    model: normalizeNullableString(request.model),
    input: request.inputText,
    reasoning: request.reasoningEffort ? { effort: request.reasoningEffort } : undefined,
    service_tier: normalizeNullableString(request.serviceTier),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  });
}

function extractCodexbridgeMetadata(event: InboundTextEvent): Record<string, unknown> | null {
  const metadata = event?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const codexbridge = (metadata as Record<string, unknown>).codexbridge;
  if (!codexbridge || typeof codexbridge !== 'object' || Array.isArray(codexbridge)) {
    return null;
  }
  return codexbridge as Record<string, unknown>;
}

async function readJsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {
      error: {
        message: text.trim(),
      },
    };
  }
}

function extractResponseOutputText(body: any): string {
  const output = Array.isArray(body?.output) ? body.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const text = normalizeString(part?.text);
      if (text) {
        return text;
      }
    }
  }
  return '';
}

function extractBridgeSession(body: any): BridgeSession | null {
  const bridgeSessionId = normalizeNullableString(body?.native_runtime?.bridge_session_id);
  const providerProfileId = normalizeNullableString(body?.native_runtime?.provider_profile_id);
  const threadId = normalizeNullableString(body?.native_runtime?.thread_id);
  if (!bridgeSessionId || !providerProfileId || !threadId) {
    return null;
  }
  const now = Date.now();
  return {
    id: bridgeSessionId,
    providerProfileId,
    codexThreadId: threadId,
    cwd: normalizeNullableString(body?.metadata?.cwd),
    title: null,
    createdAt: now,
    updatedAt: now,
  };
}

function shouldFallbackToDirectNative(status: number, body: any): boolean {
  if (status === 401 || status === 403 || status === 404 || status === 408 || status === 429) {
    return true;
  }
  if (status >= 500) {
    return true;
  }
  const errorCode = normalizeString(body?.error?.code);
  return errorCode === 'native_runtime_unavailable';
}

function readErrorMessage(body: any): string | null {
  const message = normalizeString(body?.error?.message);
  return message || null;
}

function isNativeApiFallbackError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.trim();
  return message.includes('fetch failed')
    || message.includes('ECONNREFUSED')
    || message.includes('ENOTFOUND')
    || message.includes('EHOSTUNREACH')
    || message.includes('ETIMEDOUT');
}

function normalizeTaskClassSet(
  values: CodexNativeApiSideTaskRouterOptions['enabledTaskClasses'],
): Set<CodexNativeApiSideTaskClass> {
  if (!Array.isArray(values) || values.length === 0) {
    return new Set(ALL_TASK_CLASSES);
  }
  const normalized = values.filter((value): value is CodexNativeApiSideTaskClass => ALL_TASK_CLASSES.has(value));
  return normalized.length > 0 ? new Set(normalized) : new Set(ALL_TASK_CLASSES);
}

function normalizeBaseUrl(value: unknown): string | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  const withoutTrailingSlash = normalized.replace(/\/+$/, '');
  return withoutTrailingSlash.endsWith('/v1')
    ? withoutTrailingSlash.slice(0, -3)
    : withoutTrailingSlash;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNullableString(value: unknown): string | null {
  const normalized = normalizeString(value);
  return normalized || null;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
