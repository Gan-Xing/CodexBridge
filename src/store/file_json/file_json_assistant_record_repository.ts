import { JsonFileStore } from './json_file_store.js';
import type { AssistantRecord } from '../../types/core.js';
import type { AssistantRecordRepository } from '../../types/repository.js';

export class FileJsonAssistantRecordRepository implements AssistantRecordRepository {
  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, []);
  }

  store: JsonFileStore<AssistantRecord[]>;

  getById(id: string): AssistantRecord | null {
    return this.list().find((record) => record.id === id) ?? null;
  }

  save(record: AssistantRecord): AssistantRecord {
    const records = this.list();
    const next = upsertBy(records, cloneAssistantRecord(record), (existing) => existing.id === record.id);
    this.store.write(next);
    return record;
  }

  delete(id: string): void {
    this.store.write(this.list().filter((record) => record.id !== id));
  }

  list(): AssistantRecord[] {
    return this.store.read().map(cloneAssistantRecord);
  }
}

function cloneAssistantRecord(record: AssistantRecord): AssistantRecord {
  return {
    ...record,
    tags: [...record.tags],
    attachments: record.attachments.map((attachment) => ({ ...attachment })),
    parsedJson: record.parsedJson ? { ...record.parsedJson } : null,
  };
}

function upsertBy<T>(records: T[], value: T, matcher: (record: T) => boolean): T[] {
  const next = [...records];
  const index = next.findIndex(matcher);
  if (index >= 0) {
    next[index] = value;
    return next;
  }
  next.push(value);
  return next;
}
