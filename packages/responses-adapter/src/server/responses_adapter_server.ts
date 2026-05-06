import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import {
  chatCompletionsResponseToResponses,
  responsesRequestToCompactionResponse,
  responsesRequestToChatCompletions,
  translateChatCompletionsSseStreamToResponsesSse,
} from '../converters/responses_adapter.js';
import type {
  OpenAICompatibleProviderCapabilities,
  OpenAICompatibleRetryCapabilities,
} from '../capabilities/thinking_policy.js';

type JsonRecord = Record<string, any>;

export interface OpenAICompatibleResponsesAdapterServerOptions {
  apiKey: string;
  upstreamBaseUrl?: string | null;
  defaultModel?: string | null;
  models?: Array<Record<string, any> & { id?: string; model?: string; slug?: string; object?: string; created?: number; owned_by?: string }>;
  fetchImpl?: typeof fetch;
  host?: string;
  port?: number;
  providerKind?: string | null;
  providerName?: string | null;
  providerCapabilities?: OpenAICompatibleProviderCapabilities | null;
  upstreamChatCompletionsPath?: string | null;
  ownedBy?: string | null;
}

const DEFAULT_UPSTREAM_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-5.4';
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_RETRY_STATUSES = [403, 408, 429, 500, 502, 503, 504];

export class OpenAICompatibleResponsesAdapterServer {
  private readonly apiKey: string;

  private readonly upstreamBaseUrl: string;

  private readonly defaultModel: string;

  private readonly models: Array<{ id: string; slug: string; object: string; created: number; owned_by: string }>;

  private readonly fetchImpl: typeof fetch;

  private readonly host: string;

  private readonly requestedPort: number;

  private readonly providerKind: string;

  private readonly providerName: string;

  private readonly providerCapabilities: OpenAICompatibleProviderCapabilities | null;

  private readonly upstreamChatCompletionsPath: string;

  private readonly ownedBy: string;

  private server: http.Server | null;

  private startedUrl: string | null;

  constructor({
    apiKey,
    upstreamBaseUrl = DEFAULT_UPSTREAM_BASE_URL,
    defaultModel = DEFAULT_MODEL,
    models = [],
    fetchImpl = fetch,
    host = '127.0.0.1',
    port = 0,
    providerKind = 'openai-compatible',
    providerName = 'OpenAI Compatible',
    providerCapabilities = null,
    upstreamChatCompletionsPath = '/chat/completions',
    ownedBy = 'openai-compatible',
  }: OpenAICompatibleResponsesAdapterServerOptions) {
    const normalizedKey = normalizeString(apiKey);
    if (!normalizedKey) {
      throw new Error(`${normalizeString(providerName) || 'OpenAI-compatible'} adapter requires an API key.`);
    }
    this.apiKey = normalizedKey;
    this.upstreamBaseUrl = normalizeString(upstreamBaseUrl) || DEFAULT_UPSTREAM_BASE_URL;
    this.defaultModel = normalizeString(defaultModel) || DEFAULT_MODEL;
    this.providerKind = normalizeString(providerKind) || 'openai-compatible';
    this.providerName = normalizeString(providerName) || 'OpenAI Compatible';
    this.providerCapabilities = providerCapabilities && typeof providerCapabilities === 'object'
      ? JSON.parse(JSON.stringify(providerCapabilities))
      : null;
    this.upstreamChatCompletionsPath = normalizePath(upstreamChatCompletionsPath) || '/chat/completions';
    this.ownedBy = normalizeString(ownedBy) || this.providerKind;
    this.models = normalizeModels(models, this.defaultModel, this.ownedBy);
    this.fetchImpl = fetchImpl;
    this.host = host;
    this.requestedPort = port;
    this.server = null;
    this.startedUrl = null;
  }

  get baseUrl(): string {
    if (!this.startedUrl) {
      throw new Error(`${this.providerName} adapter server has not been started.`);
    }
    return this.startedUrl;
  }

  async start(): Promise<void> {
    if (this.server && this.startedUrl) {
      return;
    }
    this.server = http.createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        writeJson(response, 500, {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: 'adapter_error',
          },
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server?.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off('error', onError);
        const address = this.server?.address();
        const port = typeof address === 'object' && address ? address.port : this.requestedPort;
        this.startedUrl = `http://${this.host}:${port}`;
        resolve();
      };
      this.server?.once('error', onError);
      this.server?.once('listening', onListening);
      this.server?.listen(this.requestedPort, this.host);
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.startedUrl = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }).catch(() => {});
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && isModelsPath(url.pathname)) {
      writeJson(response, 200, {
        object: 'list',
        data: this.models,
        models: this.models,
      });
      return;
    }
    if (request.method === 'POST' && isResponsesPath(url.pathname)) {
      const body = await readJsonBody(request);
      await this.handleResponses(body, response, {
        compact: isResponsesCompactPath(url.pathname),
      });
      return;
    }
    writeJson(response, 404, {
      error: {
        message: `Unsupported ${this.providerName} adapter route: ${request.method} ${url.pathname}`,
        type: 'not_found',
      },
    });
  }

  private async handleResponses(
    requestBody: JsonRecord,
    response: ServerResponse,
    { compact = false }: { compact?: boolean } = {},
  ): Promise<void> {
    if (compact) {
      await this.handleCompactResponses(requestBody, response);
      return;
    }
    const stream = Boolean(requestBody?.stream);
    const chatBody = responsesRequestToChatCompletions(requestBody, {
      model: requestBody?.model ?? this.defaultModel,
      stream,
      providerKind: this.providerKind,
      providerCapabilities: this.providerCapabilities,
    });
    if (stream) {
      chatBody.stream_options = {
        ...(chatBody.stream_options && typeof chatBody.stream_options === 'object' ? chatBody.stream_options : {}),
        include_usage: true,
      };
    }
    const upstream = await this.fetchUpstreamWithRetry(
      buildChatCompletionsUrl(this.upstreamBaseUrl, this.upstreamChatCompletionsPath),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(chatBody),
      },
    );
    if (!upstream.response.ok) {
      writeJson(response, upstream.response.status || 502, {
        error: normalizeUpstreamError(upstream.errorText ?? '', this.providerName, upstream.response.status),
      });
      return;
    }
    if (stream) {
      await this.writeStreamingResponse(requestBody, upstream.response, response);
      return;
    }
    const json = await upstream.response.json();
    writeJson(response, 200, chatCompletionsResponseToResponses(json, {
      request: requestBody,
      providerCapabilities: this.providerCapabilities,
    }));
  }

  private async handleCompactResponses(requestBody: JsonRecord, response: ServerResponse): Promise<void> {
    if (Boolean(requestBody?.stream)) {
      writeJson(response, 400, {
        error: {
          message: 'Streaming not supported for compact responses',
          type: 'invalid_request_error',
        },
      });
      return;
    }
    const compactBody = { ...requestBody };
    delete compactBody.stream;

    if (!this.providerCapabilities?.supportsResponsesCompact) {
      writeJson(response, 200, responsesRequestToCompactionResponse(compactBody, {
        request: compactBody,
        providerCapabilities: this.providerCapabilities,
      }));
      return;
    }

    const compactPath = normalizePath(this.providerCapabilities.upstreamResponsesCompactPath) || '/responses/compact';
    const upstream = await this.fetchUpstreamWithRetry(
      buildChatCompletionsUrl(this.upstreamBaseUrl, compactPath),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(compactBody),
      },
    );
    if (!upstream.response.ok) {
      writeJson(response, upstream.response.status || 502, {
        error: normalizeUpstreamError(upstream.errorText ?? '', this.providerName, upstream.response.status),
      });
      return;
    }
    const text = await upstream.response.text();
    response.writeHead(200, {
      'Content-Type': upstream.response.headers.get('Content-Type') || 'application/json; charset=utf-8',
    });
    response.end(text);
  }

  private async fetchUpstreamWithRetry(url: string, init: RequestInit): Promise<{
    response: Response;
    errorText: string | null;
  }> {
    const retry = normalizeRetryCapabilities(this.providerCapabilities?.retry);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      let upstream: Response;
      try {
        upstream = await this.fetchImpl(url, init);
      } catch (error) {
        lastError = error;
        if (attempt < retry.maxAttempts && retry.retryNetworkErrors) {
          await sleep(resolveRetryDelayMs(null, '', attempt, retry));
          continue;
        }
        throw error;
      }
      if (upstream.ok || attempt >= retry.maxAttempts || !retry.retryStatuses.has(upstream.status)) {
        return {
          response: upstream,
          errorText: upstream.ok ? null : await upstream.text().catch(() => ''),
        };
      }
      const text = await upstream.text().catch(() => '');
      await sleep(resolveRetryDelayMs(upstream.headers, text, attempt, retry));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'OpenAI-compatible upstream retry failed.'));
  }

  private async writeStreamingResponse(
    requestBody: JsonRecord,
    upstream: Response,
    response: ServerResponse,
  ): Promise<void> {
    if (!upstream.body) {
      writeJson(response, 502, {
        error: {
          message: `${this.providerName} upstream returned no stream body.`,
          type: 'upstream_error',
        },
      });
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for await (const event of translateChatCompletionsSseStreamToResponsesSse(
      readSseDataLines(upstream.body),
      {
        request: requestBody,
        providerCapabilities: this.providerCapabilities,
      },
    )) {
      response.write(event);
    }
    response.end();
  }
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('Request body is too large.');
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

async function* readSseDataLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let splitIndex = findSseFrameBoundary(buffer);
      while (splitIndex >= 0) {
        const frame = buffer.slice(0, splitIndex);
        buffer = buffer.slice(buffer[splitIndex] === '\r' ? splitIndex + 4 : splitIndex + 2);
        const data = extractSseData(frame);
        if (data !== null) {
          yield data;
        }
        splitIndex = findSseFrameBoundary(buffer);
      }
    }
    buffer += decoder.decode();
    const data = extractSseData(buffer);
    if (data !== null) {
      yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

function findSseFrameBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0) {
    return crlf;
  }
  if (crlf < 0) {
    return lf;
  }
  return Math.min(lf, crlf);
}

function extractSseData(frame: string): string | null {
  const lines = frame.split(/\r?\n/u);
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) {
    return null;
  }
  return dataLines.join('\n');
}

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function buildChatCompletionsUrl(baseUrl: string, pathname: string): string {
  const normalizedPath = normalizePath(pathname) || '/chat/completions';
  return `${baseUrl.replace(/\/+$/u, '')}${normalizedPath}`;
}

function isResponsesPath(pathname: string): boolean {
  return pathname === '/responses' || pathname === '/v1/responses' || isResponsesCompactPath(pathname);
}

function isResponsesCompactPath(pathname: string): boolean {
  return pathname === '/responses/compact' || pathname === '/v1/responses/compact';
}

function isModelsPath(pathname: string): boolean {
  return pathname === '/models' || pathname === '/v1/models';
}

function normalizeModels(
  models: OpenAICompatibleResponsesAdapterServerOptions['models'],
  defaultModel: string,
  ownedBy: string,
) {
  const now = Math.floor(Date.now() / 1000);
  const entries = (Array.isArray(models) ? models : [])
    .map((model) => {
      const id = normalizeString(model?.id) || normalizeString(model?.model);
      if (!id) {
        return null;
      }
      return {
        ...model,
        id,
        slug: normalizeString(model?.slug) || id,
        object: normalizeString(model?.object) || 'model',
        created: Number.isFinite(Number(model?.created)) ? Number(model.created) : now,
        owned_by: normalizeString(model?.owned_by) || ownedBy,
      };
    })
    .filter(Boolean);
  if (entries.length > 0) {
    const seen = new Set<string>();
    return entries.filter((entry) => {
      if (!entry || seen.has(entry.id)) {
        return false;
      }
      seen.add(entry.id);
      return true;
    });
  }
  return [{
    id: defaultModel,
    slug: defaultModel,
    object: 'model',
    created: now,
    owned_by: ownedBy,
  }];
}

function extractUpstreamError(text: string): string | null {
  const trimmed = normalizeString(text);
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return normalizeString(parsed?.error?.message)
      || normalizeString(parsed?.message)
      || trimmed;
  } catch {
    return trimmed;
  }
}

function normalizeUpstreamError(text: string, providerName: string, status: number): JsonRecord {
  const trimmed = normalizeString(text);
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.error && typeof parsed.error === 'object') {
        return {
          message: normalizeString(parsed.error.message) || `${providerName} upstream returned HTTP ${status}`,
          type: normalizeString(parsed.error.type) || 'upstream_error',
          code: parsed.error.code ?? upstreamErrorCode(status),
          param: parsed.error.param,
        };
      }
      return {
        message: normalizeString(parsed?.message) || trimmed,
        type: normalizeString(parsed?.type) || 'upstream_error',
        code: parsed?.code ?? upstreamErrorCode(status),
      };
    } catch {
      return {
        message: trimmed,
        type: 'upstream_error',
        code: upstreamErrorCode(status),
      };
    }
  }
  return {
    message: `${providerName} upstream returned HTTP ${status}`,
    type: 'upstream_error',
    code: upstreamErrorCode(status),
  };
}

function normalizeRetryCapabilities(capabilities: OpenAICompatibleRetryCapabilities | null | undefined): {
  maxAttempts: number;
  retryStatuses: Set<number>;
  baseDelayMs: number;
  maxDelayMs: number;
  retryAfterMaxMs: number;
  retryNetworkErrors: boolean;
} {
  if (!capabilities || typeof capabilities !== 'object') {
    return {
      maxAttempts: 1,
      retryStatuses: new Set(DEFAULT_RETRY_STATUSES),
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryAfterMaxMs: 0,
      retryNetworkErrors: false,
    };
  }
  const maxAttempts = clampInteger(capabilities.maxAttempts, 1, 5, 1);
  return {
    maxAttempts,
    retryStatuses: new Set(normalizeRetryStatuses(capabilities.retryStatuses) ?? DEFAULT_RETRY_STATUSES),
    baseDelayMs: clampInteger(capabilities.baseDelayMs, 0, 30_000, 250),
    maxDelayMs: clampInteger(capabilities.maxDelayMs, 0, 60_000, 2_000),
    retryAfterMaxMs: clampInteger(capabilities.retryAfterMaxMs, 0, 300_000, 30_000),
    retryNetworkErrors: Boolean(capabilities.retryNetworkErrors),
  };
}

function normalizeRetryStatuses(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const statuses = value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry >= 100 && entry <= 599);
  return statuses.length > 0 ? [...new Set(statuses)] : null;
}

function resolveRetryDelayMs(
  headers: Headers | null,
  text: string,
  attempt: number,
  retry: ReturnType<typeof normalizeRetryCapabilities>,
): number {
  const retryAfter = parseRetryAfterMs(headers?.get('retry-after') ?? null)
    ?? parseRetryAfterMsFromBody(text);
  if (retryAfter !== null) {
    return retry.retryAfterMaxMs > 0 ? Math.min(retryAfter, retry.retryAfterMaxMs) : retryAfter;
  }
  if (retry.baseDelayMs <= 0 || retry.maxDelayMs <= 0) {
    return 0;
  }
  return Math.min(retry.maxDelayMs, retry.baseDelayMs * (2 ** Math.max(0, attempt - 1)));
}

function parseRetryAfterMs(value: string | null): number | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const timestamp = Date.parse(normalized);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }
  return null;
}

function parseRetryAfterMsFromBody(text: string): number | null {
  const trimmed = normalizeString(text);
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parseRetryAfterMs(
      parsed?.retry_after
        ?? parsed?.retryAfter
        ?? parsed?.error?.retry_after
        ?? parsed?.error?.retryAfter
        ?? null,
    );
  } catch {
    return null;
  }
}

async function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function upstreamErrorCode(status: number): string {
  switch (status) {
    case 401:
      return 'invalid_api_key';
    case 403:
      return 'insufficient_quota';
    case 404:
      return 'model_not_found';
    case 408:
      return 'request_timeout';
    case 429:
      return 'rate_limit_exceeded';
    default:
      if (status >= 500) {
        return 'internal_server_error';
      }
      if (status >= 400) {
        return 'invalid_request_error';
      }
      return 'unknown_error';
  }
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePath(value: unknown): string {
  const normalized = normalizeString(value);
  if (!normalized) {
    return '';
  }
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

export async function reserveLocalPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', resolve);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
