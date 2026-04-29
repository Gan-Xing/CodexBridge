import crypto from 'node:crypto';
import { NotFoundError } from './errors.js';
import { formatPlatformScopeKey } from './contracts.js';
import { createI18n, type Translator } from '../i18n/index.js';
import type {
  AutomationJob,
  AutomationMode,
  AutomationSchedule,
  AutomationStatus,
  BridgeSession,
  PlatformScopeRef,
} from '../types/core.js';
import type { AutomationJobRepository } from '../types/repository.js';

interface BridgeSessionsLike {
  getSessionById?(bridgeSessionId: string): BridgeSession | null;
}

interface AutomationJobServiceOptions {
  automationJobs: AutomationJobRepository;
  bridgeSessions?: BridgeSessionsLike | null;
  now?: () => number;
  locale?: string | null;
  staleRunningMs?: number | null;
}

export class AutomationJobService {
  static readonly DEFAULT_STALE_RUNNING_MS = 20 * 60_000;

  private readonly automationJobs: AutomationJobRepository;

  private readonly bridgeSessions: BridgeSessionsLike | null;

  private readonly now: () => number;

  private readonly i18n: Translator;

  private readonly staleRunningMs: number;

  constructor({
    automationJobs,
    bridgeSessions = null,
    now = () => Date.now(),
    locale = null,
    staleRunningMs = AutomationJobService.DEFAULT_STALE_RUNNING_MS,
  }: AutomationJobServiceOptions) {
    this.automationJobs = automationJobs;
    this.bridgeSessions = bridgeSessions;
    this.now = now;
    this.i18n = createI18n(locale);
    this.staleRunningMs = Math.max(0, Number(staleRunningMs ?? 0));
  }

  listForScope(scopeRef: PlatformScopeRef): AutomationJob[] {
    return this.automationJobs
      .list()
      .filter((job) => job.platform === scopeRef.platform && job.externalScopeId === scopeRef.externalScopeId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  getById(id: string): AutomationJob | null {
    return this.automationJobs.getById(id);
  }

  requireById(id: string): AutomationJob {
    const job = this.getById(id);
    if (!job) {
      throw new NotFoundError(this.i18n.t('service.unknownAutomationJob', { id }));
    }
    return job;
  }

  resolveForScope(scopeRef: PlatformScopeRef, token: string): AutomationJob | null {
    const normalized = String(token ?? '').trim();
    if (!normalized) {
      return null;
    }
    const byId = this.getById(normalized);
    if (byId && byId.platform === scopeRef.platform && byId.externalScopeId === scopeRef.externalScopeId) {
      return byId;
    }
    const index = Number(normalized);
    if (Number.isInteger(index) && index > 0) {
      return this.listForScope(scopeRef)[index - 1] ?? null;
    }
    return null;
  }

  createJob(params: {
    scopeRef: PlatformScopeRef;
    title: string;
    mode: AutomationMode;
    providerProfileId: string;
    bridgeSessionId: string;
    cwd: string | null;
    prompt: string;
    locale: string | null;
    schedule: AutomationSchedule;
  }): AutomationJob {
    const now = this.now();
    const job: AutomationJob = {
      id: crypto.randomUUID(),
      platform: params.scopeRef.platform,
      externalScopeId: params.scopeRef.externalScopeId,
      title: String(params.title ?? '').trim(),
      mode: params.mode,
      providerProfileId: params.providerProfileId,
      bridgeSessionId: params.bridgeSessionId,
      cwd: normalizeNullableString(params.cwd),
      prompt: String(params.prompt ?? '').trim(),
      locale: normalizeNullableString(params.locale),
      schedule: cloneSchedule(params.schedule),
      status: 'active',
      running: false,
      nextRunAt: computeNextRunAt(params.schedule, now),
      lastRunAt: null,
      lastDeliveredAt: null,
      lastResultPreview: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.automationJobs.save(job);
    return job;
  }

  updateJob(id: string, updates: Partial<AutomationJob>): AutomationJob {
    const current = this.requireById(id);
    const next: AutomationJob = {
      ...current,
      ...updates,
      schedule: updates.schedule ? cloneSchedule(updates.schedule) : current.schedule,
      updatedAt: this.now(),
    };
    this.automationJobs.save(next);
    return next;
  }

  renameJob(id: string, title: string): AutomationJob {
    return this.updateJob(id, {
      title: String(title ?? '').trim(),
    });
  }

  pauseJob(id: string): AutomationJob {
    return this.updateJob(id, {
      status: 'paused',
      running: false,
    });
  }

  resumeJob(id: string): AutomationJob {
    const current = this.requireById(id);
    return this.updateJob(id, {
      status: 'active',
      running: false,
      nextRunAt: computeNextRunAt(current.schedule, this.now()),
    });
  }

  deleteJob(id: string): void {
    this.automationJobs.delete(id);
  }

  resetRunningJobs(): void {
    const now = this.now();
    for (const job of this.automationJobs.list()) {
      if (!job.running) {
        continue;
      }
      this.automationJobs.save({
        ...job,
        running: false,
        nextRunAt: Math.max(job.nextRunAt, now + 5_000),
        updatedAt: now,
      });
    }
  }

  claimDueJobs(platform: string, limit = 3): AutomationJob[] {
    const now = this.now();
    if (this.staleRunningMs > 0) {
      for (const job of this.automationJobs.list()) {
        if (
          job.platform !== platform
          || job.status !== 'active'
          || !job.running
          || job.updatedAt > (now - this.staleRunningMs)
        ) {
          continue;
        }
        this.automationJobs.save({
          ...job,
          running: false,
          nextRunAt: Math.min(job.nextRunAt, now),
          updatedAt: now,
        });
      }
    }
    const due = this.automationJobs
      .list()
      .filter((job) => (
        job.platform === platform
        && job.status === 'active'
        && !job.running
        && job.nextRunAt <= now
      ))
      .sort((left, right) => left.nextRunAt - right.nextRunAt)
      .slice(0, limit);
    for (const job of due) {
      this.automationJobs.save({
        ...job,
        running: true,
        updatedAt: now,
      });
    }
    return due.map((job) => this.requireById(job.id));
  }

  deferJob(id: string, nextRunAt: number): AutomationJob {
    return this.updateJob(id, {
      running: false,
      nextRunAt,
    });
  }

  completeJob(id: string, params: {
    resultPreview?: string | null;
    error?: string | null;
    deliveredAt?: number | null;
  } = {}): AutomationJob {
    const current = this.requireById(id);
    const now = this.now();
    return this.updateJob(id, {
      running: false,
      nextRunAt: computeNextRunAt(current.schedule, now),
      lastRunAt: now,
      lastDeliveredAt: params.deliveredAt ?? now,
      lastResultPreview: normalizeNullableString(params.resultPreview),
      lastError: normalizeNullableString(params.error),
    });
  }

  getSession(job: AutomationJob): BridgeSession | null {
    return this.bridgeSessions?.getSessionById?.(job.bridgeSessionId) ?? null;
  }
}

export function computeNextRunAt(schedule: AutomationSchedule, fromMs: number): number {
  const from = Math.max(0, Number(fromMs ?? 0));
  if (schedule.kind === 'interval') {
    return from + (Math.max(60, schedule.everySeconds) * 1000);
  }
  if (schedule.kind === 'daily') {
    const next = new Date(from);
    next.setUTCSeconds(0, 0);
    next.setUTCHours(schedule.hour, schedule.minute, 0, 0);
    if (next.getTime() <= from) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime();
  }
  return computeNextCronRunAt(schedule.expression, from);
}

function computeNextCronRunAt(expression: string, fromMs: number): number {
  const fields = parseCronExpression(expression);
  const cursor = new Date(fromMs + 60_000);
  cursor.setUTCSeconds(0, 0);
  for (let step = 0; step < 366 * 24 * 60; step += 1) {
    if (
      fields.minute.has(cursor.getUTCMinutes())
      && fields.hour.has(cursor.getUTCHours())
      && fields.dayOfMonth.has(cursor.getUTCDate())
      && fields.month.has(cursor.getUTCMonth() + 1)
      && fields.dayOfWeek.has(cursor.getUTCDay())
    ) {
      return cursor.getTime();
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new Error(`Unsupported cron schedule: ${expression}`);
}

function parseCronExpression(expression: string): {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
} {
  const parts = String(expression ?? '').trim().split(/\s+/u);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${expression}`);
  }
  return {
    minute: expandCronField(parts[0], 0, 59),
    hour: expandCronField(parts[1], 0, 23),
    dayOfMonth: expandCronField(parts[2], 1, 31),
    month: expandCronField(parts[3], 1, 12),
    dayOfWeek: expandCronField(parts[4], 0, 6),
  };
}

function expandCronField(field: string, min: number, max: number): Set<number> {
  const normalized = String(field ?? '').trim();
  if (!normalized) {
    throw new Error(`Invalid cron field: ${field}`);
  }
  const values = new Set<number>();
  for (const segment of normalized.split(',')) {
    const trimmed = segment.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === '*') {
      for (let value = min; value <= max; value += 1) {
        values.add(value);
      }
      continue;
    }
    const stepMatch = trimmed.match(/^\*\/(\d+)$/u);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`Invalid cron step: ${field}`);
      }
      for (let value = min; value <= max; value += step) {
        values.add(value);
      }
      continue;
    }
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/u);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start < min || end > max) {
        throw new Error(`Invalid cron range: ${field}`);
      }
      for (let value = start; value <= end; value += 1) {
        values.add(value);
      }
      continue;
    }
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`Invalid cron value: ${field}`);
    }
    values.add(value);
  }
  if (values.size === 0) {
    throw new Error(`Empty cron field: ${field}`);
  }
  return values;
}

function cloneSchedule(schedule: AutomationSchedule): AutomationSchedule {
  return JSON.parse(JSON.stringify(schedule));
}

function normalizeNullableString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

export function describeAutomationScope(job: AutomationJob): string {
  return formatPlatformScopeKey(job.platform, job.externalScopeId);
}

export function formatAutomationStatus(status: AutomationStatus, running: boolean): string {
  if (running) {
    return 'running';
  }
  return status;
}
