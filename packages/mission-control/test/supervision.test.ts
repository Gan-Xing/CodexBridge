import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  InMemoryMissionRepository,
  JsonFileMissionRepository,
  MissionLeaseCoordinator,
  MissionRuntime,
  MissionSupervisor,
  MissionWorkspaceService,
  createMission,
  createMissionStopRequest,
  createMissionSupervisionSnapshot,
  createMissionVerifierResult,
  transitionMission,
} from '../src/index.js';
import type {
  Mission,
  MissionAttempt,
  MissionProvider,
  MissionProviderResult,
  MissionVerifier,
} from '../src/index.js';

function writeWorkflow(cwd: string, frontMatter = ''): string {
  const workflowPath = path.join(cwd, '.codexbridge', 'mission', 'WORKFLOW.md');
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  const text = frontMatter.trim().length > 0
    ? `---\n${frontMatter.trim()}\n---\nExecute the mission carefully and verify the result.\n`
    : 'Execute the mission carefully and verify the result.\n';
  fs.writeFileSync(workflowPath, text, 'utf8');
  return workflowPath;
}

function createQueuedMission(params: {
  id: string;
  cwd: string;
  acceptanceCriteria?: string[];
  now: number;
}): Mission {
  return transitionMission(createMission({
    id: params.id,
    source: 'manual',
    sourceRef: `manual:${params.id}`,
    platform: 'weixin',
    externalScopeId: `${params.id}-scope`,
    title: `Mission ${params.id}`,
    goal: 'Repair the bug and prove the fix.',
    expectedOutput: 'A verified mission result.',
    acceptanceCriteria: params.acceptanceCriteria ?? ['Patch exists'],
    plan: ['Inspect the issue', 'Patch the code', 'Verify the fix'],
    providerProfileId: 'codex-default',
    cwd: params.cwd,
    maxAttempts: 3,
    maxTurns: 4,
    now: params.now,
  }), 'queued', {
    at: params.now + 10,
  });
}

function createRuntimeHarness(input: {
  repository: JsonFileMissionRepository;
  provider: MissionProvider;
  verifier: MissionVerifier;
  rootDir: string;
  nowRef: { value: number };
  ids?: string[];
}) {
  const ids = [...(input.ids ?? [])];
  const leaseCoordinator = new MissionLeaseCoordinator(input.repository, {
    defaultTtlMs: 60_000,
    maxConcurrentMissions: 1,
    now: () => input.nowRef.value,
  });
  return {
    runtime: new MissionRuntime({
      repository: input.repository,
      provider: input.provider,
      verifier: input.verifier,
      workspaceService: new MissionWorkspaceService({
        rootDir: input.rootDir,
        host: 'supervision-test-host',
        now: () => input.nowRef.value,
      }),
      leaseCoordinator,
      now: () => input.nowRef.value,
      generateId: () => ids.shift() ?? `generated-${Math.random().toString(16).slice(2)}`,
    }),
    leaseCoordinator,
  };
}

test('mission supervisor exposes recovery/listing without a runtime and rejects dispatch until one is supplied', async () => {
  const now = 1_701_800_000_000;
  const repository = new InMemoryMissionRepository();
  const mission = createQueuedMission({
    id: 'mission-supervision-readonly',
    cwd: '/repo',
    now,
  });
  repository.saveMission(mission);

  const supervisor = new MissionSupervisor({
    repository,
    now: () => now,
  });

  assert.deepEqual(supervisor.listSupervisableMissionIds({ now }), [mission.id]);
  assert.equal(supervisor.createSnapshot(mission.id)?.status, 'queued');
  await assert.rejects(
    supervisor.runUntilIdle({ ownerId: 'supervisor-readonly' }),
    /requires a MissionRuntime to dispatch missions/,
  );
});

test('mission supervisor recovers stale leases, resumes verifier state, and runs missions until idle', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-supervision-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-supervision-state-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-supervision-root-'));
  writeWorkflow(cwd, `
version: 1
maxTurns: 4
maxAttempts: 3
continuation: allow
`);
  const repo = new JsonFileMissionRepository(stateDir);
  const nowRef = { value: 1_701_000_000_000 };

  const recoveredMission = transitionMission(createQueuedMission({
    id: 'mission-supervision-recovered',
    cwd,
    now: nowRef.value,
  }), 'running', {
    at: nowRef.value + 20,
    activeAttemptId: 'attempt-supervision-stale',
  });
  repo.saveMission({
    ...recoveredMission,
    lease: {
      ownerId: 'stale-worker',
      acquiredAt: nowRef.value - 2_000,
      heartbeatAt: nowRef.value - 2_000,
      expiresAt: nowRef.value - 500,
      releasedAt: null,
    },
  });
  repo.saveAttempt({
    id: 'attempt-supervision-stale',
    missionId: recoveredMission.id,
    generationId: recoveredMission.activeGenerationId,
    generationIndex: recoveredMission.activeGenerationIndex,
    checklistSnapshotId: recoveredMission.currentChecklistSnapshotId,
    index: 1,
    status: 'running',
    providerRunId: 'run-supervision-stale',
    providerThreadId: 'thread-supervision-stale',
    workflowPath: recoveredMission.workflowPath,
    workflowHash: recoveredMission.workflowHash,
    resolverReason: recoveredMission.workflowResolverReason,
    promptDigest: 'digest-supervision-stale',
    verifierVerdict: null,
    verifierSummary: null,
    missingAcceptanceCriteria: [],
    outputPreview: 'Partial repair output.',
    error: null,
    startedAt: nowRef.value - 1_900,
    endedAt: null,
    createdAt: nowRef.value - 1_900,
    updatedAt: nowRef.value - 1_900,
  });

  const verifyingQueuedMission = createQueuedMission({
    id: 'mission-supervision-verifying',
    cwd,
    now: nowRef.value + 100,
    acceptanceCriteria: ['Tests prove the fix'],
  });
  const verifyingRunningMission = transitionMission(verifyingQueuedMission, 'running', {
    at: nowRef.value + 140,
    activeAttemptId: 'attempt-supervision-verifying',
  });
  const verifyingMission = transitionMission(verifyingRunningMission, 'verifying', {
    at: nowRef.value + 150,
    activeAttemptId: 'attempt-supervision-verifying',
    lastResultPreview: 'Patched the code and reran the tests.',
  });
  repo.saveMission({
    ...verifyingMission,
    lease: {
      ownerId: 'stale-verifier',
      acquiredAt: nowRef.value - 1_000,
      heartbeatAt: nowRef.value - 1_000,
      expiresAt: nowRef.value - 1,
      releasedAt: null,
    },
  });
  repo.saveAttempt({
    id: 'attempt-supervision-verifying',
    missionId: verifyingMission.id,
    generationId: verifyingMission.activeGenerationId,
    generationIndex: verifyingMission.activeGenerationIndex,
    checklistSnapshotId: verifyingMission.currentChecklistSnapshotId,
    index: 1,
    status: 'verifying',
    providerRunId: 'run-supervision-verifying',
    providerThreadId: 'thread-supervision-verifying',
    workflowPath: verifyingMission.workflowPath,
    workflowHash: verifyingMission.workflowHash,
    resolverReason: verifyingMission.workflowResolverReason,
    promptDigest: 'digest-supervision-verifying',
    verifierVerdict: null,
    verifierSummary: null,
    missingAcceptanceCriteria: [],
    outputPreview: 'Patched the code and reran the tests.',
    error: null,
    startedAt: nowRef.value - 900,
    endedAt: null,
    createdAt: nowRef.value - 900,
    updatedAt: nowRef.value - 900,
  });

  const providerStarts: string[] = [];
  const provider: MissionProvider = {
    kind: 'fake-provider',
    async start(input) {
      providerStarts.push(input.mission.id);
      return {
        providerRunId: `run-${input.mission.id}-${providerStarts.length}`,
        providerThreadId: `thread-${input.mission.id}`,
      };
    },
    async continue() {
      throw new Error('supervision test should not continue provider turns');
    },
    async wait(runId) {
      nowRef.value += 100;
      const text = runId.includes('mission-supervision-recovered')
        ? 'Patched the issue and verified the result.'
        : 'Unexpected provider wait.';
      const result: MissionProviderResult = {
        outcome: 'completed',
        text,
        artifacts: [],
        previewText: text,
        errorMessage: null,
        requiresHuman: false,
        handoffState: null,
        continuationEligible: true,
        stopReason: null,
        rawState: 'complete',
      };
      return result;
    },
    async interrupt() {},
  };

  let verifierCalls = 0;
  const verifier: MissionVerifier = {
    async verify(input) {
      verifierCalls += 1;
      nowRef.value += 20;
      return createMissionVerifierResult({
        verdict: 'complete',
        summary: `Verified ${input.mission.id}.`,
      });
    },
  };

  const harness = createRuntimeHarness({
    repository: repo,
    provider,
    verifier,
    rootDir,
    nowRef,
    ids: [
      'event-lease-recovered-1',
      'event-lease-recovered-2',
      'attempt-supervision-recovered-2',
      'event-runtime-supervision-1',
      'event-runtime-supervision-2',
      'event-runtime-supervision-3',
      'event-runtime-supervision-4',
      'event-runtime-supervision-5',
      'event-runtime-supervision-6',
    ],
  });
  const supervisor = new MissionSupervisor({
    repository: repo,
    runtime: harness.runtime,
    leaseCoordinator: harness.leaseCoordinator,
    now: () => nowRef.value,
  });

  const report = await supervisor.runUntilIdle({
    ownerId: 'supervisor-worker',
    readOnly: true,
    allowSharedCwd: true,
  });

  assert.equal(report.stopReason, 'idle');
  assert.deepEqual(report.recoveredMissionIds.sort(), [
    'mission-supervision-recovered',
    'mission-supervision-verifying',
  ]);
  assert.equal(report.cycles.length, 2);
  assert.equal(report.remainingMissionIds.length, 0);
  assert.equal(verifierCalls, 6);
  assert.deepEqual(providerStarts, [
    'mission-supervision-recovered',
    'mission-supervision-recovered',
    'mission-supervision-recovered',
    'mission-supervision-verifying',
    'mission-supervision-verifying',
  ]);

  const recoveredAfter = repo.getMissionById(recoveredMission.id);
  const verifyingAfter = repo.getMissionById(verifyingMission.id);
  assert.equal(recoveredAfter?.status, 'completed');
  assert.equal(recoveredAfter?.lease, null);
  assert.equal(verifyingAfter?.status, 'completed');
  assert.equal(verifyingAfter?.lease, null);

  const verifyingSnapshot = supervisor.createSnapshot(verifyingMission.id);
  assert.equal(verifyingSnapshot?.latestCycleResult?.status, 'done');
  assert.equal(verifyingSnapshot?.supervisable, false);
  assert.equal(verifyingSnapshot?.resumable, false);
});

test('mission supervisor respects maxCycles and leaves remaining missions discoverable through repository-backed snapshots', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-supervision-bounded-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-supervision-bounded-state-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-supervision-bounded-root-'));
  writeWorkflow(cwd, `
version: 1
maxTurns: 4
maxAttempts: 3
continuation: allow
`);
  const repo = new JsonFileMissionRepository(stateDir);
  const nowRef = { value: 1_701_000_100_000 };

  const missionA = createQueuedMission({
    id: 'mission-supervision-bounded-a',
    cwd,
    now: nowRef.value,
  });
  const missionB = createQueuedMission({
    id: 'mission-supervision-bounded-b',
    cwd,
    now: nowRef.value + 50,
  });
  repo.saveMission(missionA);
  repo.saveMission(missionB);

  const prompts: string[] = [];
  const provider: MissionProvider = {
    kind: 'fake-provider',
    async start(input) {
      prompts.push(input.promptText);
      return {
        providerRunId: `run-bounded-${prompts.length}`,
        providerThreadId: 'thread-bounded',
      };
    },
    async continue() {
      throw new Error('bounded supervision test should not continue provider turns');
    },
    async wait(runId) {
      nowRef.value += 100;
      return {
        outcome: 'completed',
        text: `Completed ${runId}.`,
        artifacts: [],
        previewText: `Completed ${runId}.`,
        errorMessage: null,
        requiresHuman: false,
        handoffState: null,
        continuationEligible: true,
        stopReason: null,
        rawState: 'complete',
      };
    },
    async interrupt() {},
  };

  let verifierCalls = 0;
  const verifier: MissionVerifier = {
    async verify() {
      verifierCalls += 1;
      nowRef.value += 20;
      return createMissionVerifierResult({
        verdict: 'complete',
        summary: 'All acceptance criteria passed.',
      });
    },
  };

  const harness = createRuntimeHarness({
    repository: repo,
    provider,
    verifier,
    rootDir,
    nowRef,
    ids: [
      'attempt-bounded-1',
      'event-bounded-1',
      'event-bounded-2',
      'event-bounded-3',
      'event-bounded-4',
      'attempt-bounded-2',
      'event-bounded-5',
      'event-bounded-6',
      'event-bounded-7',
      'event-bounded-8',
    ],
  });
  const supervisor = new MissionSupervisor({
    repository: repo,
    runtime: harness.runtime,
    leaseCoordinator: harness.leaseCoordinator,
    now: () => nowRef.value,
  });

  const firstReport = await supervisor.runUntilIdle({
    ownerId: 'supervisor-bounded',
    readOnly: true,
    allowSharedCwd: true,
    maxCycles: 1,
  });
  assert.equal(firstReport.stopReason, 'max_cycles_reached');
  assert.equal(firstReport.cycles.length, 1);
  assert.deepEqual(firstReport.remainingMissionIds, [missionB.id]);
  assert.equal(repo.getMissionById(missionA.id)?.status, 'completed');

  const checkpoint = createMissionSupervisionSnapshot(
    repo,
    repo.getMissionById(missionB.id)!,
    nowRef.value,
  );
  assert.equal(checkpoint.status, 'queued');
  assert.equal(checkpoint.latestCycleResult, null);
  assert.equal(checkpoint.supervisable, true);

  const secondReport = await supervisor.runUntilIdle({
    ownerId: 'supervisor-bounded',
    readOnly: true,
    allowSharedCwd: true,
    maxCycles: 2,
  });
  assert.equal(secondReport.stopReason, 'idle');
  assert.equal(secondReport.cycles.length, 1);
  assert.equal(repo.getMissionById(missionB.id)?.status, 'completed');
  assert.equal(verifierCalls, 6);
});

test('mission supervisor materializes persisted stop requests before dispatching more work', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-supervision-stop-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-supervision-stop-state-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-supervision-stop-root-'));
  writeWorkflow(cwd, `
version: 1
maxTurns: 4
maxAttempts: 3
continuation: allow
`);
  const repo = new JsonFileMissionRepository(stateDir);
  const nowRef = { value: 1_701_000_200_000 };

  const queuedMission = createMissionStopRequest(createQueuedMission({
    id: 'mission-supervision-stop-queued',
    cwd,
    now: nowRef.value,
  }), {
    at: nowRef.value + 20,
    actorType: 'host',
    reason: 'Stop the queued mission before it starts.',
  });
  repo.saveMission(queuedMission);

  const runningBase = transitionMission(createQueuedMission({
    id: 'mission-supervision-stop-running',
    cwd,
    now: nowRef.value + 100,
  }), 'running', {
    at: nowRef.value + 140,
    activeAttemptId: 'attempt-supervision-stop-running-1',
  });
  const runningMission = createMissionStopRequest({
    ...runningBase,
    lease: {
      ownerId: 'stale-stop-worker',
      acquiredAt: nowRef.value - 1_000,
      heartbeatAt: nowRef.value - 1_000,
      expiresAt: nowRef.value - 1,
      releasedAt: null,
    },
  }, {
    at: nowRef.value + 150,
    actorType: 'host',
    reason: 'Stop the stale running mission after recovery.',
  });
  repo.saveMission(runningMission);
  repo.saveAttempt({
    id: 'attempt-supervision-stop-running-1',
    missionId: runningMission.id,
    generationId: runningMission.activeGenerationId,
    generationIndex: runningMission.activeGenerationIndex,
    checklistSnapshotId: runningMission.currentChecklistSnapshotId,
    index: 1,
    status: 'running',
    providerRunId: 'run-supervision-stop-running-1',
    providerThreadId: 'thread-supervision-stop-running-1',
    workflowPath: runningMission.workflowPath,
    workflowHash: runningMission.workflowHash,
    resolverReason: runningMission.workflowResolverReason,
    promptDigest: 'digest-supervision-stop-running-1',
    verifierVerdict: null,
    verifierSummary: null,
    missingAcceptanceCriteria: [],
    outputPreview: 'Partial progress before stop.',
    error: null,
    startedAt: nowRef.value - 900,
    endedAt: null,
    createdAt: nowRef.value - 900,
    updatedAt: nowRef.value - 900,
  });

  let providerStarts = 0;
  const provider: MissionProvider = {
    kind: 'fake-provider',
    async start() {
      providerStarts += 1;
      return {
        providerRunId: `run-supervision-stop-${providerStarts}`,
        providerThreadId: 'thread-supervision-stop',
      };
    },
    async continue() {
      throw new Error('stop-request supervision test should not continue provider turns');
    },
    async wait() {
      throw new Error('stop-request supervision test should not wait on provider turns');
    },
    async interrupt() {},
  };

  const verifier: MissionVerifier = {
    async verify() {
      throw new Error('stop-request supervision test should not invoke the verifier');
    },
  };

  const harness = createRuntimeHarness({
    repository: repo,
    provider,
    verifier,
    rootDir,
    nowRef,
  });
  const supervisor = new MissionSupervisor({
    repository: repo,
    runtime: harness.runtime,
    leaseCoordinator: harness.leaseCoordinator,
    now: () => nowRef.value,
  });

  const report = await supervisor.runUntilIdle({
    ownerId: 'supervisor-stop',
    readOnly: true,
    allowSharedCwd: true,
  });

  assert.equal(report.stopReason, 'idle');
  assert.equal(report.cycles.length, 0);
  assert.equal(providerStarts, 0);
  assert.deepEqual(report.stoppedMissionIds.sort(), [
    queuedMission.id,
    runningMission.id,
  ]);
  assert.equal(repo.getMissionById(queuedMission.id)?.status, 'stopped');
  assert.equal(repo.getMissionById(runningMission.id)?.status, 'stopped');
  assert.equal(repo.getAttemptById('attempt-supervision-stop-running-1')?.status, 'stopped');
});
