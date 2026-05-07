import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MISSION_WORKFLOW_RELATIVE_PATH = '.codexbridge/mission/WORKFLOW.md' as const;

export const DEFAULT_MISSION_WORKFLOW_PROMPT_BODY = `You are executing a bounded CodexBridge mission attempt.

Respect the mission objective, expected output, acceptance criteria, and stop conditions.
Keep the current plan and workpad coherent as you make progress.
Do not claim completion unless the acceptance criteria are actually satisfied.
If you are blocked, need human input, or need to hand off the mission, report that explicitly.`;

export type MissionWorkflowContinuationMode = 'allow' | 'never';
export type MissionWorkflowDefaultHandoffState = 'waiting_user' | 'needs_human' | 'handoff';
export type MissionWorkflowFinalReportSection =
  | 'summary'
  | 'verification'
  | 'artifacts'
  | 'handoff'
  | 'next_steps';

export interface MissionWorkflowPolicy {
  version: 1;
  maxTurns: number | null;
  maxAttempts: number | null;
  maxRuntimeMs: number | null;
  maxArtifactCount: number | null;
  maxArtifactBytes: number | null;
  continuation: MissionWorkflowContinuationMode;
  requirePlanUpdate: boolean;
  requireWorkpadUpdate: boolean;
  defaultHandoffState: MissionWorkflowDefaultHandoffState;
  stopConditions: string[];
  finalReportSections: MissionWorkflowFinalReportSection[];
  promptBody: string;
}

export interface MissionWorkflowSource {
  kind: 'built-in-default' | 'file';
  path: string | null;
  label: string;
}

export interface LoadedMissionWorkflow {
  source: MissionWorkflowSource;
  hash: string;
  policy: MissionWorkflowPolicy;
  rawFrontMatter: Record<string, unknown>;
  rawText: string;
}

export interface MissionWorkflowLoadInput {
  cwd?: string | null;
  workspacePath?: string | null;
  explicitPath?: string | null;
  env?: NodeJS.ProcessEnv;
}

export interface MissionWorkflowLoaderOptions {
  defaultRelativePath?: string;
  builtInPromptBody?: string;
}

type ParsedFrontMatterValue = string | number | boolean | string[];

export class MissionWorkflowError extends Error {
  readonly workflowPath: string | null;
  readonly issues: string[];

  constructor(message: string, options: { workflowPath: string | null; issues: string[] }) {
    super(message);
    this.name = 'MissionWorkflowError';
    this.workflowPath = options.workflowPath;
    this.issues = [...options.issues];
  }
}

export class MissionWorkflowLoader {
  readonly defaultRelativePath: string;
  readonly builtInPromptBody: string;

  constructor(options: MissionWorkflowLoaderOptions = {}) {
    this.defaultRelativePath = options.defaultRelativePath ?? DEFAULT_MISSION_WORKFLOW_RELATIVE_PATH;
    this.builtInPromptBody = options.builtInPromptBody ?? DEFAULT_MISSION_WORKFLOW_PROMPT_BODY;
  }

  resolvePath(input: MissionWorkflowLoadInput): string | null {
    if (input.explicitPath) {
      return path.resolve(input.explicitPath);
    }

    const envPath = input.env?.CODEXBRIDGE_MISSION_WORKFLOW;
    if (typeof envPath === 'string' && envPath.trim().length > 0) {
      return path.resolve(envPath);
    }

    const root = input.workspacePath ?? input.cwd ?? null;
    if (!root) {
      return null;
    }

    return path.resolve(root, this.defaultRelativePath);
  }

  load(input: MissionWorkflowLoadInput): LoadedMissionWorkflow {
    const resolvedPath = this.resolvePath(input);
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      return this.createBuiltInWorkflow(resolvedPath);
    }

    const rawText = fs.readFileSync(resolvedPath, 'utf8');
    const { frontMatter, body } = splitWorkflowFrontMatter(rawText);
    const parsedFrontMatter = parseWorkflowFrontMatter(frontMatter, resolvedPath);
    const validated = validateWorkflowFrontMatter(parsedFrontMatter, resolvedPath);

    return {
      source: {
        kind: 'file',
        path: resolvedPath,
        label: resolvedPath,
      },
      hash: hashMissionWorkflowText(rawText),
      policy: {
        version: 1,
        maxTurns: validated.maxTurns ?? null,
        maxAttempts: validated.maxAttempts ?? null,
        maxRuntimeMs: validated.maxRuntimeMinutes !== undefined
          ? validated.maxRuntimeMinutes * 60_000
          : null,
        maxArtifactCount: validated.maxArtifactCount ?? null,
        maxArtifactBytes: validated.maxArtifactBytes ?? null,
        continuation: validated.continuation ?? 'allow',
        requirePlanUpdate: validated.requirePlanUpdate ?? true,
        requireWorkpadUpdate: validated.requireWorkpadUpdate ?? true,
        defaultHandoffState: validated.defaultHandoffState ?? 'needs_human',
        stopConditions: [...(validated.stopConditions ?? [])],
        finalReportSections: [...(validated.finalReportSections ?? ['summary', 'verification', 'artifacts', 'next_steps'])],
        promptBody: body,
      },
      rawFrontMatter: parsedFrontMatter,
      rawText,
    };
  }

  tryLoad(input: MissionWorkflowLoadInput):
    | { workflow: LoadedMissionWorkflow; error: null }
    | { workflow: null; error: MissionWorkflowError } {
    try {
      return {
        workflow: this.load(input),
        error: null,
      };
    } catch (error) {
      if (error instanceof MissionWorkflowError) {
        return {
          workflow: null,
          error,
        };
      }
      throw error;
    }
  }

  createBuiltInWorkflow(resolvedPath: string | null): LoadedMissionWorkflow {
    return {
      source: {
        kind: 'built-in-default',
        path: resolvedPath,
        label: resolvedPath
          ? `built-in defaults (missing ${resolvedPath})`
          : 'built-in defaults',
      },
      hash: hashMissionWorkflowText(this.builtInPromptBody),
      policy: {
        version: 1,
        maxTurns: null,
        maxAttempts: null,
        maxRuntimeMs: null,
        maxArtifactCount: null,
        maxArtifactBytes: null,
        continuation: 'allow',
        requirePlanUpdate: true,
        requireWorkpadUpdate: true,
        defaultHandoffState: 'needs_human',
        stopConditions: [],
        finalReportSections: ['summary', 'verification', 'artifacts', 'next_steps'],
        promptBody: this.builtInPromptBody,
      },
      rawFrontMatter: {},
      rawText: this.builtInPromptBody,
    };
  }
}

export function hashMissionWorkflowText(rawText: string): string {
  return crypto.createHash('sha256').update(rawText.replace(/\r\n/g, '\n')).digest('hex');
}

function splitWorkflowFrontMatter(rawText: string): { frontMatter: string; body: string } {
  const normalized = rawText.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return {
      frontMatter: '',
      body: normalized.trim(),
    };
  }

  const closingIndex = normalized.indexOf('\n---\n', 4);
  if (closingIndex === -1) {
    return {
      frontMatter: '',
      body: normalized.trim(),
    };
  }

  return {
    frontMatter: normalized.slice(4, closingIndex).trim(),
    body: normalized.slice(closingIndex + 5).trim(),
  };
}

function parseWorkflowFrontMatter(frontMatter: string, workflowPath: string): Record<string, ParsedFrontMatterValue> {
  if (frontMatter.trim().length === 0) {
    return {};
  }

  const lines = frontMatter.split('\n');
  const parsed: Record<string, ParsedFrontMatterValue> = {};

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trimEnd();
    if (line.trim().length === 0 || line.trim().startsWith('#')) {
      continue;
    }

    const match = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      throw new MissionWorkflowError('Unable to parse mission workflow front matter.', {
        workflowPath,
        issues: [`line ${index + 1}: expected "key: value"`],
      });
    }

    const [, key, inlineValue] = match;
    if (inlineValue.trim().length === 0) {
      const values: string[] = [];
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        const nextLine = lines[cursor]!;
        if (/^\s*-\s+/.test(nextLine)) {
          values.push(nextLine.replace(/^\s*-\s+/, '').trim());
          continue;
        }
        if (nextLine.trim().length === 0) {
          continue;
        }
        break;
      }
      if (values.length === 0) {
        throw new MissionWorkflowError('Unable to parse mission workflow front matter list value.', {
          workflowPath,
          issues: [`line ${index + 1}: expected one or more "- item" lines for ${key}`],
        });
      }
      parsed[key] = values;
      index = cursor - 1;
      continue;
    }

    parsed[key] = parseScalarFrontMatterValue(inlineValue.trim());
  }

  return parsed;
}

function parseScalarFrontMatterValue(input: string): Exclude<ParsedFrontMatterValue, string[]> {
  if (input === 'true') {
    return true;
  }
  if (input === 'false') {
    return false;
  }
  if (/^-?\d+$/.test(input)) {
    return Number(input);
  }
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith('\'') && input.endsWith('\''))) {
    return input.slice(1, -1);
  }
  return input;
}

function validateWorkflowFrontMatter(
  frontMatter: Record<string, ParsedFrontMatterValue>,
  workflowPath: string,
): {
  version?: 1;
  maxTurns?: number;
  maxAttempts?: number;
  maxRuntimeMinutes?: number;
  maxArtifactCount?: number;
  maxArtifactBytes?: number;
  continuation?: MissionWorkflowContinuationMode;
  requirePlanUpdate?: boolean;
  requireWorkpadUpdate?: boolean;
  defaultHandoffState?: MissionWorkflowDefaultHandoffState;
  stopConditions?: string[];
  finalReportSections?: MissionWorkflowFinalReportSection[];
} {
  const issues: string[] = [];
  const allowedKeys = new Set([
    'version',
    'maxTurns',
    'maxAttempts',
    'maxRuntimeMinutes',
    'maxArtifactCount',
    'maxArtifactBytes',
    'continuation',
    'requirePlanUpdate',
    'requireWorkpadUpdate',
    'defaultHandoffState',
    'stopConditions',
    'finalReportSections',
  ]);

  for (const key of Object.keys(frontMatter)) {
    if (!allowedKeys.has(key)) {
      issues.push(`${key}: unknown workflow policy key`);
    }
  }

  const version = frontMatter.version;
  if (version !== undefined && version !== 1) {
    issues.push('version: expected 1');
  }

  const maxTurns = validateOptionalPositiveInteger(frontMatter.maxTurns, 'maxTurns', issues);
  const maxAttempts = validateOptionalPositiveInteger(frontMatter.maxAttempts, 'maxAttempts', issues);
  const maxRuntimeMinutes = validateOptionalPositiveInteger(
    frontMatter.maxRuntimeMinutes,
    'maxRuntimeMinutes',
    issues,
  );
  const maxArtifactCount = validateOptionalPositiveInteger(
    frontMatter.maxArtifactCount,
    'maxArtifactCount',
    issues,
  );
  const maxArtifactBytes = validateOptionalPositiveInteger(
    frontMatter.maxArtifactBytes,
    'maxArtifactBytes',
    issues,
  );
  const continuation = validateOptionalEnum(
    frontMatter.continuation,
    'continuation',
    ['allow', 'never'],
    issues,
  ) as MissionWorkflowContinuationMode | undefined;
  const requirePlanUpdate = validateOptionalBoolean(frontMatter.requirePlanUpdate, 'requirePlanUpdate', issues);
  const requireWorkpadUpdate = validateOptionalBoolean(frontMatter.requireWorkpadUpdate, 'requireWorkpadUpdate', issues);
  const defaultHandoffState = validateOptionalEnum(
    frontMatter.defaultHandoffState,
    'defaultHandoffState',
    ['waiting_user', 'needs_human', 'handoff'],
    issues,
  ) as MissionWorkflowDefaultHandoffState | undefined;
  const stopConditions = validateOptionalStringArray(frontMatter.stopConditions, 'stopConditions', issues);
  const finalReportSections = validateOptionalStringEnumArray(
    frontMatter.finalReportSections,
    'finalReportSections',
    ['summary', 'verification', 'artifacts', 'handoff', 'next_steps'],
    issues,
  ) as MissionWorkflowFinalReportSection[] | undefined;

  if (issues.length > 0) {
    throw new MissionWorkflowError('Invalid mission workflow front matter.', {
      workflowPath,
      issues,
    });
  }

  return {
    version: version as 1 | undefined,
    maxTurns,
    maxAttempts,
    maxRuntimeMinutes,
    maxArtifactCount,
    maxArtifactBytes,
    continuation,
    requirePlanUpdate,
    requireWorkpadUpdate,
    defaultHandoffState,
    stopConditions,
    finalReportSections,
  };
}

function validateOptionalPositiveInteger(
  value: ParsedFrontMatterValue | undefined,
  key: string,
  issues: string[],
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    issues.push(`${key}: expected a positive integer`);
    return undefined;
  }
  return value;
}

function validateOptionalBoolean(
  value: ParsedFrontMatterValue | undefined,
  key: string,
  issues: string[],
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    issues.push(`${key}: expected a boolean`);
    return undefined;
  }
  return value;
}

function validateOptionalEnum(
  value: ParsedFrontMatterValue | undefined,
  key: string,
  allowedValues: readonly string[],
  issues: string[],
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !allowedValues.includes(value)) {
    issues.push(`${key}: expected one of ${allowedValues.join(', ')}`);
    return undefined;
  }
  return value;
}

function validateOptionalStringArray(
  value: ParsedFrontMatterValue | undefined,
  key: string,
  issues: string[],
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    issues.push(`${key}: expected a non-empty string array`);
    return undefined;
  }
  return [...value];
}

function validateOptionalStringEnumArray(
  value: ParsedFrontMatterValue | undefined,
  key: string,
  allowedValues: readonly string[],
  issues: string[],
): string[] | undefined {
  const values = validateOptionalStringArray(value, key, issues);
  if (!values) {
    return values;
  }
  for (const entry of values) {
    if (!allowedValues.includes(entry)) {
      issues.push(`${key}: invalid value "${entry}"`);
    }
  }
  return values;
}
