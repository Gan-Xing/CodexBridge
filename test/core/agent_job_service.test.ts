import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMission,
  transitionMission,
  type MissionAttempt,
  type MissionEvent,
} from '../../packages/mission-control/src/index.js';
import { AgentJobService } from '../../src/core/agent_job_service.js';
import {
  loadAgentJobMissionRuntimeState,
  serializeAgentJobMissionRuntimeState,
} from '../../src/core/mission_control_agent_job_adapter.js';
import { InMemoryAgentJobRepository } from '../../src/store/in_memory/in_memory_agent_job_repository.js';
import type { BridgeSession } from '../../src/types/core.js';

function makeAgentJobService(now: number, bridgeSession: BridgeSession) {
  return new AgentJobService({
    agentJobs: new InMemoryAgentJobRepository(),
    bridgeSessions: {
      getSessionById(bridgeSessionId: string) {
        return bridgeSessionId === bridgeSession.id ? bridgeSession : null;
      },
    },
    now: () => now,
  });
}

function createAgentJobFixture(service: AgentJobService) {
  return service.createJob({
    scopeRef: {
      platform: 'weixin',
      externalScopeId: 'wx-agent-service-1',
    },
    title: 'Repair waiting mission',
    originalInput: '/agent continue the blocked repair',
    goal: 'Continue the waiting mission with the missing input.',
    expectedOutput: 'A completed verified repair summary.',
    plan: ['Inspect context', 'Continue the repair'],
    category: 'code',
    riskLevel: 'medium',
    mode: 'codex',
    providerProfileId: 'codex-default',
    bridgeSessionId: 'session-agent-service-1',
    cwd: '/repo',
    locale: 'zh-CN',
    maxAttempts: 3,
  });
}

test('AgentJobService retryJob preserves Mission Control runtime history when re-queueing waiting-human missions', () => {
  const now = 1_701_100_000_000;
  const service = makeAgentJobService(now, {
    id: 'session-agent-service-1',
    providerProfileId: 'codex-default',
    codexThreadId: 'thread-agent-service-1',
    cwd: '/repo',
    title: 'Mission session',
    createdAt: now - 1_000,
    updatedAt: now - 500,
  });
  const job = createAgentJobFixture(service);

  const queued = transitionMission(createMission({
    id: job.id,
    source: 'weixin',
    sourceRef: job.id,
    platform: job.platform,
    externalScopeId: job.externalScopeId,
    title: job.title,
    goal: job.goal,
    expectedOutput: job.expectedOutput,
    acceptanceCriteria: [job.expectedOutput],
    plan: [...job.plan],
    riskLevel: job.riskLevel,
    cwd: job.cwd,
    providerProfileId: job.providerProfileId,
    bridgeSessionId: job.bridgeSessionId,
    codexThreadId: 'thread-agent-service-1',
    maxAttempts: job.maxAttempts,
    maxTurns: 8,
    now: now - 400,
  }), 'queued', {
    at: now - 390,
  });
  const running = transitionMission(queued, 'running', {
    at: now - 380,
    activeAttemptId: 'attempt-agent-service-1',
    lastResultPreview: 'Collected the likely branch names.',
  });
  const waiting = transitionMission(running, 'waiting_user', {
    at: now - 370,
    reason: 'Need the user to confirm the target branch.',
    lastError: 'Need the user to confirm the target branch.',
  });
  waiting.attemptCount = 1;
  waiting.lastResultPreview = 'Collected the likely branch names.';
  waiting.workpad.summary = 'Mission paused for user confirmation.';
  waiting.workpad.latestBlocker = 'Need the user to confirm the target branch.';
  waiting.workpad.latestVerifierSummary = 'Waiting for branch confirmation.';
  waiting.workpad.finalResultSummary = 'partial context';

  const attempt: MissionAttempt = {
    id: 'attempt-agent-service-1',
    missionId: waiting.id,
    index: 1,
    status: 'waiting_user',
    providerRunId: 'run-agent-service-1',
    providerThreadId: 'thread-agent-service-1',
    promptDigest: 'digest-agent-service-1',
    verifierVerdict: 'waiting_user',
    verifierSummary: 'Waiting for branch confirmation.',
    missingAcceptanceCriteria: ['User confirms the target branch.'],
    outputPreview: 'Collected the likely branch names.',
    error: 'Need the user to confirm the target branch.',
    startedAt: now - 385,
    endedAt: now - 370,
    createdAt: now - 385,
    updatedAt: now - 370,
  };
  const event: MissionEvent = {
    id: 'event-agent-service-1',
    missionId: waiting.id,
    attemptId: attempt.id,
    kind: 'mission.waiting_user',
    summary: 'Mission is waiting for user input.',
    detail: null,
    metadata: {},
    createdAt: now - 365,
  };

  service.updateJob(job.id, {
    status: 'completed',
    running: false,
    attemptCount: 0,
    completedAt: now - 100,
    lastResultPreview: 'stale preview',
    resultText: 'stale completed text',
    lastError: 'stale error',
    verificationSummary: 'stale verifier summary',
    missionWorkpadLatestBlocker: 'stale blocker',
    missionWorkpadLatestVerifierSummary: 'stale verifier summary',
    missionWorkpadFinalResultSummary: 'stale final summary',
    missionAttemptHistory: [],
    missionRuntimeState: serializeAgentJobMissionRuntimeState({
      mission: waiting,
      attempts: [attempt],
      events: [event],
    }),
  });

  const retried = service.retryJob(job.id);
  const runtimeState = loadAgentJobMissionRuntimeState(retried);

  assert.equal(retried.status, 'queued');
  assert.equal(retried.running, false);
  assert.equal(retried.stopRequested, false);
  assert.equal(retried.attemptCount, 1);
  assert.equal(retried.lastRunAt, now - 380);
  assert.equal(retried.completedAt, null);
  assert.equal(retried.lastResultPreview, 'Collected the likely branch names.');
  assert.equal(retried.resultText, null);
  assert.equal(retried.lastError, null);
  assert.equal(retried.verificationSummary, null);
  assert.equal(retried.missionWorkpadLatestBlocker, null);
  assert.equal(retried.missionWorkpadLatestVerifierSummary, null);
  assert.equal(retried.missionWorkpadFinalResultSummary, 'partial context');
  assert.equal(retried.missionAttemptHistory.length, 1);
  assert.equal(retried.missionAttemptHistory[0]?.status, 'waiting_user');
  assert.equal(runtimeState.mission?.status, 'queued');
  assert.equal(runtimeState.mission?.attemptCount, 1);
  assert.equal(runtimeState.mission?.lastResultPreview, 'Collected the likely branch names.');
  assert.equal(runtimeState.mission?.workpad.latestBlocker, null);
  assert.equal(runtimeState.mission?.workpad.latestVerifierSummary, null);
  assert.equal(runtimeState.attempts.length, 1);
  assert.equal(runtimeState.events.length, 1);
  assert.equal(runtimeState.attempts[0]?.status, 'waiting_user');
});

test('AgentJobService retryJob still clears runtime history for fresh reruns', () => {
  const now = 1_701_100_010_000;
  const service = makeAgentJobService(now, {
    id: 'session-agent-service-1',
    providerProfileId: 'codex-default',
    codexThreadId: 'thread-after-retry',
    cwd: '/repo',
    title: 'Mission session',
    createdAt: now - 1_000,
    updatedAt: now - 500,
  });
  const job = createAgentJobFixture(service);

  const queued = transitionMission(createMission({
    id: job.id,
    source: 'weixin',
    sourceRef: job.id,
    platform: job.platform,
    externalScopeId: job.externalScopeId,
    title: job.title,
    goal: job.goal,
    expectedOutput: job.expectedOutput,
    acceptanceCriteria: [job.expectedOutput],
    plan: [...job.plan],
    riskLevel: job.riskLevel,
    cwd: job.cwd,
    providerProfileId: job.providerProfileId,
    bridgeSessionId: job.bridgeSessionId,
    codexThreadId: 'thread-before-retry',
    maxAttempts: job.maxAttempts,
    maxTurns: 8,
    now: now - 400,
  }), 'queued', {
    at: now - 390,
  });
  const running = transitionMission(queued, 'running', {
    at: now - 380,
    activeAttemptId: 'attempt-agent-service-2',
  });
  const completed = transitionMission(running, 'verifying', {
    at: now - 370,
  });
  const mission = transitionMission(completed, 'completed', {
    at: now - 360,
    reason: 'Verification passed.',
    lastResultPreview: 'Verified repair summary.',
    resultText: 'Verified repair summary.',
  });
  mission.attemptCount = 2;
  mission.workpad.latestVerifierSummary = 'Verification passed.';
  mission.workpad.finalResultSummary = 'Verified repair summary.';

  const attempt: MissionAttempt = {
    id: 'attempt-agent-service-2',
    missionId: mission.id,
    index: 2,
    status: 'completed',
    providerRunId: 'run-agent-service-2',
    providerThreadId: 'thread-before-retry',
    promptDigest: 'digest-agent-service-2',
    verifierVerdict: 'complete',
    verifierSummary: 'Verification passed.',
    missingAcceptanceCriteria: [],
    outputPreview: 'Verified repair summary.',
    error: null,
    startedAt: now - 390,
    endedAt: now - 360,
    createdAt: now - 390,
    updatedAt: now - 360,
  };
  const event: MissionEvent = {
    id: 'event-agent-service-2',
    missionId: mission.id,
    attemptId: attempt.id,
    kind: 'mission.completed',
    summary: 'Mission completed.',
    detail: null,
    metadata: {},
    createdAt: now - 355,
  };

  service.updateJob(job.id, {
    status: 'completed',
    running: false,
    attemptCount: 2,
    completedAt: now - 360,
    lastResultPreview: 'Verified repair summary.',
    resultText: 'Verified repair summary.',
    verificationSummary: 'Verification passed.',
    missionWorkpadLatestVerifierSummary: 'Verification passed.',
    missionWorkpadFinalResultSummary: 'Verified repair summary.',
    missionAttemptHistory: [{
      attempt: 2,
      status: 'completed',
      verifierSummary: 'Verification passed.',
      outputPreview: 'Verified repair summary.',
      error: null,
      recordedAt: now - 355,
    }],
    missionRuntimeState: serializeAgentJobMissionRuntimeState({
      mission,
      attempts: [attempt],
      events: [event],
    }),
  });

  const retried = service.retryJob(job.id);
  const runtimeState = loadAgentJobMissionRuntimeState(retried);

  assert.equal(retried.status, 'queued');
  assert.equal(retried.attemptCount, 0);
  assert.equal(retried.lastRunAt, null);
  assert.equal(retried.lastResultPreview, null);
  assert.equal(retried.resultText, null);
  assert.equal(retried.verificationSummary, null);
  assert.equal(retried.missionAttemptHistory.length, 0);
  assert.equal(runtimeState.mission?.status, 'queued');
  assert.equal(runtimeState.mission?.attemptCount, 0);
  assert.equal(runtimeState.mission?.codexThreadId, 'thread-after-retry');
  assert.equal(runtimeState.attempts.length, 0);
  assert.equal(runtimeState.events.length, 0);
});
