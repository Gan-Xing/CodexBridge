import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  JsonFileMissionRepository,
  MISSION_CONTROL_PACKAGE_PHASE,
  canTransitionMissionStatus,
  createMission,
  transitionMission,
} from '../src/index.js';
import type { MissionAttempt, MissionEvent } from '../src/index.js';

test('mission control package exposes the current Mission Control phase marker', () => {
  assert.equal(MISSION_CONTROL_PACKAGE_PHASE, 'phase-6-codexbridge-integration');
});

test('mission state transitions are explicit and reject invalid transitions', () => {
  const mission = createMission({
    id: 'mission-1',
    source: 'weixin',
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    title: 'Repair failing tests',
    goal: 'Repair the failing test suite and summarize the outcome.',
    expectedOutput: 'A verified repair summary.',
    providerProfileId: 'openai-default',
    acceptanceCriteria: ['Test suite passes'],
    plan: ['Inspect failures', 'Apply repair', 'Re-run tests'],
    now: 1_700_000_000_000,
  });

  assert.equal(mission.status, 'draft');
  assert.equal(canTransitionMissionStatus('draft', 'queued'), true);
  assert.equal(canTransitionMissionStatus('draft', 'completed'), false);

  const queued = transitionMission(mission, 'queued', {
    at: 1_700_000_000_100,
  });
  const running = transitionMission(queued, 'running', {
    at: 1_700_000_000_200,
    activeAttemptId: 'attempt-1',
  });
  const verifying = transitionMission(running, 'verifying', {
    at: 1_700_000_000_300,
  });
  const completed = transitionMission(verifying, 'completed', {
    at: 1_700_000_000_400,
    resultText: 'Tests repaired and verified.',
    resultArtifacts: [],
  });

  assert.equal(running.lastRunAt, 1_700_000_000_200);
  assert.equal(completed.completedAt, 1_700_000_000_400);
  assert.equal(completed.resultText, 'Tests repaired and verified.');

  assert.throws(() => transitionMission(mission, 'completed'), /invalid mission status transition/);
});

test('json repository can create, update, stop, and recover resumable missions after restart', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-phase1-'));
  const repo = new JsonFileMissionRepository(stateDir);
  const mission = transitionMission(createMission({
    id: 'mission-2',
    source: 'manual',
    platform: 'weixin',
    externalScopeId: 'wx-user-2',
    title: 'Daily deploy check',
    goal: 'Check the deployment and report blockers.',
    expectedOutput: 'A deployment status summary.',
    providerProfileId: 'openai-default',
    acceptanceCriteria: ['Deployment status recorded'],
    plan: ['Collect status', 'Verify health', 'Summarize blockers'],
    maxAttempts: 3,
    maxTurns: 8,
    now: 1_700_000_100_000,
  }), 'queued', {
    at: 1_700_000_100_100,
  });

  const attempt: MissionAttempt = {
    id: 'attempt-2',
    missionId: mission.id,
    index: 1,
    status: 'running',
    providerRunId: 'run-2',
    providerThreadId: 'thread-2',
    promptDigest: 'digest-2',
    verifierVerdict: null,
    verifierSummary: null,
    missingAcceptanceCriteria: [],
    outputPreview: null,
    error: null,
    startedAt: 1_700_000_100_200,
    endedAt: null,
    createdAt: 1_700_000_100_150,
    updatedAt: 1_700_000_100_200,
  };
  const event: MissionEvent = {
    id: 'event-2',
    missionId: mission.id,
    attemptId: attempt.id,
    kind: 'mission.started',
    summary: 'Mission started.',
    detail: null,
    metadata: { source: 'test' },
    createdAt: 1_700_000_100_250,
  };

  repo.saveMission(transitionMission(mission, 'running', {
    at: 1_700_000_100_200,
    activeAttemptId: attempt.id,
    lease: {
      ownerId: 'worker-1',
      acquiredAt: 1_700_000_100_200,
      heartbeatAt: 1_700_000_100_250,
      expiresAt: 1_700_000_100_260,
      releasedAt: null,
    },
  }));
  repo.saveAttempt(attempt);
  repo.appendEvent(event);

  const restarted = new JsonFileMissionRepository(stateDir);
  const persistedMission = restarted.getMissionById(mission.id);
  assert.ok(persistedMission);
  assert.equal(persistedMission?.status, 'running');
  assert.equal(restarted.listAttempts(mission.id).length, 1);
  assert.equal(restarted.listEvents(mission.id).length, 1);

  const resumable = restarted.listResumableMissions(1_700_000_100_300);
  assert.equal(resumable.length, 1);
  assert.equal(resumable[0]?.id, mission.id);

  const stopped = transitionMission(persistedMission!, 'stopped', {
    at: 1_700_000_100_400,
    reason: 'User requested stop.',
  });
  restarted.saveMission(stopped);

  const finalRepo = new JsonFileMissionRepository(stateDir);
  const finalMission = finalRepo.getMissionById(mission.id);
  assert.equal(finalMission?.status, 'stopped');
  assert.equal(finalMission?.statusReason, 'User requested stop.');
  assert.equal(finalRepo.listResumableMissions(1_700_000_100_500).length, 0);
});
