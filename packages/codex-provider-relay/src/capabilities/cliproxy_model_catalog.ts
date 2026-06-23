import {
  type OpenAICompatibleModelCapabilities,
  type OpenAICompatibleProviderCapabilities,
} from './thinking_policy.js';

export type CliproxyModelCategory =
  | 'claude'
  | 'gemini'
  | 'vertex'
  | 'gemini-cli'
  | 'aistudio'
  | 'codex-free'
  | 'codex-team'
  | 'codex-plus'
  | 'codex-pro'
  | 'qwen'
  | 'iflow'
  | 'kimi'
  | 'antigravity'
  | 'minimax-codex'
  | 'deepseek-codex'
  | 'openrouter'
  | 'requesty';

export interface CliproxyModelCatalogEntry {
  category: CliproxyModelCategory;
  id: string;
  ownedBy: string;
  displayName: string;
  description?: string;
  maxOutputTokens?: number;
  supportedParameters?: string[];
  webSearch?: boolean;
  thinking?: {
    levels?: string[];
    min?: number;
    max?: number;
    zeroAllowed?: boolean;
    dynamicAllowed?: boolean;
  };
}

export interface BuildCliproxyModelCatalogEntriesOptions {
  categories: CliproxyModelCategory[];
  defaultModel: string;
  displayName: string;
  capabilities: OpenAICompatibleProviderCapabilities | null;
}

const CODEX_MODELS: CliproxyModelCatalogEntry[] = [
  model('codex-free', 'gpt-5', 'openai', 'GPT 5', ['minimal', 'low', 'medium', 'high']),
  model('codex-free', 'gpt-5-codex', 'openai', 'GPT 5 Codex', ['low', 'medium', 'high']),
  model('codex-free', 'gpt-5-codex-mini', 'openai', 'GPT 5 Codex Mini', ['low', 'medium', 'high']),
  model('codex-free', 'gpt-5.1', 'openai', 'GPT 5.1', ['none', 'low', 'medium', 'high']),
  model('codex-free', 'gpt-5.1-codex', 'openai', 'GPT 5.1 Codex', ['low', 'medium', 'high']),
  model('codex-free', 'gpt-5.1-codex-mini', 'openai', 'GPT 5.1 Codex Mini', ['low', 'medium', 'high']),
  model('codex-free', 'gpt-5.1-codex-max', 'openai', 'GPT 5.1 Codex Max', ['low', 'medium', 'high', 'xhigh']),
  model('codex-free', 'gpt-5.2', 'openai', 'GPT 5.2', ['none', 'low', 'medium', 'high', 'xhigh']),
  model('codex-free', 'gpt-5.2-codex', 'openai', 'GPT 5.2 Codex', ['low', 'medium', 'high', 'xhigh']),
  model('codex-free', 'gpt-5.3-codex', 'openai', 'GPT 5.3 Codex', ['low', 'medium', 'high', 'xhigh']),
  model('codex-free', 'gpt-5.4', 'openai', 'GPT 5.4', ['low', 'medium', 'high', 'xhigh']),
  model('codex-free', 'gpt-5.4-mini', 'openai', 'GPT 5.4 Mini', ['low', 'medium', 'high', 'xhigh']),
  model('codex-plus', 'gpt-5.3-codex-spark', 'openai', 'GPT 5.3 Codex Spark', ['low', 'medium', 'high', 'xhigh']),
];

const GEMINI_MODELS: CliproxyModelCatalogEntry[] = [
  model('gemini', 'gemini-2.5-pro', 'google', 'Gemini 2.5 Pro', ['low', 'medium', 'high'], { maxOutputTokens: 65536 }),
  model('gemini', 'gemini-2.5-flash', 'google', 'Gemini 2.5 Flash', ['none', 'low', 'medium', 'high'], { maxOutputTokens: 65536 }),
  model('gemini', 'gemini-2.5-flash-lite', 'google', 'Gemini 2.5 Flash Lite', ['none', 'low', 'medium', 'high'], { maxOutputTokens: 65536 }),
  model('gemini', 'gemini-embedding-001', 'google', 'Gemini Embedding 001', null, { maxOutputTokens: 65536, supportedParameters: [] }),
  model('gemini', 'gemini-3-pro-preview', 'google', 'Gemini 3 Pro Preview', ['low', 'high'], { maxOutputTokens: 65536 }),
  model('gemini', 'gemini-3.1-pro-preview', 'google', 'Gemini 3.1 Pro Preview', ['low', 'medium', 'high'], { maxOutputTokens: 65536 }),
  model('gemini', 'gemini-3.1-flash-image-preview', 'google', 'Gemini 3.1 Flash Image Preview', ['minimal', 'high'], { maxOutputTokens: 65536 }),
  model('gemini', 'gemini-3-flash-preview', 'google', 'Gemini 3 Flash Preview', ['minimal', 'low', 'medium', 'high'], { maxOutputTokens: 65536 }),
  model('gemini', 'gemini-3.1-flash-lite-preview', 'google', 'Gemini 3.1 Flash Lite Preview', ['minimal', 'low', 'medium', 'high'], { maxOutputTokens: 65536 }),
  model('gemini', 'gemini-3-pro-image-preview', 'google', 'Gemini 3 Pro Image Preview', ['low', 'high'], { maxOutputTokens: 65536 }),
  model('vertex', 'imagen-4.0-generate-001', 'google', 'Imagen 4.0 Generate', null, { supportedParameters: [] }),
  model('vertex', 'imagen-4.0-ultra-generate-001', 'google', 'Imagen 4.0 Ultra Generate', null, { supportedParameters: [] }),
  model('vertex', 'imagen-3.0-generate-002', 'google', 'Imagen 3.0 Generate', null, { supportedParameters: [] }),
  model('vertex', 'imagen-3.0-fast-generate-001', 'google', 'Imagen 3.0 Fast Generate', null, { supportedParameters: [] }),
  model('vertex', 'imagen-4.0-fast-generate-001', 'google', 'Imagen 4.0 Fast Generate', null, { supportedParameters: [] }),
  model('aistudio', 'gemini-pro-latest', 'google', 'Gemini Pro Latest', ['low', 'medium', 'high'], { maxOutputTokens: 65536 }),
  model('aistudio', 'gemini-flash-latest', 'google', 'Gemini Flash Latest', ['none', 'low', 'medium', 'high'], { maxOutputTokens: 65536 }),
  model('aistudio', 'gemini-flash-lite-latest', 'google', 'Gemini Flash-Lite Latest', ['none', 'low', 'medium', 'high'], { maxOutputTokens: 65536 }),
  model('aistudio', 'gemini-2.5-flash-image', 'google', 'Gemini 2.5 Flash Image', null, { maxOutputTokens: 8192 }),
];

const CLAUDE_MODELS: CliproxyModelCatalogEntry[] = [
  model('claude', 'claude-haiku-4-5-20251001', 'anthropic', 'Claude 4.5 Haiku', ['low', 'medium', 'high'], { maxOutputTokens: 64000 }),
  model('claude', 'claude-sonnet-4-5-20250929', 'anthropic', 'Claude 4.5 Sonnet', ['low', 'medium', 'high'], { maxOutputTokens: 64000 }),
  model('claude', 'claude-sonnet-4-6', 'anthropic', 'Claude 4.6 Sonnet', ['low', 'medium', 'high'], { maxOutputTokens: 64000 }),
  model('claude', 'claude-opus-4-6', 'anthropic', 'Claude 4.6 Opus', ['low', 'medium', 'high', 'max'], { maxOutputTokens: 128000 }),
  model('claude', 'claude-opus-4-5-20251101', 'anthropic', 'Claude 4.5 Opus', ['low', 'medium', 'high'], { maxOutputTokens: 64000 }),
  model('claude', 'claude-opus-4-1-20250805', 'anthropic', 'Claude 4.1 Opus', ['low', 'medium', 'high'], { maxOutputTokens: 32000 }),
  model('claude', 'claude-opus-4-20250514', 'anthropic', 'Claude 4 Opus', ['low', 'medium', 'high'], { maxOutputTokens: 32000 }),
  model('claude', 'claude-sonnet-4-20250514', 'anthropic', 'Claude 4 Sonnet', ['low', 'medium', 'high'], { maxOutputTokens: 64000 }),
  model('claude', 'claude-3-7-sonnet-20250219', 'anthropic', 'Claude 3.7 Sonnet', ['low', 'medium', 'high'], { maxOutputTokens: 8192 }),
  model('claude', 'claude-3-5-haiku-20241022', 'anthropic', 'Claude 3.5 Haiku', null, { maxOutputTokens: 8192 }),
];

const IFLOW_MODELS: CliproxyModelCatalogEntry[] = [
  model('iflow', 'qwen3-coder-plus', 'iflow', 'Qwen3-Coder-Plus'),
  model('iflow', 'qwen3-max', 'iflow', 'Qwen3-Max'),
  model('iflow', 'qwen3-vl-plus', 'iflow', 'Qwen3-VL-Plus'),
  model('iflow', 'qwen3-max-preview', 'iflow', 'Qwen3-Max-Preview', ['none', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh']),
  model('iflow', 'glm-4.6', 'iflow', 'GLM-4.6', ['none', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh']),
  model('iflow', 'kimi-k2', 'iflow', 'Kimi-K2'),
  model('iflow', 'deepseek-v3.2', 'iflow', 'DeepSeek-V3.2-Exp', ['none', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh']),
  model('iflow', 'deepseek-v3.1', 'iflow', 'DeepSeek-V3.1-Terminus', ['none', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh']),
  model('iflow', 'deepseek-r1', 'iflow', 'DeepSeek-R1'),
  model('iflow', 'deepseek-v3', 'iflow', 'DeepSeek-V3-671B'),
  model('iflow', 'qwen3-32b', 'iflow', 'Qwen3-32B'),
  model('iflow', 'qwen3-235b-a22b-thinking-2507', 'iflow', 'Qwen3-235B-A22B-Thinking'),
  model('iflow', 'qwen3-235b-a22b-instruct', 'iflow', 'Qwen3-235B-A22B-Instruct'),
  model('iflow', 'qwen3-235b', 'iflow', 'Qwen3-235B-A22B'),
  model('iflow', 'iflow-rome-30ba3b', 'iflow', 'iFlow-ROME'),
];

const KIMI_MODELS: CliproxyModelCatalogEntry[] = [
  model('kimi', 'kimi-k2', 'moonshot', 'Kimi K2', null, { maxOutputTokens: 32768 }),
  model('kimi', 'kimi-k2-thinking', 'moonshot', 'Kimi K2 Thinking', ['low', 'medium', 'high'], { maxOutputTokens: 32768 }),
  model('kimi', 'kimi-k2.5', 'moonshot', 'Kimi K2.5', ['low', 'medium', 'high'], { maxOutputTokens: 32768 }),
];

const QWEN_MODELS: CliproxyModelCatalogEntry[] = [
  model('qwen', 'qwen-plus', 'qwen', 'Qwen Plus', null, {
    maxOutputTokens: 65536,
    supportedParameters: ['temperature', 'top_p', 'max_tokens', 'stream', 'stop', 'tools', 'response_format'],
    webSearch: true,
  }),
  model('qwen', 'qwen3-coder-plus', 'qwen', 'Qwen3 Coder Plus', null, {
    supportedParameters: ['temperature', 'top_p', 'max_tokens', 'stream', 'stop', 'tools', 'response_format'],
  }),
];

const ANTIGRAVITY_MODELS: CliproxyModelCatalogEntry[] = [
  model('antigravity', 'claude-opus-4-6-thinking', 'antigravity', 'Claude Opus 4.6 (Thinking)', ['low', 'medium', 'high'], { maxOutputTokens: 64000 }),
  model('antigravity', 'claude-sonnet-4-6', 'antigravity', 'Claude Sonnet 4.6 (Thinking)', ['low', 'medium', 'high'], { maxOutputTokens: 64000 }),
  model('antigravity', 'gemini-2.5-flash', 'antigravity', 'Gemini 2.5 Flash', ['none', 'low', 'medium', 'high'], { maxOutputTokens: 65535 }),
  model('antigravity', 'gemini-2.5-flash-lite', 'antigravity', 'Gemini 2.5 Flash Lite', ['none', 'low', 'medium', 'high'], { maxOutputTokens: 65535 }),
  model('antigravity', 'gemini-3-flash', 'antigravity', 'Gemini 3 Flash', ['minimal', 'low', 'medium', 'high'], { maxOutputTokens: 65536 }),
  model('antigravity', 'gemini-3-pro-high', 'antigravity', 'Gemini 3 Pro (High)', ['low', 'high'], { maxOutputTokens: 65535 }),
  model('antigravity', 'gemini-3-pro-low', 'antigravity', 'Gemini 3 Pro (Low)', ['low', 'high'], { maxOutputTokens: 65535 }),
  model('antigravity', 'gemini-3.1-flash-image', 'antigravity', 'Gemini 3.1 Flash Image', ['minimal', 'high']),
  model('antigravity', 'gemini-3.1-pro-high', 'antigravity', 'Gemini 3.1 Pro (High)', ['low', 'medium', 'high'], { maxOutputTokens: 65535 }),
  model('antigravity', 'gemini-3.1-pro-low', 'antigravity', 'Gemini 3.1 Pro (Low)', ['low', 'medium', 'high'], { maxOutputTokens: 65535 }),
  model('antigravity', 'gpt-oss-120b-medium', 'antigravity', 'GPT-OSS 120B (Medium)', null, { maxOutputTokens: 32768 }),
];

const DIRECT_COMPAT_MODELS: CliproxyModelCatalogEntry[] = [
  model('minimax-codex', 'MiniMax-M2.7', 'minimax', 'MiniMax-M2.7', ['low', 'medium', 'high'], { maxOutputTokens: 65536 }),
  model('minimax-codex', 'MiniMax-M2.5', 'minimax', 'MiniMax-M2.5', ['low', 'medium', 'high'], { maxOutputTokens: 65536 }),
  model('deepseek-codex', 'deepseek-v4-flash', 'deepseek', 'DeepSeek V4 Flash', null, { maxOutputTokens: 65536 }),
  model('deepseek-codex', 'deepseek-v4-pro', 'deepseek', 'DeepSeek V4 Pro', null, { maxOutputTokens: 65536 }),
  model('openrouter', 'openai/gpt-4o-mini', 'openrouter', 'OpenAI GPT-4o Mini', null, { maxOutputTokens: 16384 }),
  model('requesty', 'openai/gpt-4o-mini', 'requesty', 'OpenAI GPT-4o Mini', null, { maxOutputTokens: 16384 }),
];

export const CLIPROXY_COMPAT_MODEL_CATALOG: CliproxyModelCatalogEntry[] = [
  ...CLAUDE_MODELS,
  ...GEMINI_MODELS,
  ...CODEX_MODELS,
  ...QWEN_MODELS,
  ...IFLOW_MODELS,
  ...KIMI_MODELS,
  ...ANTIGRAVITY_MODELS,
  ...DIRECT_COMPAT_MODELS,
];

export function buildCliproxyModelIds(categories: CliproxyModelCategory[]): string[] {
  return unique(
    CLIPROXY_COMPAT_MODEL_CATALOG
      .filter((entry) => entryMatchesCategories(entry, categories))
      .map((entry) => entry.id),
  );
}

export function buildCliproxyModelCapabilityMap(
  categories: CliproxyModelCategory[],
): Record<string, OpenAICompatibleModelCapabilities> {
  const catalog: Record<string, OpenAICompatibleModelCapabilities> = {};
  for (const entry of CLIPROXY_COMPAT_MODEL_CATALOG) {
    if (!entryMatchesCategories(entry, categories)) {
      continue;
    }
    catalog[entry.id] = buildModelCapabilities(entry);
  }
  return catalog;
}

export function buildCliproxyModelCatalogEntries({
  categories,
  defaultModel,
  displayName,
  capabilities,
}: BuildCliproxyModelCatalogEntriesOptions) {
  const entries = new Map<string, CliproxyModelCatalogEntry>();
  for (const entry of CLIPROXY_COMPAT_MODEL_CATALOG) {
    if (entryMatchesCategories(entry, categories) && !entries.has(entry.id)) {
      entries.set(entry.id, entry);
    }
  }
  if (!entries.has(defaultModel)) {
    entries.set(defaultModel, {
      category: 'openrouter',
      id: defaultModel,
      ownedBy: displayName.toLowerCase().replace(/\s+/gu, '-'),
      displayName: defaultModel,
    });
  }
  return [...entries.values()].map((entry) => {
    const modelCapabilities = capabilities?.modelCapabilities?.[entry.id] ?? buildModelCapabilities(entry);
    const reasoning = modelCapabilities.reasoning && typeof modelCapabilities.reasoning === 'object'
      ? modelCapabilities.reasoning
      : null;
    return {
      id: entry.id,
      model: entry.id,
      displayName: entry.displayName,
      description: entry.description ?? `${displayName} model through the generic OpenAI-compatible Responses adapter.`,
      isDefault: entry.id === defaultModel,
      supportedReasoningEfforts: reasoning?.supportedReasoningEfforts ?? [],
      defaultReasoningEffort: reasoning?.defaultReasoningEffort ?? null,
      capabilities: modelCapabilities,
    };
  });
}

export function findCliproxyModelCatalogEntry(id: string): CliproxyModelCatalogEntry | null {
  const normalized = id.trim().toLowerCase();
  return CLIPROXY_COMPAT_MODEL_CATALOG.find((entry) => entry.id.toLowerCase() === normalized) ?? null;
}

export function buildCliproxyModelCapabilitiesForEntry(
  entry: CliproxyModelCatalogEntry,
): OpenAICompatibleModelCapabilities {
  return buildModelCapabilities(entry);
}

function buildModelCapabilities(entry: CliproxyModelCatalogEntry): OpenAICompatibleModelCapabilities {
  const id = entry.id.toLowerCase();
  const supportedParameters = entry.supportedParameters;
  const hasExplicitSupportedParameters = Array.isArray(supportedParameters);
  const tools = hasExplicitSupportedParameters ? supportedParameters.includes('tools') : !isNonChatModel(id);
  const levels = normalizeThinkingLevels(entry.thinking?.levels);
  const reasoning = levels.length > 0
    ? {
      supportedReasoningEfforts: levels,
      defaultReasoningEffort: null,
    }
    : false;
  return {
    tools,
    vision: isVisionModel(id, entry.category),
    fileInput: false,
    pdfInput: false,
    jsonSchema: !hasExplicitSupportedParameters || supportedParameters.includes('response_format'),
    reasoning,
    thinking: buildThinkingPolicy(entry, levels),
    webSearch: entry.webSearch === true,
    parallelToolCalls: !isMiniMaxModel(id),
    maxOutputTokens: entry.maxOutputTokens,
    payload: buildModelPayloadCompatibility(entry),
  };
}

function buildModelPayloadCompatibility(
  entry: CliproxyModelCatalogEntry,
): OpenAICompatibleModelCapabilities['payload'] {
  if (entry.category === 'kimi' && entry.id.toLowerCase().startsWith('kimi-')) {
    return {
      override: [{
        params: {
          model: entry.id.slice('kimi-'.length),
        },
      }],
    };
  }
  return null;
}

function buildThinkingPolicy(
  entry: CliproxyModelCatalogEntry,
  levels: string[],
): OpenAICompatibleModelCapabilities['thinking'] {
  const id = entry.id.toLowerCase();
  if (entry.category === 'iflow') {
    if (id.startsWith('glm')) {
      return {
        supportsReasoningEffortSelection: true,
        supportedReasoningEfforts: levels,
        defaultReasoningEffort: null,
        stripFields: ['reasoning_effort', 'thinking'],
        mode: 'boolean',
        booleanField: 'chat_template_kwargs.enable_thinking',
        booleanFalseEfforts: ['none'],
        booleanTrueParams: {
          'chat_template_kwargs.clear_thinking': false,
        },
      };
    }
    if (id === 'qwen3-max-preview' || id === 'deepseek-v3.2' || id === 'deepseek-v3.1') {
      return {
        supportsReasoningEffortSelection: true,
        supportedReasoningEfforts: levels,
        defaultReasoningEffort: null,
        stripFields: ['reasoning_effort', 'thinking'],
        mode: 'boolean',
        booleanField: 'chat_template_kwargs.enable_thinking',
        booleanFalseEfforts: ['none'],
      };
    }
    if (isMiniMaxModel(id)) {
      return {
        supportsReasoningEffortSelection: true,
        supportedReasoningEfforts: levels.length > 0 ? levels : ['none', 'low', 'medium', 'high'],
        defaultReasoningEffort: null,
        stripFields: ['reasoning_effort', 'thinking'],
        mode: 'boolean',
        booleanField: 'reasoning_split',
        booleanFalseEfforts: ['none'],
      };
    }
  }
  if (levels.length > 0) {
    return {
      supportsReasoningEffortSelection: true,
      supportedReasoningEfforts: levels,
      defaultReasoningEffort: null,
      stripFields: ['thinking'],
      mode: 'reasoning_effort',
    };
  }
  return {
    supportsReasoningEffortSelection: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    stripFields: ['reasoning_effort', 'thinking'],
    mode: 'boolean',
    booleanField: null,
  };
}

function model(
  category: CliproxyModelCategory,
  id: string,
  ownedBy: string,
  displayName: string,
  thinkingLevels: string[] | null = null,
  extra: Partial<CliproxyModelCatalogEntry> = {},
): CliproxyModelCatalogEntry {
  return {
    category,
    id,
    ownedBy,
    displayName,
    maxOutputTokens: 128000,
    ...extra,
    thinking: thinkingLevels ? { levels: thinkingLevels } : extra.thinking,
  };
}

function normalizeThinkingLevels(levels: unknown): string[] {
  const normalized = Array.isArray(levels)
    ? levels.map((level) => String(level ?? '').trim().toLowerCase()).filter(Boolean)
    : [];
  return unique(normalized);
}

function isMiniMaxModel(id: string): boolean {
  return id.startsWith('minimax');
}

function isNonChatModel(id: string): boolean {
  return id.includes('embedding') || id.startsWith('imagen-');
}

function isVisionModel(id: string, category: CliproxyModelCategory): boolean {
  if (isNonChatModel(id)) {
    return false;
  }
  return id.includes('vl')
    || id.includes('image')
    || category === 'gemini'
    || category === 'vertex'
    || category === 'gemini-cli'
    || category === 'aistudio'
    || category === 'antigravity';
}

function entryMatchesCategories(
  entry: CliproxyModelCatalogEntry,
  categories: CliproxyModelCategory[],
): boolean {
  if (categories.includes(entry.category)) {
    return true;
  }
  if (entry.category.startsWith('codex-') && categories.some((category) => category.startsWith('codex-'))) {
    return true;
  }
  return entry.category === 'gemini'
    && (categories.includes('vertex') || categories.includes('gemini-cli') || categories.includes('aistudio'));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
