import type { AgentJob, AutomationJob, BridgeSession, PluginAlias, SessionSettings, ThreadMetadata } from './core.js';
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

export interface PluginAliasRepository {
  getByAlias(platform: string, externalScopeId: string, providerProfileId: string, alias: string): PluginAlias | null;
  save(alias: PluginAlias): PluginAlias;
  delete(platform: string, externalScopeId: string, providerProfileId: string, alias: string): void;
  listByScope(platform: string, externalScopeId: string, providerProfileId: string): PluginAlias[];
}

export interface AutomationJobRepository {
  getById(id: string): AutomationJob | null;
  save(job: AutomationJob): AutomationJob;
  delete(id: string): void;
  list(): AutomationJob[];
}

export interface AgentJobRepository {
  getById(id: string): AgentJob | null;
  save(job: AgentJob): AgentJob;
  delete(id: string): void;
  list(): AgentJob[];
}
