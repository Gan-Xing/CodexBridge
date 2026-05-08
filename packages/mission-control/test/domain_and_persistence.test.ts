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
  createMissionChecklistSnapshot,
  createMissionGeneration,
  createMissionRetryAggregate,
  createMissionWorkItem,
  transitionMission,
} from '../src/index.js';
import type { MissionAttempt, MissionEvent } from '../src/index.js';

test('mission control package exposes the current Mission Control phase marker', () => {
  assert.equal(MISSION_CONTROL_PACKAGE_PHASE, 'phase-9v-checklist-refinement-gates');
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
    workflowPath: null,
    workflowHash: null,
    resolverReason: null,
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

test('json repository persists work items, generations, and checklist snapshots while keeping prior attempt history across fresh reruns', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-phase7a-'));
  const repo = new JsonFileMissionRepository(stateDir);
  const draft = createMission({
    id: 'mission-phase7a-1',
    source: 'manual',
    platform: 'weixin',
    externalScopeId: 'wx-user-phase7a-1',
    title: 'Preserve rerun lineage',
    goal: 'Keep prior mission history when starting a fresh rerun.',
    expectedOutput: 'A lineage-preserving retry snapshot.',
    acceptanceCriteria: ['History is still queryable after retry'],
    plan: ['Complete one generation', 'Queue a fresh rerun'],
    providerProfileId: 'openai-default',
    maxAttempts: 3,
    maxTurns: 8,
    now: 1_700_000_200_000,
  });
  const queued = transitionMission(draft, 'queued', {
    at: 1_700_000_200_010,
  });
  const running = transitionMission(queued, 'running', {
    at: 1_700_000_200_020,
    activeAttemptId: 'attempt-phase7a-1',
  });
  const verifying = transitionMission(running, 'verifying', {
    at: 1_700_000_200_030,
  });
  const mission = transitionMission(verifying, 'completed', {
    at: 1_700_000_200_100,
    reason: 'Generation one completed.',
    resultText: 'Generation one passed.',
  });
  mission.attemptCount = 1;
  repo.saveMission(mission);
  repo.saveWorkItem(createMissionWorkItem(mission, { at: 1_700_000_200_100 }));
  repo.saveGeneration(createMissionGeneration(mission, {
    at: 1_700_000_200_100,
    trigger: 'initial',
  }));
  repo.saveChecklistSnapshot(createMissionChecklistSnapshot(mission, {
    at: 1_700_000_200_100,
    generationId: mission.activeGenerationId,
  }));

  const attempt: MissionAttempt = {
    id: 'attempt-phase7a-1',
    missionId: mission.id,
    index: 1,
    status: 'completed',
    providerRunId: 'run-phase7a-1',
    providerThreadId: 'thread-phase7a-1',
    workflowPath: mission.workflowPath,
    workflowHash: mission.workflowHash,
    resolverReason: mission.workflowResolverReason,
    promptDigest: 'digest-phase7a-1',
    verifierVerdict: 'complete',
    verifierSummary: 'Generation one passed.',
    missingAcceptanceCriteria: [],
    outputPreview: 'Generation one passed.',
    error: null,
    startedAt: 1_700_000_200_010,
    endedAt: 1_700_000_200_090,
    createdAt: 1_700_000_200_010,
    updatedAt: 1_700_000_200_090,
  };
  const event: MissionEvent = {
    id: 'event-phase7a-1',
    missionId: mission.id,
    attemptId: attempt.id,
    kind: 'mission.completed',
    summary: 'Mission completed.',
    detail: null,
    metadata: {},
    createdAt: 1_700_000_200_095,
  };
  repo.saveAttempt(attempt);
  repo.appendEvent(event);

  const retried = createMissionRetryAggregate(mission, {
    at: 1_700_000_200_200,
    reason: 'Open a fresh generation.',
  });
  repo.saveMission(retried.mission);
  repo.saveGeneration(retried.generation);
  repo.saveChecklistSnapshot(retried.checklistSnapshot);

  const restarted = new JsonFileMissionRepository(stateDir);
  assert.equal(restarted.getWorkItemById(mission.workItemId)?.id, mission.workItemId);
  assert.equal(restarted.listGenerations(mission.id).length, 2);
  assert.equal(restarted.listChecklistSnapshots(mission.id).length, 2);
  assert.equal(restarted.listAttempts(mission.id).length, 1);
  assert.equal(restarted.listEvents(mission.id).length, 1);
  assert.equal(restarted.getMissionById(mission.id)?.activeGenerationIndex, 2);
  assert.equal(restarted.getMissionById(mission.id)?.attemptCount, 0);
});

test('json repository persists environment stamps and checkpoints as package-owned runtime artifacts', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-phase9s-'));
  const repo = new JsonFileMissionRepository(stateDir);
  const queued = transitionMission(createMission({
    id: 'mission-phase9s-1',
    source: 'manual',
    platform: 'weixin',
    externalScopeId: 'wx-user-phase9s-1',
    title: 'Persist execution context',
    goal: 'Keep environment and checkpoint artifacts available for audit.',
    expectedOutput: 'Persisted runtime audit records.',
    acceptanceCriteria: ['Environment stamp is queryable', 'Checkpoint history is queryable'],
    plan: ['Capture execution environment', 'Persist a runtime checkpoint'],
    providerProfileId: 'openai-default',
    cwd: '/repo',
    workflowHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    now: 1_700_000_300_000,
  }), 'queued', {
    at: 1_700_000_300_005,
  });
  const mission = transitionMission(queued, 'running', {
    at: 1_700_000_300_010,
    activeAttemptId: 'attempt-phase9s-1',
  });

  repo.saveMission(mission);
  repo.saveEnvironmentStamp({
    id: `${mission.id}:env:attempt-phase9s-1`,
    missionId: mission.id,
    generationId: mission.activeGenerationId,
    generationIndex: mission.activeGenerationIndex,
    attemptId: 'attempt-phase9s-1',
    cycle: 1,
    cwd: '/repo',
    workspacePath: '/tmp/workspace-phase9s-1',
    gitSha: 'abcdef0123456789abcdef0123456789abcdef01abcdef0123456789abcdef01',
    gitBranch: 'track/mission-control',
    workflowHash: mission.workflowHash,
    providerProfileId: mission.providerProfileId,
    capturedAt: 1_700_000_300_020,
  });
  repo.saveCheckpoint({
    id: `${mission.id}:checkpoint:1`,
    missionId: mission.id,
    attemptId: 'attempt-phase9s-1',
    generationId: mission.activeGenerationId,
    generationIndex: mission.activeGenerationIndex,
    cycle: 1,
    stage: 'attempt.started',
    summary: 'Attempt #1 is ready to run.',
    payload: {
      workspacePath: '/tmp/workspace-phase9s-1',
      workflowHash: mission.workflowHash,
    },
    createdAt: 1_700_000_300_030,
  });

  const reloaded = new JsonFileMissionRepository(stateDir);
  assert.equal(reloaded.listEnvironmentStamps(mission.id).length, 1);
  assert.equal(reloaded.listEnvironmentStamps(mission.id)[0]?.workspacePath, '/tmp/workspace-phase9s-1');
  assert.equal(reloaded.listEnvironmentStamps(mission.id)[0]?.gitBranch, 'track/mission-control');
  assert.equal(reloaded.listCheckpoints(mission.id).length, 1);
  assert.equal(reloaded.listCheckpoints(mission.id)[0]?.stage, 'attempt.started');
  assert.deepEqual(reloaded.listCheckpoints(mission.id)[0]?.payload, {
    workspacePath: '/tmp/workspace-phase9s-1',
    workflowHash: mission.workflowHash,
  });
});
