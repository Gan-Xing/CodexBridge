import { JsonFileStore } from './json_file_store.js';
import type { AgentJob } from '../../types/core.js';
import type { AgentJobRepository } from '../../types/repository.js';

export class FileJsonAgentJobRepository implements AgentJobRepository {
  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, []);
  }

  store: JsonFileStore<AgentJob[]>;

  getById(id: string): AgentJob | null {
    return this.list().find((record) => record.id === id) ?? null;
  }

  save(job: AgentJob): AgentJob {
    const records = this.list();
    const next = upsertBy(records, job, (record) => record.id === job.id);
    this.store.write(next);
    return job;
  }

  delete(id: string): void {
    this.store.write(this.list().filter((record) => record.id !== id));
  }

  list(): AgentJob[] {
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
