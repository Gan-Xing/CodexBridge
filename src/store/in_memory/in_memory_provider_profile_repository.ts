import type { ProviderProfile } from '../../types/provider.js';
import type { ProviderProfileRepository } from '../../types/repository.js';

export class InMemoryProviderProfileRepository implements ProviderProfileRepository {
  constructor() {
    this.records = new Map();
  }

  records: Map<string, ProviderProfile>;

  save(profile: ProviderProfile): ProviderProfile {
    this.records.set(profile.id, profile);
    return profile;
  }

  get(id: string): ProviderProfile | null {
    return this.records.get(id) ?? null;
  }

  list(): ProviderProfile[] {
    return [...this.records.values()];
  }

  getById(id: string): ProviderProfile | null {
    return this.get(id);
  }
}
