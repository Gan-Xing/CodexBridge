import type { Mission, MissionAttempt } from './types.js';
import type { LoadedMissionWorkflow } from './workflow.js';

export interface MissionWorkpadStatusView {
  missionId: string;
  title: string;
  status: string;
  workflowSourceLabel: string;
  summary: string | null;
  latestBlocker: string | null;
  latestVerifierSummary: string | null;
  finalResultSummary: string | null;
  attemptHistory: string[];
  notes: string[];
}

export interface CreateMissionWorkpadStatusViewInput {
  mission: Mission;
  attempts?: MissionAttempt[];
  workflow?: LoadedMissionWorkflow | null;
}

export function createMissionWorkpadStatusView(
  input: CreateMissionWorkpadStatusViewInput,
): MissionWorkpadStatusView {
  const attempts = [...(input.attempts ?? [])].sort((left, right) => {
    const leftGeneration = left.generationIndex ?? 0;
    const rightGeneration = right.generationIndex ?? 0;
    if (leftGeneration !== rightGeneration) {
      return leftGeneration - rightGeneration;
    }
    return left.index - right.index;
  });
  const workflowSourceLabel = input.workflow?.source.label
    ?? (input.mission.workflowPath
      ? `configured workflow (${input.mission.workflowPath})`
      : 'workflow source not yet loaded');

  return {
    missionId: input.mission.id,
    title: input.mission.title,
    status: input.mission.status,
    workflowSourceLabel,
    summary: input.mission.workpad.summary,
    latestBlocker: input.mission.workpad.latestBlocker,
    latestVerifierSummary: input.mission.workpad.latestVerifierSummary,
    finalResultSummary: input.mission.workpad.finalResultSummary,
    attemptHistory: attempts.map((attempt) => {
      const prefix = attempt.generationIndex && attempt.generationIndex > 1
        ? `g${attempt.generationIndex}/#${attempt.index}`
        : `#${attempt.index}`;
      const parts = [`${prefix} ${attempt.status}`];
      if (attempt.verifierVerdict) {
        parts.push(`verdict=${attempt.verifierVerdict}`);
      }
      if (attempt.missingAcceptanceCriteria.length > 0) {
        parts.push(`missing=${attempt.missingAcceptanceCriteria.length}`);
      }
      if (attempt.outputPreview) {
        parts.push(`preview=${truncate(attempt.outputPreview, 96)}`);
      }
      if (attempt.error) {
        parts.push(`error=${truncate(attempt.error, 96)}`);
      }
      return parts.join(' | ');
    }),
    notes: [...input.mission.workpad.notes],
  };
}

export function renderMissionWorkpadStatusView(view: MissionWorkpadStatusView): string {
  const lines: string[] = [];
  lines.push(`Mission: ${view.title}`);
  lines.push(`Mission ID: ${view.missionId}`);
  lines.push(`Status: ${view.status}`);
  lines.push(`Workflow: ${view.workflowSourceLabel}`);
  if (view.summary) {
    lines.push(`Summary: ${view.summary}`);
  }
  if (view.latestBlocker) {
    lines.push(`Latest blocker: ${view.latestBlocker}`);
  }
  if (view.latestVerifierSummary) {
    lines.push(`Verifier: ${view.latestVerifierSummary}`);
  }
  if (view.finalResultSummary) {
    lines.push(`Final result: ${view.finalResultSummary}`);
  }
  if (view.attemptHistory.length > 0) {
    lines.push('Attempts:');
    lines.push(...view.attemptHistory.map((item) => `- ${item}`));
  }
  if (view.notes.length > 0) {
    lines.push('Notes:');
    lines.push(...view.notes.map((item) => `- ${item}`));
  }
  return lines.join('\n');
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit - 1)}…`;
}
