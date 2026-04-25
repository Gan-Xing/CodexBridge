import type {
  AutomationJobRepository,
  BridgeSessionRepository,
  PlatformBindingRepository,
  PluginAliasRepository,
  ProviderProfileRepository,
  SessionSettingsRepository,
  ThreadMetadataRepository,
} from '../../types/repository.js';
import path from 'node:path';
import { FileJsonAutomationJobRepository } from './file_json_automation_job_repository.js';
import { FileJsonBridgeSessionRepository } from './file_json_bridge_session_repository.js';
import { FileJsonPlatformBindingRepository } from './file_json_platform_binding_repository.js';
import { FileJsonPluginAliasRepository } from './file_json_plugin_alias_repository.js';
import { FileJsonProviderProfileRepository } from './file_json_provider_profile_repository.js';
import { FileJsonSessionSettingsRepository } from './file_json_session_settings_repository.js';
import { FileJsonThreadMetadataRepository } from './file_json_thread_metadata_repository.js';

export function createFileJsonRepositories(stateDir: string): {
  providerProfiles: ProviderProfileRepository;
  bridgeSessions: BridgeSessionRepository;
  platformBindings: PlatformBindingRepository;
  pluginAliases: PluginAliasRepository;
  sessionSettings: SessionSettingsRepository;
  threadMetadata: ThreadMetadataRepository;
  automationJobs: AutomationJobRepository;
} {
  return {
    providerProfiles: new FileJsonProviderProfileRepository(path.join(stateDir, 'provider_profiles.json')),
    bridgeSessions: new FileJsonBridgeSessionRepository(path.join(stateDir, 'bridge_sessions.json')),
    platformBindings: new FileJsonPlatformBindingRepository(path.join(stateDir, 'platform_bindings.json')),
    pluginAliases: new FileJsonPluginAliasRepository(path.join(stateDir, 'plugin_aliases.json')),
    sessionSettings: new FileJsonSessionSettingsRepository(path.join(stateDir, 'session_settings.json')),
    threadMetadata: new FileJsonThreadMetadataRepository(path.join(stateDir, 'thread_metadata.json')),
    automationJobs: new FileJsonAutomationJobRepository(path.join(stateDir, 'automation_jobs.json')),
  };
}
