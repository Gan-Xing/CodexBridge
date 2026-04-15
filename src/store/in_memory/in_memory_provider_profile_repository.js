export class InMemoryProviderProfileRepository {
  constructor() {
    this.records = new Map();
  }

  save(profile) {
    this.records.set(profile.id, profile);
    return profile;
  }

  get(id) {
    return this.records.get(id) ?? null;
  }

  list() {
    return [...this.records.values()];
  }
}
