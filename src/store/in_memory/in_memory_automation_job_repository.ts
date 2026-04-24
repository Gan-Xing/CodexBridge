import type { AutomationJob } from '../../types/core.js';
import type { AutomationJobRepository } from '../../types/repository.js';

export class InMemoryAutomationJobRepository implements AutomationJobRepository {
  constructor() {
    this.records = new Map();
  }

  records: Map<string, AutomationJob>;

  getById(id: string): AutomationJob | null {
    return this.records.get(id) ?? null;
  }

  save(job: AutomationJob): AutomationJob {
    this.records.set(job.id, job);
    return job;
  }

  delete(id: string): void {
    this.records.delete(id);
  }

  list(): AutomationJob[] {
    return [...this.records.values()];
  }
}
