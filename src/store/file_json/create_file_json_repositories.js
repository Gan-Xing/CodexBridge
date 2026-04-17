import path from 'node:path';
import { FileJsonBridgeSessionRepository } from './file_json_bridge_session_repository.js';
import { FileJsonPlatformBindingRepository } from './file_json_platform_binding_repository.js';
import { FileJsonProviderProfileRepository } from './file_json_provider_profile_repository.js';
import { FileJsonSessionSettingsRepository } from './file_json_session_settings_repository.js';
import { FileJsonThreadMetadataRepository } from './file_json_thread_metadata_repository.js';

export function createFileJsonRepositories(stateDir) {
  return {
    providerProfiles: new FileJsonProviderProfileRepository(path.join(stateDir, 'provider_profiles.json')),
    bridgeSessions: new FileJsonBridgeSessionRepository(path.join(stateDir, 'bridge_sessions.json')),
    platformBindings: new FileJsonPlatformBindingRepository(path.join(stateDir, 'platform_bindings.json')),
    sessionSettings: new FileJsonSessionSettingsRepository(path.join(stateDir, 'session_settings.json')),
    threadMetadata: new FileJsonThreadMetadataRepository(path.join(stateDir, 'thread_metadata.json')),
  };
}
