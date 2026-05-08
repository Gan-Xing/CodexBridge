import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMissionVerifierResultToAttempt,
  applyMissionVerifierResultToMission,
  createMission,
  createMissionRepairPrompt,
  createMissionVerifierResult,
  mapMissionVerifierVerdictToMissionStatus,
  resolveMissionPlanChangeSuggestion,
  resolveMissionVerifierBudget,
  transitionMission,
  evaluateMissionVerifierBudget,
} from '../src/index.js';
import type { LoadedMissionWorkflow, MissionAttempt } from '../src/index.js';

function createWorkflow(): LoadedMissionWorkflow {
  return {
    source: {
      kind: 'built-in-default',
      path: '/repo/.codexbridge/mission/WORKFLOW.md',
      label: 'built-in defaults',
    },
    hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    policy: {
      version: 1,
      maxTurns: 6,
      maxAttempts: 2,
      maxRuntimeMs: 10 * 60_000,
      maxArtifactCount: 3,
      maxArtifactBytes: 4096,
      continuation: 'allow',
      requirePlanUpdate: true,
      requireWorkpadUpdate: true,
      defaultHandoffState: 'needs_human',
      stopConditions: ['Stop after verifier says the fix is incomplete.'],
      finalReportSections: ['summary', 'verification', 'artifacts', 'next_steps'],
      promptBody: 'Do the work and verify it carefully.',
    },
    rawFrontMatter: {},
    rawText: 'Do the work and verify it carefully.',
  };
}

function createVerifyingMissionAndAttempt() {
  const mission = transitionMission(
    transitionMission(
      transitionMission(createMission({
        id: 'mission-verifier-1',
        source: 'weixin',
        platform: 'weixin',
        externalScopeId: 'wx-verifier-1',
        title: 'Repair preview freeze',
        goal: 'Repair the preview freeze and prove the fix.',
        expectedOutput: 'A verified repair summary.',
        providerProfileId: 'codex-default',
        acceptanceCriteria: ['Preview no longer freezes', 'Tests prove the fix'],
        plan: ['Inspect failure', 'Patch code', 'Verify fix'],
        maxAttempts: 4,
        maxTurns: 8,
        now: 1_700_700_000_000,
      }), 'queued', {
        at: 1_700_700_000_100,
      }),
      'running',
      {
        at: 1_700_700_000_150,
        activeAttemptId: 'attempt-verifier-1',
      },
    ),
    'verifying',
    {
      at: 1_700_700_000_200,
      activeAttemptId: 'attempt-verifier-1',
    },
  );

  const attempt: MissionAttempt = {
    id: 'attempt-verifier-1',
    missionId: mission.id,
    index: 2,
    status: 'verifying',
    providerRunId: 'run-verifier-1',
    providerThreadId: 'thread-verifier-1',
    workflowPath: null,
    workflowHash: null,
    resolverReason: null,
    promptDigest: 'digest-verifier-1',
    verifierVerdict: null,
    verifierSummary: null,
    missingAcceptanceCriteria: [],
    outputPreview: 'Patched the preview code path but did not rerun tests.',
    error: null,
    startedAt: 1_700_700_000_100,
    endedAt: null,
    createdAt: 1_700_700_000_000,
    updatedAt: 1_700_700_000_200,
  };

  return { mission, attempt };
}

test('verifier helpers normalize waiting-user and repair verdicts into explicit mission states', () => {
  const repair = createMissionVerifierResult({
    verdict: 'repair',
    missingAcceptanceCriteria: ['Tests prove the fix'],
  });
  assert.equal(repair.verdict, 'repair');
  assert.match(repair.summary, /Acceptance criteria still missing/);
  assert.equal(mapMissionVerifierVerdictToMissionStatus(repair.verdict), 'repairing');

  const waitingUser = createMissionVerifierResult({
    verdict: 'waiting_user',
    summary: 'Need the user to confirm the risky migration.',
  });
  assert.equal(waitingUser.verdict, 'waiting_user');
  assert.equal(mapMissionVerifierVerdictToMissionStatus(waitingUser.verdict), 'waiting_user');
});

test('verifier helpers persist summaries and missing acceptance criteria onto attempts and missions', () => {
  const { mission, attempt } = createVerifyingMissionAndAttempt();
  const result = createMissionVerifierResult({
    verdict: 'repair',
    summary: 'The patch exists, but the preview flow was not rerun.',
    missingAcceptanceCriteria: ['Preview no longer freezes', 'Tests prove the fix'],
  });

  const updatedAttempt = applyMissionVerifierResultToAttempt(attempt, result, 1_700_700_000_300);
  assert.equal(updatedAttempt.status, 'repairing');
  assert.deepEqual(updatedAttempt.missingAcceptanceCriteria, [
    'Preview no longer freezes',
    'Tests prove the fix',
  ]);
  assert.equal(updatedAttempt.verifierSummary, 'The patch exists, but the preview flow was not rerun.');

  const updatedMission = applyMissionVerifierResultToMission(mission, result, {
    at: 1_700_700_000_300,
  });
  assert.equal(updatedMission.status, 'repairing');
  assert.equal(updatedMission.workpad.latestVerifierSummary, result.summary);
  assert.match(updatedMission.workpad.latestBlocker ?? '', /Missing acceptance criteria/);

  const repairPrompt = createMissionRepairPrompt({
    mission: updatedMission,
    attempt: updatedAttempt,
    workflow: createWorkflow(),
    verifierResult: result,
  });
  assert.match(repairPrompt, /Verifier repair contract/);
  assert.match(repairPrompt, /Preview no longer freezes/);
  assert.match(repairPrompt, /Tests prove the fix/);
});

test('verifier helpers normalize formal checklist refinement suggestions without treating workpad substeps as checklist changes', () => {
  const { mission } = createVerifyingMissionAndAttempt();
  const result = createMissionVerifierResult({
    verdict: 'repair',
    summary: 'The fix needs a targeted regression-test checklist item before retrying.',
    missingAcceptanceCriteria: ['Tests prove the fix'],
    planChangeSuggestion: {
      rationale: 'Split verification into implementation and targeted regression-test steps.',
      proposedPlan: ['Inspect failure', 'Patch code', 'Add regression test coverage', 'Run targeted verification'],
      proposedAcceptanceCriteria: ['Preview no longer freezes', 'Targeted tests prove the fix'],
    },
  });

  assert.equal(
    result.planChangeSuggestion?.rationale,
    'Split verification into implementation and targeted regression-test steps.',
  );
  assert.equal(
    resolveMissionPlanChangeSuggestion(mission, {
      rationale: 'Keep the workpad notes more detailed.',
    }),
    null,
  );
  assert.deepEqual(
    resolveMissionPlanChangeSuggestion(mission, result.planChangeSuggestion),
    {
      rationale: 'Split verification into implementation and targeted regression-test steps.',
      proposedExpectedOutput: mission.expectedOutput,
      proposedAcceptanceCriteria: ['Preview no longer freezes', 'Targeted tests prove the fix'],
      proposedPlan: ['Inspect failure', 'Patch code', 'Add regression test coverage', 'Run targeted verification'],
    },
  );
});

test('verifier budget helpers resolve workflow limits and report exhausted budgets', () => {
  const { mission } = createVerifyingMissionAndAttempt();
  const budget = resolveMissionVerifierBudget({
    mission,
    workflow: createWorkflow(),
  });

  assert.equal(budget.maxAttempts, 2);
  assert.equal(budget.maxTurns, 6);
  assert.equal(budget.maxRuntimeMs, 10 * 60_000);
  assert.equal(budget.maxArtifactCount, 3);
  assert.equal(budget.maxArtifactBytes, 4096);

  const issues = evaluateMissionVerifierBudget(budget, {
    attemptCount: 2,
    turnCount: 6,
    runtimeMs: 10 * 60_000,
    artifactCount: 3,
    artifactBytes: 4096,
  });
  assert.deepEqual(issues, [
    'max attempts exhausted (2/2)',
    'max turns exhausted (6/6)',
    'max runtime exhausted (600000ms/600000ms)',
    'max artifact count exhausted (3/3)',
    'max artifact bytes exhausted (4096/4096)',
  ]);
});
