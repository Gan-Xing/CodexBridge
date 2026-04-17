import { JsonFileStore } from './json_file_store.js';

export class FileJsonThreadMetadataRepository {
  constructor(filePath) {
    this.store = new JsonFileStore(filePath, []);
  }

  save(metadata) {
    const records = this.listAll();
    const next = upsertBy(records, metadata, (record) =>
      record.providerProfileId === metadata.providerProfileId && record.threadId === metadata.threadId,
    );
    this.store.write(next);
    return metadata;
  }

  get(providerProfileId, threadId) {
    return this.listAll().find((record) =>
      record.providerProfileId === providerProfileId && record.threadId === threadId,
    ) ?? null;
  }

  listByProviderProfileId(providerProfileId) {
    return this.listAll().filter((record) => record.providerProfileId === providerProfileId);
  }

  listAll() {
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
