import { JsonFileStore } from './json_file_store.js';

export class FileJsonBridgeSessionRepository {
  constructor(filePath) {
    this.store = new JsonFileStore(filePath, []);
  }

  save(session) {
    const records = this.list();
    const next = upsertBy(records, session, (record) => record.id === session.id);
    this.store.write(next);
    return session;
  }

  get(id) {
    return this.list().find((record) => record.id === id) ?? null;
  }

  getByProviderThread(providerProfileId, codexThreadId) {
    return this.list().find((record) =>
      record.providerProfileId === providerProfileId && record.codexThreadId === codexThreadId,
    ) ?? null;
  }

  listByProviderProfileId(providerProfileId) {
    return this.list().filter((record) => record.providerProfileId === providerProfileId);
  }

  list() {
    return this.store.read();
  }
}

function upsertBy(records, value, matcher) {
  const next = [...records];
  const index = next.findIndex(matcher);
  if (index >= 0) {
    next[index] = value;
    return next;
  }
  next.push(value);
  return next;
}
