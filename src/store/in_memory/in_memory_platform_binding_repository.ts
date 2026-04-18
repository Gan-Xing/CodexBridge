import { formatPlatformScopeKey } from '../../core/contracts.js';
import type { PlatformBinding } from '../../types/repository.js';
import type { PlatformBindingRepository } from '../../types/repository.js';

export class InMemoryPlatformBindingRepository implements PlatformBindingRepository {
  constructor() {
    this.records = new Map();
  }

  records: Map<string, PlatformBinding>;

  setBinding(binding: PlatformBinding): PlatformBinding {
    this.records.set(formatPlatformScopeKey(binding.platform, binding.externalScopeId), binding);
    return binding;
  }

  getBinding({ platform, externalScopeId }: { platform: string; externalScopeId: string }): PlatformBinding | null {
    return this.records.get(formatPlatformScopeKey(platform, externalScopeId)) ?? null;
  }

  listBindingsForSession(bridgeSessionId: string): PlatformBinding[] {
    return [...this.records.values()].filter((binding) => binding.bridgeSessionId === bridgeSessionId);
  }

  getByScope(platform: string, externalScopeId: string): PlatformBinding | null {
    return this.getBinding({ platform, externalScopeId });
  }

  save(binding: PlatformBinding): PlatformBinding {
    return this.setBinding(binding);
  }

  list(): PlatformBinding[] {
    return [...this.records.values()];
  }
}
