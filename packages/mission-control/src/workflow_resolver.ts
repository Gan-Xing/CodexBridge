import path from 'node:path';
import { normalizeWorkflowResolverReason } from './domain_records.js';
import type {
  Mission,
  MissionRiskLevel,
  MissionSource,
  MissionWorkflowResolverReason,
} from './types.js';
import { DEFAULT_MISSION_WORKFLOW_RELATIVE_PATH } from './workflow.js';

export interface MissionWorkflowResolverRule {
  id: string;
  relativePath: string;
  sources?: MissionSource[] | null;
  riskLevels?: MissionRiskLevel[] | null;
  requireWorkspacePath?: boolean;
  requireCwd?: boolean;
}

export interface MissionWorkflowResolutionInput {
  source: MissionSource;
  riskLevel: MissionRiskLevel;
  cwd: string | null;
  workspacePath: string | null;
  workflowPath: string | null;
  workflowResolverReason: MissionWorkflowResolverReason | null;
}

export interface MissionWorkflowSelection {
  explicitPath: string | null;
  workflowPath: string | null;
  resolverReason: MissionWorkflowResolverReason;
  matchedRuleId: string | null;
}

export interface MissionWorkflowResolverOptions {
  defaultRelativePath?: string;
  rules?: MissionWorkflowResolverRule[];
}

export class MissionWorkflowResolver {
  readonly defaultRelativePath: string;

  readonly rules: MissionWorkflowResolverRule[];

  constructor(options: MissionWorkflowResolverOptions = {}) {
    this.defaultRelativePath = normalizeRelativePath(options.defaultRelativePath)
      ?? DEFAULT_MISSION_WORKFLOW_RELATIVE_PATH;
    this.rules = Array.isArray(options.rules)
      ? options.rules
        .map((rule) => normalizeRule(rule))
        .filter((rule): rule is MissionWorkflowResolverRule => rule !== null)
      : [];
  }

  resolve(input: MissionWorkflowResolutionInput | Pick<
    Mission,
    'source' | 'riskLevel' | 'cwd' | 'workspacePath' | 'workflowPath' | 'workflowResolverReason'
  >): MissionWorkflowSelection {
    const workflowPath = resolveExplicitWorkflowPath(input.workflowPath, input);
    const workflowResolverReason = normalizeWorkflowResolverReason(input.workflowResolverReason);
    if (workflowPath && (workflowResolverReason === 'explicit_override' || workflowResolverReason === null)) {
      return {
        explicitPath: workflowPath,
        workflowPath,
        resolverReason: 'explicit_override',
        matchedRuleId: null,
      };
    }

    for (const rule of this.rules) {
      if (!matchesRule(rule, input)) {
        continue;
      }
      const resolvedPath = resolveRulePath(rule, input);
      if (!resolvedPath) {
        continue;
      }
      return {
        explicitPath: resolvedPath,
        workflowPath: resolvedPath,
        resolverReason: `rule:${rule.id}`,
        matchedRuleId: rule.id,
      };
    }

    if (normalizePathValue(input.workspacePath)) {
      const resolvedPath = path.resolve(input.workspacePath!, this.defaultRelativePath);
      return {
        explicitPath: resolvedPath,
        workflowPath: resolvedPath,
        resolverReason: 'workspace_default',
        matchedRuleId: null,
      };
    }

    if (normalizePathValue(input.cwd)) {
      const resolvedPath = path.resolve(input.cwd!, this.defaultRelativePath);
      return {
        explicitPath: resolvedPath,
        workflowPath: resolvedPath,
        resolverReason: 'cwd_default',
        matchedRuleId: null,
      };
    }

    return {
      explicitPath: null,
      workflowPath: null,
      resolverReason: 'built_in_default',
      matchedRuleId: null,
    };
  }
}

function normalizeRule(rule: MissionWorkflowResolverRule | null | undefined): MissionWorkflowResolverRule | null {
  if (!rule || typeof rule !== 'object') {
    return null;
  }
  const id = normalizeRuleId(rule.id);
  const relativePath = normalizeRelativePath(rule.relativePath);
  if (!id || !relativePath) {
    return null;
  }
  return {
    id,
    relativePath,
    sources: Array.isArray(rule.sources) ? [...rule.sources] : null,
    riskLevels: Array.isArray(rule.riskLevels) ? [...rule.riskLevels] : null,
    requireWorkspacePath: rule.requireWorkspacePath === true,
    requireCwd: rule.requireCwd === true,
  };
}

function matchesRule(
  rule: MissionWorkflowResolverRule,
  input: Pick<MissionWorkflowResolutionInput, 'source' | 'riskLevel' | 'cwd' | 'workspacePath'>,
): boolean {
  if (Array.isArray(rule.sources) && rule.sources.length > 0 && !rule.sources.includes(input.source)) {
    return false;
  }
  if (Array.isArray(rule.riskLevels) && rule.riskLevels.length > 0 && !rule.riskLevels.includes(input.riskLevel)) {
    return false;
  }
  if (rule.requireWorkspacePath && !normalizePathValue(input.workspacePath)) {
    return false;
  }
  if (rule.requireCwd && !normalizePathValue(input.cwd)) {
    return false;
  }
  return true;
}

function resolveRulePath(
  rule: MissionWorkflowResolverRule,
  input: Pick<MissionWorkflowResolutionInput, 'cwd' | 'workspacePath'>,
): string | null {
  if (path.isAbsolute(rule.relativePath)) {
    return path.resolve(rule.relativePath);
  }
  if (rule.requireWorkspacePath && normalizePathValue(input.workspacePath)) {
    return path.resolve(input.workspacePath!, rule.relativePath);
  }
  if (normalizePathValue(input.workspacePath)) {
    return path.resolve(input.workspacePath!, rule.relativePath);
  }
  if (normalizePathValue(input.cwd)) {
    return path.resolve(input.cwd!, rule.relativePath);
  }
  return null;
}

function resolveExplicitWorkflowPath(
  workflowPath: string | null | undefined,
  input: Pick<MissionWorkflowResolutionInput, 'cwd' | 'workspacePath'>,
): string | null {
  const normalized = normalizePathValue(workflowPath);
  if (!normalized) {
    return null;
  }
  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }
  if (normalizePathValue(input.workspacePath)) {
    return path.resolve(input.workspacePath!, normalized);
  }
  if (normalizePathValue(input.cwd)) {
    return path.resolve(input.cwd!, normalized);
  }
  return path.resolve(normalized);
}

function normalizePathValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function normalizeRelativePath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRuleId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}
