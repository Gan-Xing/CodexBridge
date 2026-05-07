import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  JsonFileMissionRepository,
  createMission,
  createMissionResumeSnapshot,
  createMissionRetrySnapshot,
  shouldMissionRetryReuseAccumulatedContext,
  transitionMission,
} from '../src/index.js';
import type { MissionAttempt, MissionEvent } from '../src/index.js';

test('createMissionRetrySnapshot clears runtime history but preserves stable mission context', () => {
  const draft = createMission({
    id: 'mission-retry-1',
    source: 'weixin',
    platform: 'weixin',
    externalScopeId: 'wx-user-retry-1',
    title: 'Repair delivery stall',
    goal: 'Repair the stalled delivery and verify the result.',
    expectedOutput: 'A verified repair summary.',
    acceptanceCriteria: ['Delivery no longer stalls'],
    plan: ['Inspect logs', 'Patch the bridge', 'Verify with a repro'],
    providerProfileId: 'codex-default',
    bridgeSessionId: 'session-before-retry',
    codexThreadId: 'thread-before-retry',
    workflowPath: '/repo/.codexbridge/mission/WORKFLOW.md',
    workspacePath: '/tmp/mission-control/workspaces/mission-retry-1',
    now: 1_701_000_000_000,
  });
  const queued = transitionMission(draft, 'queued', { at: 1_701_000_000_100 });
  const running = transitionMission(queued, 'running', {
    at: 1_701_000_000_200,
    activeAttemptId: 'attempt-retry-1',
    lastResultPreview: 'Patched the first branch.',
  });
  const completed = transitionMission(running, 'verifying', {
    at: 1_701_000_000_300,
  });
  const mission = transitionMission(completed, 'completed', {
    at: 1_701_000_000_400,
    reason: 'Verification passed.',
    resultText: 'Delivery stall repaired.',
    resultArtifacts: [{ type: 'file', path: '/tmp/report.txt' }],
  });
  mission.attemptCount = 2;
  mission.lastRunAt = 1_701_000_000_350;
  mission.lastResultPreview = 'Delivery stall repaired.';
  mission.lastError = 'stale error';
  mission.workpad.latestBlocker = 'stale blocker';
  mission.workpad.latestVerifierSummary = 'Verification passed.';
  mission.workpad.finalResultSummary = 'Delivery stall repaired.';

  const retried = createMissionRetrySnapshot(mission, {
    at: 1_701_000_000_500,
    reason: 'User requested another pass.',
    codexThreadId: 'thread-after-retry',
  });

  assert.equal(retried.status, 'queued');
  assert.equal(retried.attemptCount, 0);
  assert.equal(retried.activeAttemptId, null);
  assert.equal(retried.lastRunAt, null);
  assert.equal(retried.completedAt, null);
  assert.equal(retried.lastResultPreview, null);
  assert.equal(retried.resultText, null);
  assert.deepEqual(retried.resultArtifacts, []);
  assert.equal(retried.lastError, null);
  assert.equal(retried.statusReason, 'User requested another pass.');
  assert.equal(retried.bridgeSessionId, 'session-before-retry');
  assert.equal(retried.codexThreadId, 'thread-after-retry');
  assert.equal(retried.workflowPath, '/repo/.codexbridge/mission/WORKFLOW.md');
  assert.equal(retried.workspacePath, '/tmp/mission-control/workspaces/mission-retry-1');
  assert.deepEqual(retried.workpad.latestPlan, mission.plan);
  assert.equal(retried.workpad.latestBlocker, null);
  assert.equal(retried.workpad.latestVerifierSummary, null);
  assert.equal(retried.workpad.finalResultSummary, null);
});

test('createMissionResumeSnapshot re-queues waiting missions without discarding accumulated context', () => {
  const draft = createMission({
    id: 'mission-resume-1',
    source: 'manual',
    platform: 'cli',
    externalScopeId: 'resume-scope-1',
    title: 'Finish blocked repair',
    goal: 'Continue after the user confirms the next step.',
    expectedOutput: 'A resumed mission result.',
    acceptanceCriteria: ['User input is incorporated'],
    plan: ['Collect the missing input', 'Continue the repair'],
    providerProfileId: 'codex-default',
    now: 1_701_000_100_000,
  });
  const queued = transitionMission(draft, 'queued', { at: 1_701_000_100_010 });
  const running = transitionMission(queued, 'running', {
    at: 1_701_000_100_020,
    activeAttemptId: 'attempt-resume-1',
  });
  const waiting = transitionMission(running, 'waiting_user', {
    at: 1_701_000_100_030,
    reason: 'Need the user to confirm the target branch.',
    lastError: 'Need the user to confirm the target branch.',
  });
  waiting.attemptCount = 1;
  waiting.lastResultPreview = 'Collected the failing branch candidates.';
  waiting.workpad.summary = 'Mission paused for user confirmation.';
  waiting.workpad.latestBlocker = 'Need the user to confirm the target branch.';
  waiting.workpad.latestVerifierSummary = 'Waiting for branch confirmation.';
  waiting.workpad.finalResultSummary = 'partial context';

  const resumed = createMissionResumeSnapshot(waiting, {
    at: 1_701_000_100_040,
    reason: 'User supplied the missing branch name.',
  });

  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.attemptCount, 1);
  assert.equal(resumed.activeAttemptId, null);
  assert.equal(resumed.lastError, null);
  assert.equal(resumed.statusReason, 'User supplied the missing branch name.');
  assert.equal(resumed.lastResultPreview, 'Collected the failing branch candidates.');
  assert.equal(resumed.workpad.summary, 'Mission paused for user confirmation.');
  assert.equal(resumed.workpad.latestBlocker, null);
  assert.equal(resumed.workpad.latestVerifierSummary, null);
  assert.equal(resumed.workpad.finalResultSummary, 'partial context');
});

test('createMissionResumeSnapshot can carry explicit human input back into queued workpad context', () => {
  const draft = createMission({
    id: 'mission-resume-response-1',
    source: 'manual',
    platform: 'cli',
    externalScopeId: 'resume-response-1',
    title: 'Resume with human input',
    goal: 'Continue after the user supplies missing information.',
    expectedOutput: 'A resumed mission result.',
    acceptanceCriteria: ['User input is preserved'],
    plan: ['Wait for the user', 'Continue the repair'],
    providerProfileId: 'codex-default',
    now: 1_701_000_110_000,
  });
  const queued = transitionMission(draft, 'queued', { at: 1_701_000_110_010 });
  const running = transitionMission(queued, 'running', {
    at: 1_701_000_110_020,
    activeAttemptId: 'attempt-resume-response-1',
  });
  const waiting = transitionMission(running, 'waiting_user', {
    at: 1_701_000_110_030,
    reason: 'Need the deployment window.',
  });

  const resumed = createMissionResumeSnapshot(waiting, {
    at: 1_701_000_110_040,
    reason: 'User supplied the missing deployment window.',
    responseText: 'Deployment window: tomorrow 09:00 UTC.',
  });

  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.workpad.summary, 'Mission queued after human response.');
  assert.match(resumed.workpad.notes.at(-1) ?? '', /Deployment window: tomorrow 09:00 UTC\./);
});

test('shouldMissionRetryReuseAccumulatedContext only preserves waiting-human continuation states', () => {
  const draft = createMission({
    id: 'mission-resume-policy-1',
    source: 'manual',
    platform: 'cli',
    externalScopeId: 'resume-policy-1',
    title: 'Resume policy',
    goal: 'Decide whether retry should preserve runtime context.',
    expectedOutput: 'A requeue policy verdict.',
    providerProfileId: 'codex-default',
    now: 1_701_000_150_000,
  });
  const queued = transitionMission(draft, 'queued', { at: 1_701_000_150_010 });
  const waitingUser = transitionMission(queued, 'running', {
    at: 1_701_000_150_020,
    activeAttemptId: 'attempt-resume-policy-1',
  });
  const waiting = transitionMission(waitingUser, 'waiting_user', {
    at: 1_701_000_150_030,
    reason: 'Need the branch name.',
  });
  const blocked = transitionMission(waiting, 'queued', { at: 1_701_000_150_040 });
  const blockedRunning = transitionMission(blocked, 'running', {
    at: 1_701_000_150_050,
    activeAttemptId: 'attempt-resume-policy-2',
  });
  const blockedMission = transitionMission(blockedRunning, 'blocked', {
    at: 1_701_000_150_060,
    reason: 'Need a missing secret.',
  });
  const failed = transitionMission(blockedMission, 'failed', {
    at: 1_701_000_150_070,
    reason: 'Budget exhausted.',
  });

  assert.equal(shouldMissionRetryReuseAccumulatedContext(waiting), true);
  assert.equal(shouldMissionRetryReuseAccumulatedContext(blockedMission), true);
  assert.equal(shouldMissionRetryReuseAccumulatedContext(failed), false);
});

test('json repository resetMission replaces the mission snapshot and clears attempts and events for that mission', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-reset-'));
  const repo = new JsonFileMissionRepository(stateDir);
  const mission = transitionMission(createMission({
    id: 'mission-reset-1',
    source: 'manual',
    platform: 'weixin',
    externalScopeId: 'wx-user-reset-1',
    title: 'Reset mission runtime state',
    goal: 'Replace the mission snapshot and discard stale attempts.',
    expectedOutput: 'A clean queued mission snapshot.',
    providerProfileId: 'codex-default',
    now: 1_701_000_200_000,
  }), 'queued', {
    at: 1_701_000_200_010,
  });
  const attempt: MissionAttempt = {
    id: 'attempt-reset-1',
    missionId: mission.id,
    index: 1,
    status: 'failed',
    providerRunId: 'run-reset-1',
    providerThreadId: 'thread-reset-1',
    promptDigest: 'digest-reset-1',
    verifierVerdict: 'failed',
    verifierSummary: 'Retry needed.',
    missingAcceptanceCriteria: ['Provide a clean rerun.'],
    outputPreview: 'stale output',
    error: 'stale error',
    startedAt: 1_701_000_200_020,
    endedAt: 1_701_000_200_030,
    createdAt: 1_701_000_200_020,
    updatedAt: 1_701_000_200_030,
  };
  const event: MissionEvent = {
    id: 'event-reset-1',
    missionId: mission.id,
    attemptId: attempt.id,
    kind: 'mission.failed',
    summary: 'Mission failed.',
    detail: null,
    metadata: {},
    createdAt: 1_701_000_200_040,
  };
  repo.saveMission(mission);
  repo.saveAttempt(attempt);
  repo.appendEvent(event);

  const retried = createMissionRetrySnapshot(mission, {
    at: 1_701_000_200_050,
  });
  repo.resetMission(retried);

  assert.equal(repo.getMissionById(mission.id)?.status, 'queued');
  assert.equal(repo.listAttempts(mission.id).length, 0);
  assert.equal(repo.listEvents(mission.id).length, 0);
});
