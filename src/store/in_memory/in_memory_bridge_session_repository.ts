import type { BridgeSession } from '../../types/core.js';
import type { BridgeSessionRepository } from '../../types/repository.js';

export class InMemoryBridgeSessionRepository implements BridgeSessionRepository {
  constructor() {
    this.records = new Map();
  }

  records: Map<string, BridgeSession>;

  save(session: BridgeSession): BridgeSession {
    this.records.set(session.id, session);
    return session;
  }

  get(id: string): BridgeSession | null {
    return this.records.get(id) ?? null;
  }

  getByProviderThread(providerProfileId: string, codexThreadId: string): BridgeSession | null {
    return this.list().find((session) =>
      session.providerProfileId === providerProfileId && session.codexThreadId === codexThreadId,
    ) ?? null;
  }

  listByProviderProfileId(providerProfileId: string): BridgeSession[] {
    return this.list().filter((session) => session.providerProfileId === providerProfileId);
  }

  list(): BridgeSession[] {
    return [...this.records.values()];
  }

  getById(id: string): BridgeSession | null {
    return this.get(id);
  }

  delete(id: string): void {
    this.records.delete(id);
  }
}
