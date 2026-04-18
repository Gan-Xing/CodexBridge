import { JsonFileStore } from './json_file_store.js';
import type { ThreadMetadata } from '../../types/core.js';
import type { ThreadMetadataRepository } from '../../types/repository.js';

export class FileJsonThreadMetadataRepository implements ThreadMetadataRepository {
  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, []);
  }

  store: JsonFileStore<ThreadMetadata[]>;

  save(metadata: ThreadMetadata): ThreadMetadata {
    const records = this.listAll();
    const next = upsertBy(records, metadata, (record) =>
      record.providerProfileId === metadata.providerProfileId && record.threadId === metadata.threadId,
    );
    this.store.write(next);
    return metadata;
  }

  get(providerProfileId: string, threadId: string): ThreadMetadata | null {
    return this.listAll().find((record) =>
      record.providerProfileId === providerProfileId && record.threadId === threadId,
    ) ?? null;
  }

  listByProviderProfileId(providerProfileId: string): ThreadMetadata[] {
    return this.listAll().filter((record) => record.providerProfileId === providerProfileId);
  }

  listAll(): ThreadMetadata[] {
    return this.store.read();
  }

  getByThread(providerProfileId: string, threadId: string): ThreadMetadata | null {
    return this.get(providerProfileId, threadId);
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
