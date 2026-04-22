import { ActiveTurnRegistry } from '../core/active_turn_registry.js';
import { BridgeSessionService } from '../core/bridge_session_service.js';
import { BridgeCoordinator } from '../core/bridge_coordinator.js';
import { SessionRouter } from '../core/session_router.js';
import { InMemoryBridgeSessionRepository } from '../store/in_memory/in_memory_bridge_session_repository.js';
import { InMemoryPlatformBindingRepository } from '../store/in_memory/in_memory_platform_binding_repository.js';
import { InMemoryProviderProfileRepository } from '../store/in_memory/in_memory_provider_profile_repository.js';
import { InMemorySessionSettingsRepository } from '../store/in_memory/in_memory_session_settings_repository.js';
import { InMemoryThreadMetadataRepository } from '../store/in_memory/in_memory_thread_metadata_repository.js';
import { PluginRegistry } from './plugin_registry.js';
import type { ProviderProfile } from '../types/provider.js';

interface RuntimeRepositories {
  providerProfiles?: any;
  bridgeSessions?: any;
  platformBindings?: any;
  sessionSettings?: any;
  threadMetadata?: any;
}

interface CreateCodexBridgeRuntimeOptions {
  platformPlugins?: any[];
  providerPlugins?: any[];
  providerProfiles?: ProviderProfile[];
  defaultProviderProfileId?: string | null;
  defaultCwd?: string | null;
  locale?: string | null;
  repositories?: RuntimeRepositories;
  restartBridge?: ((params: { event: any }) => Promise<void>) | null;
  codexAuthManager?: any;
  codexInstructionsManager?: any;
}

export function createCodexBridgeRuntime({
  platformPlugins = [],
  providerPlugins = [],
  providerProfiles = [],
  defaultProviderProfileId = null,
  defaultCwd = null,
  locale = null,
  repositories = {},
  restartBridge = null,
  codexAuthManager = null,
  codexInstructionsManager = null,
}: CreateCodexBridgeRuntimeOptions = {}) {
  const registry = new PluginRegistry({
    locale,
  });
  for (const platformPlugin of platformPlugins) {
    registry.registerPlatform(platformPlugin);
  }
  for (const providerPlugin of providerPlugins) {
    registry.registerProvider(providerPlugin);
  }

  const providerProfilesRepository = repositories.providerProfiles ?? new InMemoryProviderProfileRepository();
  const bridgeSessionsRepository = repositories.bridgeSessions ?? new InMemoryBridgeSessionRepository();
  const platformBindingsRepository = repositories.platformBindings ?? new InMemoryPlatformBindingRepository();
  const sessionSettingsRepository = repositories.sessionSettings ?? new InMemorySessionSettingsRepository();
  const threadMetadataRepository = repositories.threadMetadata ?? new InMemoryThreadMetadataRepository();

  for (const providerProfile of providerProfiles) {
    providerProfilesRepository.save(providerProfile);
  }

  const sessionRouter = new SessionRouter({
    platformBindings: platformBindingsRepository,
    bridgeSessions: bridgeSessionsRepository,
    locale,
  });

  const bridgeSessions = new BridgeSessionService({
    providerProfiles: providerProfilesRepository,
    bridgeSessions: bridgeSessionsRepository,
    sessionSettings: sessionSettingsRepository,
    threadMetadata: threadMetadataRepository,
    providerRegistry: registry,
    sessionRouter,
    locale,
  });
  const activeTurns = new ActiveTurnRegistry({ locale });

  const resolvedDefaultProviderProfileId = defaultProviderProfileId
    ?? providerProfiles[0]?.id
    ?? null;
  const bridgeCoordinator = new BridgeCoordinator({
    bridgeSessions,
    activeTurns,
    providerProfiles: providerProfilesRepository,
    providerRegistry: registry,
    defaultProviderProfileId: resolvedDefaultProviderProfileId,
    defaultCwd,
    restartBridge,
    codexAuthManager,
    codexInstructionsManager,
    locale,
  });

  return {
    registry,
    config: {
      defaultProviderProfileId: resolvedDefaultProviderProfileId,
      defaultCwd,
      locale,
    },
    repositories: {
      providerProfiles: providerProfilesRepository,
      bridgeSessions: bridgeSessionsRepository,
      platformBindings: platformBindingsRepository,
      sessionSettings: sessionSettingsRepository,
      threadMetadata: threadMetadataRepository,
    },
    services: {
      activeTurns,
      sessionRouter,
      bridgeSessions,
      bridgeCoordinator,
    },
  };
}
