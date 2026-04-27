import type { AssistantRecord } from '../../types/core.js';
import type { AssistantRecordRepository } from '../../types/repository.js';

export class InMemoryAssistantRecordRepository implements AssistantRecordRepository {
  records = new Map<string, AssistantRecord>();

  getById(id: string): AssistantRecord | null {
    return this.records.get(id) ?? null;
  }

  save(record: AssistantRecord): AssistantRecord {
    this.records.set(record.id, cloneAssistantRecord(record));
    return record;
  }

  delete(id: string): void {
    this.records.delete(id);
  }

  list(): AssistantRecord[] {
    return Array.from(this.records.values()).map(cloneAssistantRecord);
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
