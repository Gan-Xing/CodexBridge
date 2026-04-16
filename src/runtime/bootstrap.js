import { BridgeSessionService } from '../core/bridge_session_service.js';
import { BridgeCoordinator } from '../core/bridge_coordinator.js';
import { SessionRouter } from '../core/session_router.js';
import { InMemoryBridgeSessionRepository } from '../store/in_memory/in_memory_bridge_session_repository.js';
import { InMemoryPlatformBindingRepository } from '../store/in_memory/in_memory_platform_binding_repository.js';
import { InMemoryProviderProfileRepository } from '../store/in_memory/in_memory_provider_profile_repository.js';
import { InMemorySessionSettingsRepository } from '../store/in_memory/in_memory_session_settings_repository.js';
import { PluginRegistry } from './plugin_registry.js';

export function createCodexBridgeRuntime({
  platformPlugins = [],
  providerPlugins = [],
  providerProfiles = [],
  defaultProviderProfileId = null,
  repositories = {},
  restartBridge = null,
} = {}) {
  const registry = new PluginRegistry();
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

  for (const providerProfile of providerProfiles) {
    providerProfilesRepository.save(providerProfile);
  }

  const sessionRouter = new SessionRouter({
    platformBindings: platformBindingsRepository,
    bridgeSessions: bridgeSessionsRepository,
  });

  const bridgeSessions = new BridgeSessionService({
    providerProfiles: providerProfilesRepository,
    bridgeSessions: bridgeSessionsRepository,
    sessionSettings: sessionSettingsRepository,
    providerRegistry: registry,
    sessionRouter,
  });

  const resolvedDefaultProviderProfileId = defaultProviderProfileId
    ?? providerProfiles[0]?.id
    ?? null;
  const bridgeCoordinator = new BridgeCoordinator({
    bridgeSessions,
    providerProfiles: providerProfilesRepository,
    providerRegistry: registry,
    defaultProviderProfileId: resolvedDefaultProviderProfileId,
    restartBridge,
  });

  return {
    registry,
    config: {
      defaultProviderProfileId: resolvedDefaultProviderProfileId,
    },
    repositories: {
      providerProfiles: providerProfilesRepository,
      bridgeSessions: bridgeSessionsRepository,
      platformBindings: platformBindingsRepository,
      sessionSettings: sessionSettingsRepository,
    },
    services: {
      sessionRouter,
      bridgeSessions,
      bridgeCoordinator,
    },
  };
}
