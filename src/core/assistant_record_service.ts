import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AssistantAttachment,
  AssistantAttachmentKind,
  AssistantRecord,
  AssistantRecordPriority,
  AssistantRecordStatus,
  AssistantRecordType,
  PlatformScopeRef,
  UploadBatchItem,
} from '../types/core.js';
import type { AssistantRecordRepository } from '../types/repository.js';

export interface AssistantRecordDraft {
  type: AssistantRecordType;
  title: string;
  content: string;
  originalText: string;
  priority: AssistantRecordPriority;
  project: string | null;
  tags: string[];
  dueAt: number | null;
  remindAt: number | null;
  recurrence: string | null;
  confidence: number;
  parsedJson: Record<string, unknown>;
}

interface CreateAssistantRecordParams {
  scopeRef: PlatformScopeRef;
  source?: AssistantRecord['source'] | null;
  contextThreadId?: string | null;
  timezone?: string | null;
  draft: AssistantRecordDraft;
  status?: AssistantRecordStatus | null;
  parseStatus?: AssistantRecord['parseStatus'] | null;
  uploadItems?: UploadBatchItem[] | null;
}

interface AssistantRecordServiceOptions {
  assistantRecords: AssistantRecordRepository;
  attachmentRoot: string;
  now?: () => number;
  timezone?: string | null;
}

export class AssistantRecordService {
  private readonly assistantRecords: AssistantRecordRepository;

  private readonly attachmentRoot: string;

  private readonly now: () => number;

  private readonly timezone: string;

  constructor({
    assistantRecords,
    attachmentRoot,
    now = () => Date.now(),
    timezone = null,
  }: AssistantRecordServiceOptions) {
    this.assistantRecords = assistantRecords;
    this.attachmentRoot = path.resolve(attachmentRoot);
    this.now = now;
    this.timezone = normalizeNullableString(timezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Etc/UTC';
  }

  parseDraft(input: string, forcedType: AssistantRecordType | null = null): AssistantRecordDraft {
    return parseAssistantDraft(input, forcedType, this.now());
  }

  shouldConfirmDraft(draft: AssistantRecordDraft, forcedType: AssistantRecordType | null = null): boolean {
    if (forcedType) {
      return draft.confidence < 0.7 || (draft.type === 'reminder' && !draft.remindAt && !draft.recurrence);
    }
    if (draft.type === 'todo' || draft.type === 'reminder') {
      return true;
    }
    return draft.confidence < 0.72;
  }

  async createRecord(params: CreateAssistantRecordParams): Promise<AssistantRecord> {
    const now = this.now();
    const recordId = crypto.randomUUID();
    const record: AssistantRecord = {
      id: recordId,
      type: params.draft.type,
      status: params.status ?? 'active',
      title: normalizeTitle(params.draft.title, params.draft.type),
      content: String(params.draft.content ?? '').trim(),
      originalText: String(params.draft.originalText ?? '').trim(),
      priority: params.draft.priority,
      project: normalizeNullableString(params.draft.project),
      tags: normalizeStringArray(params.draft.tags),
      dueAt: normalizeTimestamp(params.draft.dueAt),
      remindAt: normalizeTimestamp(params.draft.remindAt),
      recurrence: normalizeNullableString(params.draft.recurrence),
      timezone: normalizeNullableString(params.timezone) ?? this.timezone,
      source: params.source ?? 'weixin',
      platform: params.scopeRef.platform,
      scopeId: params.scopeRef.externalScopeId,
      contextThreadId: normalizeNullableString(params.contextThreadId),
      attachments: [],
      parseStatus: params.parseStatus ?? 'auto',
      confidence: clampConfidence(params.draft.confidence),
      parsedJson: { ...params.draft.parsedJson },
      lastRemindedAt: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      cancelledAt: null,
      archivedAt: null,
    };
    const saved = this.assistantRecords.save(record);
    if (Array.isArray(params.uploadItems) && params.uploadItems.length > 0) {
      try {
        const attachments = await this.archiveUploadItems(saved, params.uploadItems);
        return this.updateRecord(saved.id, { attachments });
      } catch (error) {
        this.assistantRecords.delete(saved.id);
        throw error;
      }
    }
    return saved;
  }

  getById(id: string): AssistantRecord | null {
    return this.assistantRecords.getById(id);
  }

  listForScope(scopeRef: PlatformScopeRef, type: AssistantRecordType | null = null): AssistantRecord[] {
    return this.assistantRecords
      .list()
      .filter((record) => record.platform === scopeRef.platform && record.scopeId === scopeRef.externalScopeId)
      .filter((record) => !type || record.type === type)
      .filter((record) => record.status !== 'archived')
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  searchForScope(scopeRef: PlatformScopeRef, query: string, type: AssistantRecordType | null = null): AssistantRecord[] {
    const normalizedQuery = String(query ?? '').trim().toLowerCase();
    if (!normalizedQuery) {
      return this.listForScope(scopeRef, type);
    }
    return this.listForScope(scopeRef, type).filter((record) => {
      const haystack = [
        record.title,
        record.content,
        record.originalText,
        record.project ?? '',
        ...record.tags,
      ].join('\n').toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }

  resolveForScope(scopeRef: PlatformScopeRef, token: string, type: AssistantRecordType | null = null): AssistantRecord | null {
    const normalized = String(token ?? '').trim();
    if (!normalized) {
      return null;
    }
    const byId = this.getById(normalized);
    if (byId
      && byId.platform === scopeRef.platform
      && byId.scopeId === scopeRef.externalScopeId
      && (!type || byId.type === type)
      && byId.status !== 'archived') {
      return byId;
    }
    const index = Number(normalized);
    if (Number.isInteger(index) && index > 0) {
      return this.listForScope(scopeRef, type)[index - 1] ?? null;
    }
    return null;
  }

  getLatestPendingForScope(scopeRef: PlatformScopeRef, type: AssistantRecordType | null = null): AssistantRecord | null {
    return this.listForScope(scopeRef, type)
      .filter((record) => record.status === 'pending')
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }

  updateRecord(id: string, updates: Partial<AssistantRecord>): AssistantRecord {
    const existing = this.assistantRecords.getById(id);
    if (!existing) {
      throw new Error(`Unknown assistant record: ${id}`);
    }
    const now = this.now();
    const next: AssistantRecord = {
      ...existing,
      ...updates,
      tags: updates.tags ? normalizeStringArray(updates.tags) : [...existing.tags],
      attachments: updates.attachments ? updates.attachments.map((attachment) => ({ ...attachment })) : existing.attachments.map((attachment) => ({ ...attachment })),
      parsedJson: updates.parsedJson ? { ...updates.parsedJson } : existing.parsedJson ? { ...existing.parsedJson } : null,
      updatedAt: now,
    };
    return this.assistantRecords.save(next);
  }

  confirmRecord(id: string): AssistantRecord {
    return this.updateRecord(id, {
      status: 'active',
      parseStatus: 'confirmed',
    });
  }

  completeRecord(id: string): AssistantRecord {
    const now = this.now();
    return this.updateRecord(id, {
      status: 'done',
      completedAt: now,
    });
  }

  cancelRecord(id: string): AssistantRecord {
    const now = this.now();
    return this.updateRecord(id, {
      status: 'cancelled',
      cancelledAt: now,
    });
  }

  archiveRecord(id: string): AssistantRecord {
    const now = this.now();
    return this.updateRecord(id, {
      status: 'archived',
      archivedAt: now,
    });
  }

  updatePendingFromDraft(record: AssistantRecord, draft: AssistantRecordDraft): AssistantRecord {
    return this.updateRecord(record.id, {
      type: draft.type,
      title: normalizeTitle(draft.title, draft.type),
      content: draft.content,
      originalText: draft.originalText,
      priority: draft.priority,
      project: draft.project,
      tags: draft.tags,
      dueAt: draft.dueAt,
      remindAt: draft.remindAt,
      recurrence: draft.recurrence,
      confidence: draft.confidence,
      parsedJson: draft.parsedJson,
      parseStatus: 'edited',
    });
  }

  updatePendingFromInstruction(
    record: AssistantRecord,
    instruction: string,
    forcedType: AssistantRecordType | null = null,
  ): AssistantRecord {
    return this.assistantRecords.save(this.previewUpdate(record, instruction, forcedType));
  }

  previewUpdate(
    record: AssistantRecord,
    instruction: string,
    forcedType: AssistantRecordType | null = null,
  ): AssistantRecord {
    const normalizedInstruction = String(instruction ?? '').trim();
    const parsedInstruction = parseAssistantDraft(normalizedInstruction, forcedType, this.now());
    const explicitType = forcedType ?? inferExplicitEditType(normalizedInstruction);
    const nextType = explicitType ?? record.type;
    const hasDateEdit = parsedInstruction.parsedJson.dateMatched === true;
    const hasPriorityEdit = containsPriorityInstruction(normalizedInstruction);
    const contentEdit = applyContentEdit(record.content, normalizedInstruction);
    const dateContentEdit = hasDateEdit
      ? applyDatePhraseEdit(contentEdit.content, normalizedInstruction)
      : { content: contentEdit.content, changed: false };
    const contentChanged = contentEdit.changed || dateContentEdit.changed;
    const shouldAppendInstruction = !contentChanged
      && !isMetadataOnlyEdit(normalizedInstruction, {
        explicitType,
        hasDateEdit,
        hasPriorityEdit,
        hasTags: parsedInstruction.tags.length > 0,
      });
    const nextContent = shouldAppendInstruction
      ? appendContent(dateContentEdit.content, normalizedInstruction)
      : dateContentEdit.content;
    const nextDueAt = resolveEditedDueAt(record, parsedInstruction, nextType, hasDateEdit);
    const nextRemindAt = resolveEditedRemindAt(record, parsedInstruction, nextType, hasDateEdit);
    const nextRecurrence = resolveEditedRecurrence(record, parsedInstruction, nextType, hasDateEdit);
    const nextTitle = contentChanged || shouldAppendInstruction || explicitType
      ? normalizeTitle(buildTitle(nextContent, nextType), nextType)
      : record.title;
    const now = this.now();
    return {
      ...record,
      type: nextType,
      title: nextTitle,
      content: nextContent,
      originalText: appendOriginalText(record.originalText, normalizedInstruction),
      priority: hasPriorityEdit ? parsedInstruction.priority : record.priority,
      project: parsedInstruction.project ?? record.project,
      tags: mergeTags(record.tags, parsedInstruction.tags),
      dueAt: nextDueAt,
      remindAt: nextRemindAt,
      recurrence: nextRecurrence,
      confidence: Math.max(record.confidence, parsedInstruction.confidence),
      parsedJson: {
        ...(record.parsedJson ?? {}),
        lastEdit: {
          instruction: normalizedInstruction,
          appliedAt: now,
          parser: 'local-rule-modify',
        },
      },
      parseStatus: 'edited',
      attachments: record.attachments.map((attachment) => ({ ...attachment })),
      updatedAt: now,
    };
  }

  claimDueReminders(platform: string, now = this.now()): AssistantRecord[] {
    const due = this.assistantRecords
      .list()
      .filter((record) => record.platform === platform)
      .filter((record) => record.type === 'reminder')
      .filter((record) => record.status === 'active')
      .filter((record) => typeof record.remindAt === 'number' && record.remindAt <= now)
      .filter((record) => !record.lastRemindedAt || record.lastRemindedAt < (record.remindAt ?? 0))
      .sort((left, right) => (left.remindAt ?? 0) - (right.remindAt ?? 0));
    for (const record of due) {
      const nextReminderAt = computeNextReminderAt(record, now);
      this.updateRecord(record.id, {
        lastRemindedAt: now,
        remindAt: nextReminderAt,
        status: nextReminderAt ? 'active' : 'done',
        completedAt: nextReminderAt ? record.completedAt : now,
      });
    }
    return due;
  }

  private async archiveUploadItems(record: AssistantRecord, items: UploadBatchItem[]): Promise<AssistantAttachment[]> {
    const dayDir = buildDayDirectory(record.createdAt);
    const targetDir = path.join(this.attachmentRoot, dayDir, record.id);
    await fs.promises.mkdir(targetDir, { recursive: true });
    const archived: AssistantAttachment[] = [];
    for (const [index, item] of items.entries()) {
      const sourcePath = item.localPath || item.originalPath;
      const fallbackName = item.fileName ?? path.basename(sourcePath);
      const filename = `${String(index + 1).padStart(2, '0')}-${sanitizePathSegment(fallbackName)}`;
      const storagePath = path.join(targetDir, filename);
      await fs.promises.copyFile(sourcePath, storagePath);
      const sizeBytes = await readFileSize(storagePath);
      const sha256 = await hashFile(storagePath);
      archived.push({
        id: crypto.randomUUID(),
        recordId: record.id,
        originalPath: item.originalPath || sourcePath,
        storagePath,
        filename,
        originalFilename: item.fileName,
        mimeType: item.mimeType,
        sizeBytes,
        sha256,
        kind: mapUploadKind(item.kind, item.mimeType, filename),
        createdAt: this.now(),
      });
    }
    return archived;
  }
}

function parseAssistantDraft(input: string, forcedType: AssistantRecordType | null, now: number): AssistantRecordDraft {
  const originalText = String(input ?? '').trim();
  const tags = extractTags(originalText);
  const cleaned = stripAssistantMetaInstructions(originalText.replace(/#[\p{L}\p{N}_-]+/gu, '').trim());
  const type = forcedType ?? inferRecordType(cleaned);
  const dateInfo = parseDateInfo(cleaned, now);
  const priority = inferPriority(cleaned);
  const title = buildTitle(cleaned, type);
  const confidence = computeConfidence({ forcedType, type, text: cleaned, dateInfo });
  return {
    type,
    title,
    content: cleaned,
    originalText,
    priority,
    project: inferProject(tags),
    tags,
    dueAt: type === 'todo' ? dateInfo.dueAt : null,
    remindAt: type === 'reminder' ? dateInfo.remindAt : null,
    recurrence: type === 'reminder' ? dateInfo.recurrence : null,
    confidence,
    parsedJson: {
      parser: 'local-rule',
      dateMatched: dateInfo.matched,
      strippedAssistantInstruction: cleaned !== originalText.replace(/#[\p{L}\p{N}_-]+/gu, '').trim(),
    },
  };
}

function stripAssistantMetaInstructions(input: string): string {
  let text = String(input ?? '').trim();
  text = text.replace(/^(?:请)?(?:帮我|给我)?(?:记录|记一下|整理一下|保存一下|存一下)(?:[:：，,]\s*)?/u, '').trim();
  const suffixPatterns = [
    /(?:[，,。；;]\s*)?(?:你)?帮我(?:整理|归类|判断|看看|看一下|处理|保存|记录|记)(?:一下|下)?[^。\n；;]*$/u,
    /(?:[，,。；;]\s*)?看看放哪里(?:比较)?合适[^。\n；;]*$/u,
    /(?:[，,。；;]\s*)?我之后还得记一下\s*$/u,
    /(?:[，,。；;]\s*)?之后还得记一下\s*$/u,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of suffixPatterns) {
      const next = text.replace(pattern, '').trim();
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
  }
  return text
    .replace(/[，,。；;]\s*$/u, '')
    .trim();
}

function inferExplicitEditType(text: string): AssistantRecordType | null {
  const value = String(text ?? '').trim();
  if (!value) {
    return null;
  }
  if (/(?:改成|改为|设为|设置成|类型.*(?:是|为)|不是.*是|做成|作为).*(?:提醒|reminder)/iu.test(value)) {
    return 'reminder';
  }
  if (/(?:改成|改为|设为|设置成|类型.*(?:是|为)|不是.*是|做成|作为).*(?:代办|待办|todo|任务)/iu.test(value)) {
    return 'todo';
  }
  if (/(?:改成|改为|设为|设置成|类型.*(?:是|为)|不是.*是|做成|作为).*(?:日志|log)/iu.test(value)) {
    return 'log';
  }
  if (/(?:改成|改为|设为|设置成|类型.*(?:是|为)|不是.*是|做成|作为).*(?:笔记|note)/iu.test(value)) {
    return 'note';
  }
  return null;
}

function applyContentEdit(content: string, instruction: string): { content: string; changed: boolean } {
  const current = String(content ?? '').trim();
  const normalizedInstruction = String(instruction ?? '').trim();
  const replacement = normalizedInstruction.match(/(?:把|将)\s*(.+?)\s*(?:改成|改为|换成|替换为)\s*(.+?)(?:[，,。；;]|$)/u);
  if (replacement) {
    const from = normalizeReplacementPart(replacement[1]);
    const to = normalizeReplacementPart(replacement[2]);
    if (from && current.includes(from)) {
      return {
        content: current.replace(from, to),
        changed: true,
      };
    }
  }
  const append = normalizedInstruction.match(/^(?:补充|追加|加上|添加)[:：]?\s*(.+)$/u);
  if (append) {
    return {
      content: appendContent(current, normalizeReplacementPart(append[1])),
      changed: true,
    };
  }
  return {
    content: current,
    changed: false,
  };
}

function applyDatePhraseEdit(content: string, instruction: string): { content: string; changed: boolean } {
  const current = String(content ?? '').trim();
  const nextPhrase = extractDatePhrase(instruction);
  const currentPhrase = extractDatePhrase(current);
  if (!current || !nextPhrase || !currentPhrase || currentPhrase === nextPhrase) {
    return { content: current, changed: false };
  }
  return {
    content: current.replace(currentPhrase, nextPhrase),
    changed: true,
  };
}

function extractDatePhrase(value: string): string | null {
  const text = String(value ?? '').trim();
  const patterns = [
    /每周[一二三四五六日天]?(?:早上|上午|下午|晚上)?\s*\d{0,2}(?:[:：]\d{1,2})?分?点?/u,
    /每天(?:早上|上午|下午|晚上)?\s*\d{0,2}(?:[:：]\d{1,2})?分?点?/u,
    /明天(?:早上|上午|下午|晚上)?\s*\d{1,2}(?:[:：]\d{1,2})?分?点?/u,
    /下周[一二三四五六日天](?:前)?(?:早上|上午|下午|晚上)?\s*\d{0,2}(?:[:：]\d{1,2})?分?点?/u,
    /(?:今天|今晚|上午|下午|晚上)\s*\d{1,2}(?:[:：]\d{1,2})?分?点?/u,
  ];
  for (const pattern of patterns) {
    const matched = text.match(pattern)?.[0]?.trim();
    if (matched) {
      return matched;
    }
  }
  return null;
}

function normalizeReplacementPart(value: unknown): string {
  return String(value ?? '')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .trim();
}

function appendContent(content: string, addition: string): string {
  const current = String(content ?? '').trim();
  const normalizedAddition = String(addition ?? '').trim();
  if (!current) {
    return normalizedAddition;
  }
  if (!normalizedAddition || current.includes(normalizedAddition)) {
    return current;
  }
  return `${current}\n补充修改：${normalizedAddition}`;
}

function appendOriginalText(originalText: string, instruction: string): string {
  const current = String(originalText ?? '').trim();
  const normalizedInstruction = String(instruction ?? '').trim();
  if (!current) {
    return normalizedInstruction;
  }
  if (!normalizedInstruction) {
    return current;
  }
  return `${current}\n\n修改提示：${normalizedInstruction}`;
}

function isMetadataOnlyEdit(
  instruction: string,
  flags: {
    explicitType: AssistantRecordType | null;
    hasDateEdit: boolean;
    hasPriorityEdit: boolean;
    hasTags: boolean;
  },
): boolean {
  if (!instruction.trim()) {
    return true;
  }
  if (/^(?:时间|提醒时间|到期时间|日期|类型|优先级|标签|项目)\s*(?:改成|改为|设为|设置成|换成|是|为)/u.test(instruction)) {
    return true;
  }
  if (flags.explicitType || flags.hasDateEdit || flags.hasPriorityEdit || flags.hasTags) {
    return !/(?:补充|追加|加上|添加|内容|描述|备注|把|将)/u.test(instruction);
  }
  return false;
}

function resolveEditedDueAt(
  record: AssistantRecord,
  draft: AssistantRecordDraft,
  nextType: AssistantRecordType,
  hasDateEdit: boolean,
): number | null {
  if (nextType !== 'todo') {
    return null;
  }
  if (!hasDateEdit) {
    return record.dueAt;
  }
  return draft.dueAt ?? draft.remindAt ?? record.dueAt;
}

function resolveEditedRemindAt(
  record: AssistantRecord,
  draft: AssistantRecordDraft,
  nextType: AssistantRecordType,
  hasDateEdit: boolean,
): number | null {
  if (nextType !== 'reminder') {
    return null;
  }
  if (!hasDateEdit) {
    return record.remindAt;
  }
  return draft.remindAt ?? draft.dueAt ?? record.remindAt;
}

function resolveEditedRecurrence(
  record: AssistantRecord,
  draft: AssistantRecordDraft,
  nextType: AssistantRecordType,
  hasDateEdit: boolean,
): string | null {
  if (nextType !== 'reminder') {
    return null;
  }
  if (!hasDateEdit) {
    return record.recurrence;
  }
  return draft.recurrence ?? null;
}

function containsPriorityInstruction(text: string): boolean {
  return /优先级|紧急|重要|不急|\bp[0-3]\b/iu.test(text);
}

function mergeTags(left: string[], right: string[]): string[] {
  return normalizeStringArray([...left, ...right]);
}

function inferRecordType(text: string): AssistantRecordType {
  const value = text.toLowerCase();
  if (/提醒|叫我|到时候|remind|每(天|周|月)|早上|上午|下午|晚上|\d{1,2}点/u.test(value)) {
    return 'reminder';
  }
  if (/待办|todo|任务|检查|整理|完成|处理|跟进|下周.*前|明天.*前|前$|欠我.*发票|发票.*(?:拿回|取回|欠)|要拿回/u.test(value)) {
    return 'todo';
  }
  if (/记录|日志|今天|刚刚|修复|测试|发现|复盘|完成了|log/u.test(value)) {
    return 'log';
  }
  if (/笔记|note|记一下/u.test(value)) {
    return 'note';
  }
  return 'note';
}

function parseDateInfo(text: string, now: number): {
  dueAt: number | null;
  remindAt: number | null;
  recurrence: string | null;
  matched: boolean;
} {
  const base = new Date(now);
  const daily = text.match(/每天(?:早上|上午|下午|晚上)?\s*(\d{1,2})(?:[:：](\d{1,2}))?分?|\bevery day\b/iu);
  if (daily) {
    const hour = daily[1] ? normalizeHour(Number(daily[1]), text) : 9;
    const minute = daily[2] ? Number(daily[2]) : 0;
    const next = nextDaily(base, hour, minute);
    return { dueAt: next, remindAt: next, recurrence: `daily ${pad2(hour)}:${pad2(minute)}`, matched: true };
  }
  const weekly = text.match(/每周([一二三四五六日天])?(?:早上|上午|下午|晚上)?\s*(\d{1,2})?(?:[:：](\d{1,2}))?分?/u);
  if (weekly) {
    const weekday = parseChineseWeekday(weekly[1] ?? '一');
    const hour = weekly[2] ? normalizeHour(Number(weekly[2]), text) : 9;
    const minute = weekly[3] ? Number(weekly[3]) : 0;
    const next = nextWeekly(base, weekday, hour, minute);
    return { dueAt: next, remindAt: next, recurrence: `weekly ${weekday} ${pad2(hour)}:${pad2(minute)}`, matched: true };
  }
  const tomorrow = text.match(/明天(?:早上|上午|下午|晚上)?\s*(\d{1,2})(?:[:：](\d{1,2}))?分?点?/u);
  if (tomorrow) {
    const hour = normalizeHour(Number(tomorrow[1]), text);
    const minute = tomorrow[2] ? Number(tomorrow[2]) : 0;
    const next = atOffsetDay(base, 1, hour, minute);
    return { dueAt: next, remindAt: next, recurrence: null, matched: true };
  }
  const nextWeek = text.match(/下周([一二三四五六日天])(?:前)?(?:早上|上午|下午|晚上)?\s*(\d{1,2})?(?:[:：](\d{1,2}))?分?/u);
  if (nextWeek) {
    const weekday = parseChineseWeekday(nextWeek[1]);
    const hour = nextWeek[2] ? normalizeHour(Number(nextWeek[2]), text) : 18;
    const minute = nextWeek[3] ? Number(nextWeek[3]) : 0;
    const next = nextWeekly(base, weekday, hour, minute, true);
    return { dueAt: next, remindAt: next, recurrence: null, matched: true };
  }
  const today = text.match(/(?:今天|今晚|上午|下午|晚上)\s*(\d{1,2})(?:[:：](\d{1,2}))?分?点?/u);
  if (today) {
    const hour = normalizeHour(Number(today[1]), text);
    const minute = today[2] ? Number(today[2]) : 0;
    let next = atOffsetDay(base, 0, hour, minute);
    if (next <= now) {
      next = atOffsetDay(base, 1, hour, minute);
    }
    return { dueAt: next, remindAt: next, recurrence: null, matched: true };
  }
  return { dueAt: null, remindAt: null, recurrence: null, matched: false };
}

function inferPriority(text: string): AssistantRecordPriority {
  if (/紧急|重要|高优先级|\bp0\b|\bp1\b/iu.test(text)) {
    return 'high';
  }
  if (/不急|低优先级|\bp3\b/iu.test(text)) {
    return 'low';
  }
  return 'normal';
}

function inferProject(tags: string[]): string | null {
  return tags.find((tag) => tag.toLowerCase() !== 'p0' && tag.toLowerCase() !== 'p1') ?? null;
}

function extractTags(text: string): string[] {
  const tags = new Set<string>();
  for (const match of text.matchAll(/#([\p{L}\p{N}_-]+)/gu)) {
    const value = String(match[1] ?? '').trim();
    if (value) {
      tags.add(value);
    }
  }
  return [...tags];
}

function buildTitle(text: string, type: AssistantRecordType): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return normalizeTitle('', type);
  }
  const invoiceDebt = normalized.match(/^(.{1,24}?)\s*现在?还?欠我\s*([0-9一二三四五六七八九十]+)\s*张发票/u);
  if (invoiceDebt) {
    return truncate(`${invoiceDebt[1].trim()}待取回 ${invoiceDebt[2]} 张发票`, 42);
  }
  if (/要拿回来?的?发票|待取回.*发票/u.test(normalized)) {
    return '待取回发票清单';
  }
  return truncate(normalized, 42);
}

function normalizeTitle(title: string, type: AssistantRecordType): string {
  const normalized = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (normalized) {
    return truncate(normalized, 60);
  }
  switch (type) {
    case 'log':
      return '未命名日志';
    case 'todo':
      return '未命名代办';
    case 'reminder':
      return '未命名提醒';
    case 'note':
      return '未命名笔记';
    default:
      return '未分类记录';
  }
}

function computeConfidence({
  forcedType,
  type,
  text,
  dateInfo,
}: {
  forcedType: AssistantRecordType | null;
  type: AssistantRecordType;
  text: string;
  dateInfo: { matched: boolean };
}): number {
  if (forcedType) {
    return type === 'reminder' && !dateInfo.matched ? 0.65 : 0.92;
  }
  if (!text.trim()) {
    return 0.2;
  }
  if (type === 'reminder') {
    return dateInfo.matched ? 0.86 : 0.68;
  }
  if (type === 'todo') {
    return 0.82;
  }
  return 0.78;
}

function normalizeHour(hour: number, text: string): number {
  if (/下午|晚上|今晚/u.test(text) && hour >= 1 && hour < 12) {
    return hour + 12;
  }
  return Math.max(0, Math.min(23, hour));
}

function atOffsetDay(base: Date, dayOffset: number, hour: number, minute: number): number {
  const next = new Date(base);
  next.setDate(next.getDate() + dayOffset);
  next.setHours(hour, Math.max(0, Math.min(59, minute)), 0, 0);
  return next.getTime();
}

function nextDaily(base: Date, hour: number, minute: number): number {
  let next = atOffsetDay(base, 0, hour, minute);
  if (next <= base.getTime()) {
    next = atOffsetDay(base, 1, hour, minute);
  }
  return next;
}

function nextWeekly(base: Date, weekday: number, hour: number, minute: number, forceNextWeek = false): number {
  const next = new Date(base);
  const currentWeekday = next.getDay();
  let days = (weekday - currentWeekday + 7) % 7;
  if (days === 0 && (forceNextWeek || atOffsetDay(base, 0, hour, minute) <= base.getTime())) {
    days = 7;
  }
  next.setDate(next.getDate() + days);
  next.setHours(hour, minute, 0, 0);
  return next.getTime();
}

function parseChineseWeekday(value: string): number {
  const map: Record<string, number> = {
    日: 0,
    天: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
  };
  return map[value] ?? 1;
}

function computeNextReminderAt(record: AssistantRecord, now: number): number | null {
  const recurrence = String(record.recurrence ?? '').trim();
  if (!recurrence) {
    return null;
  }
  const daily = recurrence.match(/^daily\s+(\d{2}):(\d{2})$/u);
  if (daily) {
    return nextDaily(new Date(now), Number(daily[1]), Number(daily[2]));
  }
  const weekly = recurrence.match(/^weekly\s+(\d)\s+(\d{2}):(\d{2})$/u);
  if (weekly) {
    return nextWeekly(new Date(now), Number(weekly[1]), Number(weekly[2]), Number(weekly[3]), true);
  }
  return null;
}

function buildDayDirectory(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    String(date.getFullYear()),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join(path.sep);
}

function mapUploadKind(kind: string, mimeType: string | null, filename: string): AssistantAttachmentKind {
  const mime = String(mimeType ?? '').toLowerCase();
  const ext = path.extname(filename).toLowerCase();
  if (kind === 'image' || mime.startsWith('image/')) {
    return 'image';
  }
  if (kind === 'video' || mime.startsWith('video/')) {
    return 'video';
  }
  if (kind === 'voice' || mime.startsWith('audio/')) {
    return 'audio';
  }
  if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) {
    return 'archive';
  }
  if (kind === 'file') {
    return 'document';
  }
  return 'other';
}

async function readFileSize(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.size;
  } catch {
    return null;
  }
}

async function hashFile(filePath: string): Promise<string | null> {
  try {
    return await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  } catch {
    return null;
  }
}

function sanitizePathSegment(value: string): string {
  const normalized = String(value ?? 'file')
    .replace(/[\\/:"*?<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');
  return truncate(normalized || 'file', 120);
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const normalized = new Set<string>();
  for (const value of values) {
    const text = normalizeNullableString(value);
    if (text) {
      normalized.add(text);
    }
  }
  return [...normalized];
}

function normalizeTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
