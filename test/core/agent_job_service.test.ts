import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryMissionRepository,
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
import type { AgentJob, BridgeSession } from '../../src/types/core.js';

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

test('AgentJobService keeps package-owned mission authority when AgentJob compatibility state is missing', () => {
  const now = 1_701_099_990_000;
  const bridgeSession: BridgeSession = {
    id: 'session-agent-service-1',
    providerProfileId: 'codex-default',
    codexThreadId: 'thread-agent-service-1',
    cwd: '/repo',
    title: 'Mission session',
    createdAt: now - 1_000,
    updatedAt: now - 500,
  };
  const agentJobs = new InMemoryAgentJobRepository();
  const missionRepository = new InMemoryMissionRepository();
  const service = new AgentJobService({
    agentJobs,
    missionRepository,
    bridgeSessions: {
      getSessionById(bridgeSessionId: string) {
        return bridgeSessionId === bridgeSession.id ? bridgeSession : null;
      },
    },
    now: () => now,
  });

  const created = createAgentJobFixture(service);
  assert.equal(missionRepository.getMissionById(created.id)?.title, created.title);

  agentJobs.save({
    ...service.requireById(created.id),
    missionRuntimeState: null,
    missionAttemptHistory: [],
    missionWorkflowPath: null,
    missionWorkflowSourceLabel: null,
    missionWorkpadLatestBlocker: null,
    missionWorkpadLatestVerifierSummary: null,
    missionWorkpadFinalResultSummary: null,
  });

  const detail = service.getMissionDetail(created.id);
  assert.equal(detail?.mission.id, created.id);
  assert.equal(detail?.mission.title, created.title);
  assert.equal(detail?.workItem?.title, created.title);
  assert.equal(detail?.hostBindings.bridgeSessionId, bridgeSession.id);

  const renamed = service.renameJob(created.id, 'Renamed authority task');
  const renamedAgain = service.renameJob(created.id, 'Renamed authority task v2');
  assert.equal(renamed.title, 'Renamed authority task');
  assert.equal(renamedAgain.title, 'Renamed authority task v2');
  assert.equal(service.getMissionDetail(created.id)?.mission.title, 'Renamed authority task v2');
  assert.equal(missionRepository.getMissionById(created.id)?.title, 'Renamed authority task v2');
  assert.equal(
    missionRepository.getWorkItemById(`${created.id}:work-item`)?.title,
    'Renamed authority task v2',
  );
  assert.deepEqual(
    missionRepository.listEvents(created.id).map((event) => event.kind),
    ['mission.created', 'mission.source_synced', 'mission.source_synced'],
  );
  assert.deepEqual(
    missionRepository.listChecklistSnapshots(created.id).map((snapshot) => ({
      version: snapshot.version,
      supersededAt: snapshot.supersededAt,
    })),
    [
      { version: 1, supersededAt: now },
      { version: 2, supersededAt: now },
      { version: 3, supersededAt: null },
    ],
  );
});

test('AgentJobService normalizes legacy AgentJob mission fields before recovery', () => {
  const now = 1_701_099_992_000;
  const bridgeSession: BridgeSession = {
    id: 'session-agent-service-legacy',
    providerProfileId: 'codex-default',
    codexThreadId: 'thread-agent-service-legacy',
    cwd: '/repo',
    title: 'Mission session',
    createdAt: now - 1_000,
    updatedAt: now - 500,
  };
  const agentJobs = new InMemoryAgentJobRepository();
  const missionRepository = new InMemoryMissionRepository();
  const service = new AgentJobService({
    agentJobs,
    missionRepository,
    bridgeSessions: {
      getSessionById(bridgeSessionId: string) {
        return bridgeSessionId === bridgeSession.id ? bridgeSession : null;
      },
    },
    now: () => now,
  });

  const legacyJob = {
    id: 'job-legacy-mission-fields',
    platform: 'weixin',
    externalScopeId: 'wxid_legacy_mission_fields',
    title: 'Legacy mission record',
    originalInput: '/agent continue legacy mission',
    goal: 'Resume a legacy mission without mission compatibility fields.',
    expectedOutput: 'A recovered mission summary.',
    plan: ['Resume mission'],
    category: 'code',
    riskLevel: 'medium',
    mode: 'codex',
    providerProfileId: 'codex-default',
    bridgeSessionId: bridgeSession.id,
    cwd: '/repo',
    locale: 'zh-CN',
    status: 'completed',
    running: false,
    stopRequested: false,
    maxAttempts: 2,
    attemptCount: 1,
    lastRunAt: now - 10_000,
    completedAt: now - 9_000,
    lastResultPreview: 'Recovered preview',
    resultText: 'Recovered preview',
    resultArtifacts: null,
    lastError: null,
    verificationSummary: 'Looks good',
    createdAt: now - 20_000,
    updatedAt: now - 9_000,
  } as AgentJob;
  agentJobs.save(legacyJob);

  const loaded = service.requireById(legacyJob.id);
  assert.deepEqual(loaded.missionAttemptHistory, []);
  assert.equal(loaded.missionWorkflowPath, null);
  assert.equal(loaded.missionRuntimeState, null);

  const recovery = service.recoverSupervisableMissions();
  assert.deepEqual(recovery, {
    recoveredMissionIds: [],
    stoppedMissionIds: [],
  });

  const detail = service.getMissionDetail(legacyJob.id);
  assert.equal(detail?.mission.id, legacyJob.id);
  assert.equal(detail?.mission.title, legacyJob.title);
  assert.equal(detail?.hostBindings.bridgeSessionId, bridgeSession.id);
});

test('AgentJobService createJob seeds a manual source-backed mission while keeping host bindings separate', () => {
  const now = 1_701_099_995_000;
  const bridgeSession: BridgeSession = {
    id: 'session-agent-service-2',
    providerProfileId: 'codex-default',
    codexThreadId: 'thread-agent-service-2',
    cwd: '/repo',
    title: 'Mission session',
    createdAt: now - 1_000,
    updatedAt: now - 500,
  };
  const missionRepository = new InMemoryMissionRepository();
  const service = new AgentJobService({
    agentJobs: new InMemoryAgentJobRepository(),
    missionRepository,
    bridgeSessions: {
      getSessionById(bridgeSessionId: string) {
        return bridgeSessionId === bridgeSession.id ? bridgeSession : null;
      },
    },
    now: () => now,
  });

  const created = service.createJob({
    scopeRef: {
      platform: 'weixin',
      externalScopeId: 'wx-agent-service-2',
    },
    title: 'Seed source-backed mission',
    originalInput: '/agent repair the waiting task',
    goal: 'Repair the waiting task and keep the bridge bindings stable.',
    expectedOutput: 'A verified repair summary.',
    plan: ['Inspect the context', 'Patch the issue', 'Verify the fix'],
    category: 'code',
    riskLevel: 'medium',
    mode: 'codex',
    providerProfileId: 'codex-default',
    bridgeSessionId: bridgeSession.id,
    cwd: '/repo',
    locale: 'zh-CN',
    maxAttempts: 3,
  });

  const detail = service.getMissionDetail(created.id);
  assert.equal(detail?.mission.source, 'manual');
  assert.equal(detail?.mission.status, 'draft');
  assert.equal(detail?.hostBindings.platform, 'weixin');
  assert.equal(detail?.hostBindings.source, 'manual');
  assert.equal(detail?.hostBindings.bridgeSessionId, bridgeSession.id);
  assert.equal(detail?.hostBindings.codexThreadId, bridgeSession.codexThreadId);
  assert.equal(detail?.workflow.status, 'loaded');
  assert.equal(detail?.checklistStatus.currentItem?.title, created.plan[0] ?? null);
  assert.equal(detail?.checklistStatus.totalItems, created.plan.length);
  assert.equal(detail?.workpadStatus.status, 'draft');
  assert.equal(detail?.currentChecklistSnapshot?.sourceRef, created.id);
  assert.deepEqual(detail?.currentChecklistSnapshot?.acceptanceCriteria, created.acceptanceCriteria);
  assert.deepEqual(detail?.currentChecklistSnapshot?.plan, created.plan);
  assert.deepEqual(detail?.workItem?.metadata, {
    category: 'code',
    mode: 'codex',
    originalInput: '/agent repair the waiting task',
  });
  assert.notEqual(detail?.mission.immutablePrompt, null);
  assert.match(detail?.mission.immutablePrompt ?? '', /Mission title: Seed source-backed mission/);
  assert.deepEqual(detail?.mission.loopPolicy, created.loopPolicy);

  const events = missionRepository.listEvents(created.id);
  assert.deepEqual(events.map((event) => event.kind), ['mission.created']);
  assert.equal(events[0]?.metadata.source, 'manual');
});

test('AgentJobService claimSupervisableJobs recovers stale mission authority and returns resumable verifier work', () => {
  const nowRef = { value: 1_701_100_000_000 };
  const bridgeSession: BridgeSession = {
    id: 'session-agent-service-supervision',
    providerProfileId: 'codex-default',
    codexThreadId: 'thread-agent-service-supervision',
    cwd: '/repo',
    title: 'Mission session',
    createdAt: nowRef.value - 1_000,
    updatedAt: nowRef.value - 500,
  };
  const missionRepository = new InMemoryMissionRepository();
  const service = new AgentJobService({
    agentJobs: new InMemoryAgentJobRepository(),
    missionRepository,
    bridgeSessions: {
      getSessionById(bridgeSessionId: string) {
        return bridgeSessionId === bridgeSession.id ? bridgeSession : null;
      },
    },
    now: () => nowRef.value,
  });

  const staleJob = service.createJob({
    scopeRef: {
      platform: 'weixin',
      externalScopeId: 'wx-agent-service-stale',
    },
    title: 'Recover stale queued work',
    originalInput: '/agent recover stale mission',
    goal: 'Resume the stale mission from authoritative state.',
    expectedOutput: 'A recovered mission summary.',
    plan: ['Recover stale state'],
    category: 'code',
    riskLevel: 'medium',
    mode: 'codex',
    providerProfileId: 'codex-default',
    bridgeSessionId: bridgeSession.id,
    cwd: '/repo',
    locale: 'zh-CN',
    maxAttempts: 2,
  });
  nowRef.value += 10;
  const verifyingJob = service.createJob({
    scopeRef: {
      platform: 'weixin',
      externalScopeId: 'wx-agent-service-verifying',
    },
    title: 'Resume verifier work',
    originalInput: '/agent resume verifier',
    goal: 'Continue verification from authoritative state.',
    expectedOutput: 'A verified repair summary.',
    plan: ['Resume verifier state'],
    category: 'code',
    riskLevel: 'medium',
    mode: 'codex',
    providerProfileId: 'codex-default',
    bridgeSessionId: bridgeSession.id,
    cwd: '/repo',
    locale: 'zh-CN',
    maxAttempts: 2,
  });

  const staleQueued = missionRepository.getMissionById(staleJob.id);
  assert.ok(staleQueued);
  const staleReady = transitionMission(staleQueued, 'queued', {
    at: nowRef.value + 35,
    reason: 'Checklist and immutable prompt were confirmed.',
  });
  const staleRunning = transitionMission(staleReady, 'running', {
    at: nowRef.value + 40,
    activeAttemptId: 'attempt-agent-service-stale',
    reason: 'Mission was interrupted mid-run.',
  });
  staleRunning.lease = {
    ownerId: 'worker-stale',
    acquiredAt: nowRef.value + 20,
    heartbeatAt: nowRef.value + 30,
    expiresAt: nowRef.value + 39,
    releasedAt: null,
  };
  missionRepository.saveMission(staleRunning);

  const verifyingQueued = missionRepository.getMissionById(verifyingJob.id);
  assert.ok(verifyingQueued);
  const verifyingReady = transitionMission(verifyingQueued, 'queued', {
    at: nowRef.value + 45,
    reason: 'Checklist and immutable prompt were confirmed.',
  });
  const verifyingRunning = transitionMission(verifyingReady, 'running', {
    at: nowRef.value + 50,
    activeAttemptId: 'attempt-agent-service-verifying',
    reason: 'Provider produced a candidate patch.',
    lastResultPreview: 'Candidate patch is ready for verification.',
  });
  const verifyingMission = transitionMission(verifyingRunning, 'verifying', {
    at: nowRef.value + 60,
    activeAttemptId: 'attempt-agent-service-verifying',
    reason: 'Verifier should resume from persisted state.',
    lastResultPreview: 'Candidate patch is ready for verification.',
  });
  verifyingMission.lease = {
    ownerId: 'worker-verifying',
    acquiredAt: nowRef.value + 40,
    heartbeatAt: nowRef.value + 50,
    expiresAt: nowRef.value + 59,
    releasedAt: null,
  };
  missionRepository.saveMission(verifyingMission);
  missionRepository.saveAttempt({
    id: 'attempt-agent-service-verifying',
    missionId: verifyingMission.id,
    generationId: verifyingMission.activeGenerationId,
    generationIndex: verifyingMission.activeGenerationIndex,
    checklistSnapshotId: verifyingMission.currentChecklistSnapshotId,
    index: 1,
    status: 'verifying',
    providerRunId: 'run-agent-service-verifying',
    providerThreadId: bridgeSession.codexThreadId,
    workflowPath: verifyingMission.workflowPath,
    workflowHash: verifyingMission.workflowHash,
    resolverReason: verifyingMission.workflowResolverReason,
    promptDigest: 'digest-agent-service-verifying',
    verifierVerdict: null,
    verifierSummary: 'Verifier work should resume from authoritative state.',
    missingAcceptanceCriteria: [],
    outputPreview: 'Candidate patch is ready for verification.',
    error: null,
    startedAt: nowRef.value + 50,
    endedAt: null,
    createdAt: nowRef.value + 50,
    updatedAt: nowRef.value + 60,
  });

  nowRef.value += 100;

  const recovery = service.recoverSupervisableMissions();
  const claimed = service.claimSupervisableJobs('weixin', 10);

  assert.deepEqual(recovery.recoveredMissionIds, [staleJob.id, verifyingJob.id]);
  assert.deepEqual(recovery.stoppedMissionIds, []);
  assert.deepEqual(claimed.map((job) => job.id), [staleJob.id, verifyingJob.id]);
  assert.equal(missionRepository.getMissionById(staleJob.id)?.status, 'queued');
  assert.equal(missionRepository.getMissionById(verifyingJob.id)?.status, 'verifying');
  assert.equal(service.requireById(staleJob.id).status, 'queued');
  assert.equal(service.requireById(verifyingJob.id).status, 'verifying');
  assert.equal(service.requireById(verifyingJob.id).running, true);
});

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
    workflowPath: waiting.workflowPath,
    workflowHash: waiting.workflowHash,
    resolverReason: waiting.workflowResolverReason,
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
  assert.equal(runtimeState.events.length, 2);
  assert.equal(runtimeState.events[1]?.kind, 'mission.queued');
  assert.equal(runtimeState.attempts[0]?.status, 'waiting_user');
});

test('AgentJobService retryJob preserves prior runtime history for fresh reruns via a new mission generation', () => {
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
    workflowPath: mission.workflowPath,
    workflowHash: mission.workflowHash,
    resolverReason: mission.workflowResolverReason,
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
  assert.equal(retried.missionAttemptHistory.length, 1);
  assert.equal(retried.missionAttemptHistory[0]?.status, 'completed');
  assert.equal(runtimeState.mission?.status, 'queued');
  assert.equal(runtimeState.mission?.attemptCount, 0);
  assert.equal(runtimeState.mission?.codexThreadId, 'thread-after-retry');
  assert.equal(runtimeState.mission?.activeGenerationIndex, 2);
  assert.equal(runtimeState.generations.length, 2);
  assert.equal(runtimeState.attempts.length, 1);
  assert.equal(runtimeState.events.length, 2);
  assert.equal(runtimeState.events[1]?.kind, 'mission.retrying');
});
