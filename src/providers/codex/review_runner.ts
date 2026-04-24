import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { normalizeLocale } from '../../i18n/index.js';
import type {
  ProviderReviewTarget,
  ProviderThreadSummary,
  ProviderTurnResult,
} from '../../types/provider.js';

type SpawnLike = typeof spawn;

interface ReviewRunState {
  threadId: string;
  turnId: string;
  cwd: string;
  target: ProviderReviewTarget;
  status: 'running' | 'complete' | 'interrupted' | 'failed';
  error: string | null;
  outputText: string;
  child: ChildProcess | null;
  interrupted: boolean;
  startedAt: number;
  updatedAt: number;
}

export interface CodexCliReviewStartParams {
  codexCliBin: string;
  cwd: string;
  model?: string | null;
  effort?: string | null;
  serviceTier?: string | null;
  target: ProviderReviewTarget;
  locale?: string | null;
  onTurnStarted?: ((meta: { threadId: string; turnId: string }) => Promise<void> | void) | null;
}

export interface CodexReviewRunnerLike {
  start(params: CodexCliReviewStartParams): Promise<ProviderTurnResult>;
  readThread(threadId: string, includeTurns?: boolean): ProviderThreadSummary | null;
  interrupt(turnId: string): Promise<boolean> | boolean;
}

export class CodexCliReviewRunner implements CodexReviewRunnerLike {
  private readonly spawnImpl: SpawnLike;

  private readonly now: () => number;

  private readonly runsByThreadId: Map<string, ReviewRunState>;

  private readonly runsByTurnId: Map<string, ReviewRunState>;

  constructor({
    spawnImpl = spawn,
    now = () => Date.now(),
  }: {
    spawnImpl?: SpawnLike;
    now?: () => number;
  } = {}) {
    this.spawnImpl = spawnImpl;
    this.now = now;
    this.runsByThreadId = new Map();
    this.runsByTurnId = new Map();
  }

  async start({
    codexCliBin,
    cwd,
    model = null,
    effort = null,
    serviceTier = null,
    target,
    locale = null,
    onTurnStarted = null,
  }: CodexCliReviewStartParams): Promise<ProviderTurnResult> {
    const threadId = `codex-review-cli-${crypto.randomUUID()}`;
    const turnId = `${threadId}-turn-1`;
    const startedAt = this.now();
    const state: ReviewRunState = {
      threadId,
      turnId,
      cwd,
      target,
      status: 'running',
      error: null,
      outputText: '',
      child: null,
      interrupted: false,
      startedAt,
      updatedAt: startedAt,
    };
    this.runsByThreadId.set(threadId, state);
    this.runsByTurnId.set(turnId, state);
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({ threadId, turnId });
    }
    if (state.interrupted) {
      state.status = 'interrupted';
      state.updatedAt = this.now();
      return {
        outputText: '',
        outputState: 'interrupted',
        previewText: '',
        finalSource: 'codex_review_cli_interrupted',
        turnId,
        threadId,
        title: formatReviewThreadTitle(target),
        status: 'interrupted',
      };
    }

    const args = buildCodexReviewArgs({
      cwd,
      model,
      effort,
      serviceTier,
      target,
      locale,
    });
    const child = this.spawnImpl(codexCliBin, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.child = child;

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdoutChunks.push(String(chunk ?? ''));
    });
    child.stderr?.on('data', (chunk) => {
      stderrChunks.push(String(chunk ?? ''));
    });

    return await new Promise<ProviderTurnResult>((resolve, reject) => {
      const fail = (error: Error) => {
        state.status = state.interrupted ? 'interrupted' : 'failed';
        state.error = error.message;
        state.updatedAt = this.now();
        state.child = null;
        reject(error);
      };
      child.once('error', (error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
      child.once('close', (code, signal) => {
        state.child = null;
        state.updatedAt = this.now();
        state.outputText = String(stdoutChunks.join('')).trim();
        const stderrText = String(stderrChunks.join(''));
        if (state.interrupted || signal) {
          state.status = 'interrupted';
          resolve({
            outputText: '',
            outputState: 'interrupted',
            previewText: '',
            finalSource: 'codex_review_cli_interrupted',
            turnId,
            threadId,
            title: formatReviewThreadTitle(target),
            status: 'interrupted',
          });
          return;
        }
        if (code === 0 && state.outputText) {
          state.status = 'complete';
          resolve({
            outputText: state.outputText,
            outputState: 'complete',
            previewText: '',
            finalSource: 'codex_review_cli',
            turnId,
            threadId,
            title: formatReviewThreadTitle(target),
            status: 'complete',
          });
          return;
        }
        const errorMessage = extractCodexReviewError(stderrText)
          || (code === 0 ? 'Codex review returned no visible output.' : `codex review exited with code ${code ?? 'unknown'}`);
        fail(new Error(errorMessage));
      });
    });
  }

  readThread(threadId: string, includeTurns = false): ProviderThreadSummary | null {
    const state = this.runsByThreadId.get(String(threadId).trim()) ?? null;
    if (!state) {
      return null;
    }
    return {
      threadId: state.threadId,
      cwd: state.cwd,
      title: formatReviewThreadTitle(state.target),
      updatedAt: state.updatedAt,
      preview: state.outputText ? summarizePreview(state.outputText) : 'codex review',
      turns: includeTurns
        ? [{
          id: state.turnId,
          status: mapRunStatusToTurnStatus(state.status),
          error: state.error,
          items: state.outputText
            ? [{
              type: 'message',
              role: 'assistant',
              phase: 'final',
              text: state.outputText,
            }]
            : [],
        }]
        : null,
    };
  }

  async interrupt(turnId: string): Promise<boolean> {
    const state = this.runsByTurnId.get(String(turnId).trim()) ?? null;
    if (!state) {
      return false;
    }
    state.interrupted = true;
    state.updatedAt = this.now();
    const child = state.child;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
    }
    return true;
  }
}

function buildCodexReviewArgs({
  cwd,
  model,
  effort,
  serviceTier,
  target,
  locale,
}: {
  cwd: string;
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
  target: ProviderReviewTarget;
  locale?: string | null;
}): string[] {
  const args: string[] = ['-C', cwd, '-s', 'read-only', '-a', 'never'];
  if (model) {
    args.push('-m', model);
  }
  if (effort) {
    args.push('-c', `model_reasoning_effort="${escapeTomlString(effort)}"`);
  }
  if (serviceTier === 'fast') {
    args.push('-c', 'service_tier="fast"');
  }
  args.push('review');
  switch (target.type) {
    case 'uncommittedChanges':
      // Native `codex review` rejects `[PROMPT]` when used with `--uncommitted`.
      args.push('--uncommitted');
      break;
    case 'baseBranch':
      // Keep base/commit review invocations prompt-free for CLI compatibility.
      args.push('--base', target.branch);
      break;
    case 'commit':
      args.push('--commit', target.sha);
      if (target.title) {
        args.push('--title', target.title);
      }
      break;
    case 'custom':
      args.push(mergeReviewInstructions(target.instructions, buildLocaleAwareReviewPrompt(locale)));
      break;
    default:
      break;
  }
  return args;
}

function escapeTomlString(value: string): string {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function extractCodexReviewError(stderrText: string): string {
  const lines = String(stderrText ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('ERROR:')) {
      continue;
    }
    const payload = line.slice('ERROR:'.length).trim();
    if (!payload) {
      continue;
    }
    try {
      const parsed = JSON.parse(payload);
      const message = String(parsed?.error?.message ?? '').trim();
      return message || payload;
    } catch {
      return payload;
    }
  }
  return lines.at(-1) ?? '';
}

function formatReviewThreadTitle(target: ProviderReviewTarget): string {
  switch (target.type) {
    case 'uncommittedChanges':
      return 'Review: uncommitted changes';
    case 'baseBranch':
      return `Review: base ${target.branch}`;
    case 'commit':
      return `Review: commit ${target.sha}`;
    case 'custom':
      return 'Review: custom';
    default:
      return 'Review';
  }
}

function buildLocaleAwareReviewPrompt(locale: string | null | undefined): string {
  const normalized = normalizeLocale(locale);
  if (normalized === 'zh-CN') {
    return [
      '请使用简体中文输出代码审查结果。',
      '先给出按严重程度排序的 findings，再补充说明。',
      '如果没有明确问题，请明确写“未发现明确问题”。',
    ].join(' ');
  }
  return [
    'Write the code review in English.',
    'List findings first in severity order.',
    'If there are no clear issues, say so explicitly.',
  ].join(' ');
}

function mergeReviewInstructions(instructions: string, localePrompt: string): string {
  const normalizedInstructions = String(instructions ?? '').trim();
  const normalizedPrompt = String(localePrompt ?? '').trim();
  if (!normalizedInstructions) {
    return normalizedPrompt;
  }
  if (!normalizedPrompt) {
    return normalizedInstructions;
  }
  return `${normalizedInstructions}\n\n${normalizedPrompt}`;
}

function mapRunStatusToTurnStatus(status: ReviewRunState['status']): string {
  switch (status) {
    case 'complete':
      return 'complete';
    case 'interrupted':
      return 'interrupted';
    case 'failed':
      return 'failed';
    default:
      return 'running';
  }
}

function summarizePreview(text: string): string {
  const normalized = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 117)}...`;
}
