import { JsonFileStore } from './json_file_store.js';
import type { AutomationJob } from '../../types/core.js';
import type { AutomationJobRepository } from '../../types/repository.js';

export class FileJsonAutomationJobRepository implements AutomationJobRepository {
  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, []);
  }

  store: JsonFileStore<AutomationJob[]>;

  getById(id: string): AutomationJob | null {
    return this.list().find((record) => record.id === id) ?? null;
  }

  save(job: AutomationJob): AutomationJob {
    const records = this.list();
    const next = upsertBy(records, job, (record) => record.id === job.id);
    this.store.write(next);
    return job;
  }

  delete(id: string): void {
    this.store.write(this.list().filter((record) => record.id !== id));
  }

  list(): AutomationJob[] {
    return this.store.read();
  }
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
