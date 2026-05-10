const ENABLED_FLAG_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isAgentCommandEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const rawValue = String(env.CODEXBRIDGE_ENABLE_AGENT_COMMAND ?? '').trim().toLowerCase();
  return ENABLED_FLAG_VALUES.has(rawValue);
}
