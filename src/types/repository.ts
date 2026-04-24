import type { AutomationJob, BridgeSession, SessionSettings, ThreadMetadata } from './core.js';
import type { ProviderProfile } from './provider.js';

export interface PlatformBinding {
  platform: string;
  externalScopeId: string;
  bridgeSessionId: string;
  updatedAt: number;
}

export interface ProviderProfileRepository {
  getById(id: string): ProviderProfile | null;
  list(): ProviderProfile[];
  save(profile: ProviderProfile): ProviderProfile;
}

export interface BridgeSessionRepository {
  getById(id: string): BridgeSession | null;
  save(session: BridgeSession): BridgeSession;
  delete(id: string): void;
  list(): BridgeSession[];
}

export interface PlatformBindingRepository {
  getByScope(platform: string, externalScopeId: string): PlatformBinding | null;
  save(binding: PlatformBinding): PlatformBinding;
  list(): PlatformBinding[];
}

export interface SessionSettingsRepository {
  getByBridgeSessionId(bridgeSessionId: string): SessionSettings | null;
  save(settings: SessionSettings): SessionSettings;
}

export interface ThreadMetadataRepository {
  getByThread(providerProfileId: string, threadId: string): ThreadMetadata | null;
  save(metadata: ThreadMetadata): ThreadMetadata;
  listByProviderProfileId(providerProfileId: string): ThreadMetadata[];
}

export interface AutomationJobRepository {
  getById(id: string): AutomationJob | null;
  save(job: AutomationJob): AutomationJob;
  delete(id: string): void;
  list(): AutomationJob[];
}
