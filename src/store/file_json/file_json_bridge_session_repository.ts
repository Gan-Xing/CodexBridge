import { JsonFileStore } from './json_file_store.js';
import type { BridgeSession } from '../../types/core.js';
import type { BridgeSessionRepository } from '../../types/repository.js';

export class FileJsonBridgeSessionRepository implements BridgeSessionRepository {
  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, []);
  }

  store: JsonFileStore<BridgeSession[]>;

  save(session: BridgeSession): BridgeSession {
    const records = this.list();
    const next = upsertBy(records, session, (record) => record.id === session.id);
    this.store.write(next);
    return session;
  }

  get(id: string): BridgeSession | null {
    return this.list().find((record) => record.id === id) ?? null;
  }

  getByProviderThread(providerProfileId: string, codexThreadId: string): BridgeSession | null {
    return this.list().find((record) =>
      record.providerProfileId === providerProfileId && record.codexThreadId === codexThreadId,
    ) ?? null;
  }

  listByProviderProfileId(providerProfileId: string): BridgeSession[] {
    return this.list().filter((record) => record.providerProfileId === providerProfileId);
  }

  list(): BridgeSession[] {
    return this.store.read();
  }

  getById(id: string): BridgeSession | null {
    return this.get(id);
  }

  delete(id: string): void {
    this.store.write(this.list().filter((record) => record.id !== id));
  }
}

function upsertBy<T>(records: T[], value: T, matcher: (record: T) => boolean) {
  const next = [...records];
  const index = next.findIndex(matcher);
  if (index >= 0) {
    next[index] = value;
    return next;
  }
  next.push(value);
  return next;
}
