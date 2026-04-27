import path from 'node:path';
import { ActiveTurnRegistry } from '../core/active_turn_registry.js';
import { AgentJobService } from '../core/agent_job_service.js';
import { AssistantRecordService } from '../core/assistant_record_service.js';
import { AutomationJobService } from '../core/automation_job_service.js';
import { BridgeSessionService } from '../core/bridge_session_service.js';
import { BridgeCoordinator } from '../core/bridge_coordinator.js';
import { WeiboHotSearchService } from '../services/weibo_hot_search.js';
import { SessionRouter } from '../core/session_router.js';
import { InMemoryAgentJobRepository } from '../store/in_memory/in_memory_agent_job_repository.js';
import { InMemoryAssistantRecordRepository } from '../store/in_memory/in_memory_assistant_record_repository.js';
import { InMemoryAutomationJobRepository } from '../store/in_memory/in_memory_automation_job_repository.js';
import { InMemoryBridgeSessionRepository } from '../store/in_memory/in_memory_bridge_session_repository.js';
import { InMemoryPlatformBindingRepository } from '../store/in_memory/in_memory_platform_binding_repository.js';
import { InMemoryPluginAliasRepository } from '../store/in_memory/in_memory_plugin_alias_repository.js';
import { InMemoryProviderProfileRepository } from '../store/in_memory/in_memory_provider_profile_repository.js';
import { InMemorySessionSettingsRepository } from '../store/in_memory/in_memory_session_settings_repository.js';
import { InMemoryThreadMetadataRepository } from '../store/in_memory/in_memory_thread_metadata_repository.js';
import { PluginRegistry } from './plugin_registry.js';
import type { ProviderProfile } from '../types/provider.js';

interface RuntimeRepositories {
  providerProfiles?: any;
  bridgeSessions?: any;
  platformBindings?: any;
  pluginAliases?: any;
  sessionSettings?: any;
  threadMetadata?: any;
  automationJobs?: any;
  agentJobs?: any;
  assistantRecords?: any;
}

interface CreateCodexBridgeRuntimeOptions {
  platformPlugins?: any[];
  providerPlugins?: any[];
  providerProfiles?: ProviderProfile[];
  defaultProviderProfileId?: string | null;
  defaultCwd?: string | null;
  locale?: string | null;
  repositories?: RuntimeRepositories;
  assistantAttachmentRoot?: string | null;
  restartBridge?: ((params: { event: any }) => Promise<void>) | null;
  codexAuthManager?: any;
  codexInstructionsManager?: any;
  weiboHotSearch?: any;
}

export function createCodexBridgeRuntime({
  platformPlugins = [],
  providerPlugins = [],
  providerProfiles = [],
  defaultProviderProfileId = null,
  defaultCwd = null,
  locale = null,
  repositories = {},
  assistantAttachmentRoot = null,
  restartBridge = null,
  codexAuthManager = null,
  codexInstructionsManager = null,
  weiboHotSearch = null,
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
  const pluginAliasesRepository = repositories.pluginAliases ?? new InMemoryPluginAliasRepository();
  const sessionSettingsRepository = repositories.sessionSettings ?? new InMemorySessionSettingsRepository();
  const threadMetadataRepository = repositories.threadMetadata ?? new InMemoryThreadMetadataRepository();
  const automationJobsRepository = repositories.automationJobs ?? new InMemoryAutomationJobRepository();
  const agentJobsRepository = repositories.agentJobs ?? new InMemoryAgentJobRepository();
  const assistantRecordsRepository = repositories.assistantRecords ?? new InMemoryAssistantRecordRepository();

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
  const automationJobs = new AutomationJobService({
    automationJobs: automationJobsRepository,
    bridgeSessions,
    locale,
  });
  const agentJobs = new AgentJobService({
    agentJobs: agentJobsRepository,
    bridgeSessions,
    locale,
  });
  const assistantRecords = new AssistantRecordService({
    assistantRecords: assistantRecordsRepository,
    attachmentRoot: assistantAttachmentRoot
      ?? path.join(defaultCwd ?? process.cwd(), '.codexbridge', 'assistant', 'attachments'),
  });
  const activeTurns = new ActiveTurnRegistry({ locale });

  const resolvedDefaultProviderProfileId = defaultProviderProfileId
    ?? providerProfiles[0]?.id
    ?? null;
  const bridgeCoordinator = new BridgeCoordinator({
    bridgeSessions,
    automationJobs,
    agentJobs,
    assistantRecords,
    activeTurns,
    providerProfiles: providerProfilesRepository,
    providerRegistry: registry,
    pluginAliases: pluginAliasesRepository,
    defaultProviderProfileId: resolvedDefaultProviderProfileId,
    defaultCwd,
    restartBridge,
    codexAuthManager,
    codexInstructionsManager,
    weiboHotSearch: weiboHotSearch ?? new WeiboHotSearchService(),
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
      pluginAliases: pluginAliasesRepository,
      sessionSettings: sessionSettingsRepository,
      threadMetadata: threadMetadataRepository,
      automationJobs: automationJobsRepository,
      agentJobs: agentJobsRepository,
      assistantRecords: assistantRecordsRepository,
    },
    services: {
      activeTurns,
      sessionRouter,
      bridgeSessions,
      automationJobs,
      agentJobs,
      assistantRecords,
      bridgeCoordinator,
    },
  };
}
