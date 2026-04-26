import type { AgentJob } from '../../types/core.js';
import type { AgentJobRepository } from '../../types/repository.js';

export class InMemoryAgentJobRepository implements AgentJobRepository {
  constructor() {
    this.records = new Map();
  }

  records: Map<string, AgentJob>;

  getById(id: string): AgentJob | null {
    return this.records.get(id) ?? null;
  }

  save(job: AgentJob): AgentJob {
    this.records.set(job.id, job);
    return job;
  }

  delete(id: string): void {
    this.records.delete(id);
  }

  list(): AgentJob[] {
    return [...this.records.values()];
  }
}
