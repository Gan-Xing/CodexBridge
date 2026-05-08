import type {
  ChecklistItem,
  ChecklistSnapshot,
  Mission,
  MissionAttempt,
} from './types.js';
import type { LoadedMissionWorkflow, MissionWorkflowFinalReportSection } from './workflow.js';

export interface MissionPromptChecklistItem {
  id: string;
  kind: ChecklistItem['kind'];
  title: string;
  detail: string | null;
  status: ChecklistItem['status'];
}

export interface MissionAttemptPromptContract {
  workflowSourceLabel: string;
  missionId: string;
  missionTitle: string;
  generationIndex: number | null;
  attemptIndex: number | null;
  checklistVersion: number | null;
  activeChecklistItem: MissionPromptChecklistItem | null;
  objective: string;
  immutablePrompt: string;
  expectedOutput: string;
  acceptanceCriteria: string[];
  currentPlan: string[];
  workpadSummary: string | null;
  workpadNotes: string[];
  latestBlocker: string | null;
  stopConditions: string[];
  finalReportSections: MissionWorkflowFinalReportSection[];
  workflowPromptBody: string;
}

export interface CreateMissionAttemptPromptContractInput {
  mission: Mission;
  attempt: MissionAttempt | null;
  workflow: LoadedMissionWorkflow;
  checklistSnapshot?: ChecklistSnapshot | null;
}

const BUILT_IN_STOP_CONDITIONS = [
  'Do not claim completion unless the acceptance criteria are actually satisfied.',
  'If you need approval, user input, or a handoff, stop and report that state explicitly.',
];

const FINAL_REPORT_SECTION_DESCRIPTIONS: Readonly<Record<MissionWorkflowFinalReportSection, string>> = Object.freeze({
  summary: 'Summary: what changed or what was learned.',
  verification: 'Verification: what evidence proves the acceptance criteria passed or failed.',
  artifacts: 'Artifacts: files, outputs, or references produced by this attempt.',
  handoff: 'Handoff: what a human or next system needs to do next.',
  next_steps: 'Next steps: what continuation or follow-up work remains.',
});

export function createMissionAttemptPromptContract(
  input: CreateMissionAttemptPromptContractInput,
): MissionAttemptPromptContract {
  const activeChecklistItem = selectPromptChecklistItem(input.checklistSnapshot ?? null);
  return {
    workflowSourceLabel: input.workflow.source.label,
    missionId: input.mission.id,
    missionTitle: input.mission.title,
    generationIndex: input.attempt?.generationIndex ?? input.mission.activeGenerationIndex ?? null,
    attemptIndex: input.attempt?.index ?? null,
    checklistVersion: input.checklistSnapshot?.version ?? null,
    activeChecklistItem,
    objective: input.mission.immutableGoal,
    immutablePrompt: input.mission.immutablePrompt,
    expectedOutput: input.mission.expectedOutput,
    acceptanceCriteria: [...input.mission.acceptanceCriteria],
    currentPlan: [...input.mission.plan],
    workpadSummary: input.mission.workpad.summary,
    workpadNotes: [...input.mission.workpad.notes],
    latestBlocker: input.mission.workpad.latestBlocker,
    stopConditions: dedupeStrings([
      ...BUILT_IN_STOP_CONDITIONS,
      ...input.workflow.policy.stopConditions,
    ]),
    finalReportSections: [...input.workflow.policy.finalReportSections],
    workflowPromptBody: input.workflow.policy.promptBody,
  };
}

export function renderMissionAttemptPromptContract(contract: MissionAttemptPromptContract): string {
  const lines: string[] = [];
  lines.push('You are executing a CodexBridge Mission Control attempt.');
  lines.push(`Mission ID: ${contract.missionId}`);
  lines.push(`Mission title: ${contract.missionTitle}`);
  lines.push(`Workflow source: ${contract.workflowSourceLabel}`);
  if (contract.generationIndex !== null) {
    lines.push(`Generation index: ${contract.generationIndex}`);
  }
  if (contract.attemptIndex !== null) {
    lines.push(`Attempt index: ${contract.attemptIndex}`);
  }
  lines.push('');
  lines.push('Objective');
  lines.push(contract.objective);
  lines.push('');
  lines.push('Immutable mission prompt');
  lines.push(contract.immutablePrompt);
  lines.push('');
  lines.push('Expected output');
  lines.push(contract.expectedOutput);
  lines.push('');
  lines.push('Acceptance criteria');
  lines.push(...renderBullets(contract.acceptanceCriteria));
  if (contract.checklistVersion !== null || contract.activeChecklistItem) {
    lines.push('');
    lines.push('Checklist focus');
    if (contract.checklistVersion !== null) {
      lines.push(`Checklist version: ${contract.checklistVersion}`);
    }
    if (contract.activeChecklistItem) {
      lines.push(`Current checklist item: [${contract.activeChecklistItem.kind}] ${contract.activeChecklistItem.title}`);
      if (contract.activeChecklistItem.detail) {
        lines.push(`Item detail: ${contract.activeChecklistItem.detail}`);
      }
    }
  }
  if (contract.currentPlan.length > 0) {
    lines.push('');
    lines.push('Current plan');
    lines.push(...renderNumberedItems(contract.currentPlan));
  }
  if (contract.workpadSummary || contract.workpadNotes.length > 0 || contract.latestBlocker) {
    lines.push('');
    lines.push('Current workpad context');
    if (contract.workpadSummary) {
      lines.push(`Summary: ${contract.workpadSummary}`);
    }
    if (contract.latestBlocker) {
      lines.push(`Latest blocker: ${contract.latestBlocker}`);
    }
    if (contract.workpadNotes.length > 0) {
      lines.push('Notes:');
      lines.push(...renderBullets(contract.workpadNotes));
    }
  }
  lines.push('');
  lines.push('Stop conditions');
  lines.push(...renderBullets(contract.stopConditions));
  lines.push('');
  lines.push('Final report contract');
  lines.push(...contract.finalReportSections.map((section) => `- ${FINAL_REPORT_SECTION_DESCRIPTIONS[section]}`));
  lines.push('');
  lines.push('Workflow instructions');
  lines.push(contract.workflowPromptBody);
  return lines.join('\n').trim();
}

function renderBullets(values: string[]): string[] {
  if (values.length === 0) {
    return ['- none'];
  }
  return values.map((value) => `- ${value}`);
}

function renderNumberedItems(values: string[]): string[] {
  if (values.length === 0) {
    return ['1. none'];
  }
  return values.map((value, index) => `${index + 1}. ${value}`);
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function selectPromptChecklistItem(
  snapshot: ChecklistSnapshot | null,
): MissionPromptChecklistItem | null {
  if (!snapshot) {
    return null;
  }
  const nextItem = findPromptChecklistItem(snapshot);
  if (!nextItem) {
    return null;
  }
  return {
    id: nextItem.id,
    kind: nextItem.kind,
    title: nextItem.title,
    detail: nextItem.detail,
    status: nextItem.status,
  };
}

function findPromptChecklistItem(snapshot: ChecklistSnapshot): ChecklistItem | null {
  const activePlanItem = snapshot.items.find((item) => item.kind === 'plan' && item.status !== 'completed' && item.status !== 'skipped');
  if (activePlanItem) {
    return activePlanItem;
  }
  const activeAcceptanceItem = snapshot.items.find(
    (item) => item.kind === 'acceptance' && item.status !== 'completed' && item.status !== 'skipped',
  );
  if (activeAcceptanceItem) {
    return activeAcceptanceItem;
  }
  return snapshot.items.find((item) => item.status !== 'completed' && item.status !== 'skipped') ?? null;
}
