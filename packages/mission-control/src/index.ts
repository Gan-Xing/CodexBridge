export const MISSION_CONTROL_PACKAGE_NAME = '@codexbridge/mission-control' as const;

export const MISSION_CONTROL_PACKAGE_PHASE = 'phase-9q-paused-approval-resolution' as const;

export const MISSION_CONTROL_OWNS = [
  'mission-domain-model',
  'mission-state-machine',
  'workflow-loading',
  'workspace-coordination',
  'lease-coordination',
  'provider-abstraction',
  'run-verify-repair-retry-loop',
  'mission-persistence',
  'attempt-event-workpad-persistence',
  'mission-control-actions',
  'host-adapter-contract',
  'work-item-source-contract',
  'source-backed-mission-creation',
  'progress-sink-contract',
  'supervision-foundation',
  'persisted-stop-intents',
] as const;

export const MISSION_CONTROL_DOES_NOT_OWN = [
  'wechat-transport',
  'telegram-transport',
  'slash-commands',
  'i18n',
  'sendgate',
  'bridge-sessions',
  'thread-browsing',
  'provider-profile-cli-management',
  'assistant-records',
  'uploads',
  'artifact-delivery-policy',
] as const;

export type MissionControlOwnedResponsibility = typeof MISSION_CONTROL_OWNS[number];

export type MissionControlExcludedResponsibility =
  typeof MISSION_CONTROL_DOES_NOT_OWN[number];

export * from './types.js';
export * from './domain_records.js';
export * from './state_machine.js';
export * from './repository.js';
export * from './in_memory_mission_repository.js';
export * from './json_file_mission_repository.js';
export * from './workflow.js';
export * from './prompt_contract.js';
export * from './workpad_view.js';
export * from './workspace.js';
export * from './lease_coordinator.js';
export * from './control_actions.js';
export * from './cycle_result.js';
export * from './provider.js';
export * from './host_adapter.js';
export * from './source.js';
export * from './source_mission.js';
export * from './progress.js';
export * from './supervision.js';
export * from './codex_provider.js';
export * from './verifier.js';
export * from './runtime.js';
export * from './api_contract.js';
export * from './api.js';
