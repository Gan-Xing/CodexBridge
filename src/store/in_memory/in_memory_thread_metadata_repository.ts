import type { ThreadMetadata } from '../../types/core.js';
import type { ThreadMetadataRepository } from '../../types/repository.js';

export class InMemoryThreadMetadataRepository implements ThreadMetadataRepository {
  constructor() {
    this.records = new Map();
  }

  records: Map<string, ThreadMetadata>;

  save(metadata: ThreadMetadata): ThreadMetadata {
    this.records.set(buildMetadataKey(metadata.providerProfileId, metadata.threadId), metadata);
    return metadata;
  }

  get(providerProfileId: string, threadId: string): ThreadMetadata | null {
    return this.records.get(buildMetadataKey(providerProfileId, threadId)) ?? null;
  }

  listByProviderProfileId(providerProfileId: string): ThreadMetadata[] {
    return [...this.records.values()].filter((record) => record.providerProfileId === providerProfileId);
  }

  getByThread(providerProfileId: string, threadId: string): ThreadMetadata | null {
    return this.get(providerProfileId, threadId);
  }
}

function buildMetadataKey(providerProfileId: string, threadId: string) {
  return `${providerProfileId}:${threadId}`;
}
