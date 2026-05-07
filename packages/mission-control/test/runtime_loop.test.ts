import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  JsonFileMissionRepository,
  MissionLeaseCoordinator,
  MissionRuntime,
  MissionWorkspaceService,
  createMission,
  createMissionVerifierResult,
  transitionMission,
} from '../src/index.js';
import type {
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
  maxAttempts?: number;
  maxTurns?: number;
  now: number;
}) {
  return transitionMission(createMission({
    id: params.id,
    source: 'weixin',
    platform: 'weixin',
    externalScopeId: `${params.id}-scope`,
    title: `Mission ${params.id}`,
    goal: 'Repair the bug and prove the fix.',
    expectedOutput: 'A verified mission result.',
    acceptanceCriteria: ['Patch exists', 'Tests prove the fix'],
    providerProfileId: 'codex-default',
    cwd: params.cwd,
    maxAttempts: params.maxAttempts ?? 2,
    maxTurns: params.maxTurns ?? 4,
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
  return new MissionRuntime({
    repository: input.repository,
    provider: input.provider,
    verifier: input.verifier,
    workspaceService: new MissionWorkspaceService({
      rootDir: input.rootDir,
      host: 'runtime-test-host',
      now: () => input.nowRef.value,
    }),
    leaseCoordinator: new MissionLeaseCoordinator(input.repository, {
      defaultTtlMs: 60_000,
      maxConcurrentMissions: 1,
      now: () => input.nowRef.value,
    }),
    now: () => input.nowRef.value,
    generateId: () => ids.shift() ?? `generated-${Math.random().toString(16).slice(2)}`,
  });
}

test('mission runtime keeps verifier repair loops bounded and only completes after acceptance criteria pass', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-repair-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-repair-state-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-repair-root-'));
  writeWorkflow(cwd, `
version: 1
maxTurns: 4
maxAttempts: 3
continuation: allow
`);
  const repo = new JsonFileMissionRepository(stateDir);
  const nowRef = { value: 1_700_800_000_000 };
  const prompts: string[] = [];

  const waitResults = new Map<string, MissionProviderResult>([
    ['run-repair-1', {
      outcome: 'completed',
      text: 'Patched the preview path.',
      artifacts: [],
      previewText: 'Patched the preview path.',
      errorMessage: null,
      requiresHuman: false,
      handoffState: null,
      continuationEligible: true,
      stopReason: null,
      rawState: 'complete',
    }],
    ['run-repair-2', {
      outcome: 'completed',
      text: 'Patched the preview path and reran the failing tests.',
      artifacts: [],
      previewText: 'Patched the preview path and reran the failing tests.',
      errorMessage: null,
      requiresHuman: false,
      handoffState: null,
      continuationEligible: true,
      stopReason: null,
      rawState: 'complete',
    }],
  ]);
  const provider: MissionProvider = {
    kind: 'fake-provider',
    async start(input) {
      prompts.push(input.promptText);
      const runId = `run-repair-${prompts.length}`;
      return {
        providerRunId: runId,
        providerThreadId: 'thread-runtime-repair',
      };
    },
    async continue() {
      throw new Error('continuation should not run in the repair-loop test');
    },
    async wait(runId) {
      nowRef.value += 100;
      const result = waitResults.get(runId);
      assert.ok(result, `missing wait result for ${runId}`);
      return result;
    },
    async interrupt() {},
  };

  let verifierCalls = 0;
  const verifier: MissionVerifier = {
    async verify(input) {
      verifierCalls += 1;
      nowRef.value += 50;
      if (verifierCalls === 1) {
        assert.equal(input.attemptCount, 1);
        return createMissionVerifierResult({
          verdict: 'repair',
          summary: 'The patch exists, but test evidence is still missing.',
          missingAcceptanceCriteria: ['Tests prove the fix'],
        });
      }
      assert.equal(input.attemptCount, 2);
      return createMissionVerifierResult({
        verdict: 'complete',
        summary: 'Acceptance criteria satisfied with test evidence.',
      });
    },
  };

  const mission = createQueuedMission({
    id: 'mission-runtime-repair',
    cwd,
    maxAttempts: 3,
    maxTurns: 4,
    now: nowRef.value,
  });
  repo.saveMission(mission);

  const runtime = createRuntimeHarness({
    repository: repo,
    provider,
    verifier,
    rootDir,
    nowRef,
    ids: ['attempt-runtime-repair-1', 'attempt-runtime-repair-2'],
  });
  const result = await runtime.runMission(mission.id, {
    ownerId: 'worker-runtime-repair',
  });

  assert.equal(result.mission.status, 'completed');
  assert.equal(result.mission.resultText, 'Patched the preview path and reran the failing tests.');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? '', /Verifier repair contract/);
  assert.match(prompts[1] ?? '', /Tests prove the fix/);

  const attempts = repo.listAttempts(mission.id).sort((left, right) => left.index - right.index);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.verifierVerdict, 'repair');
  assert.equal(attempts[0]?.status, 'repairing');
  assert.equal(attempts[1]?.verifierVerdict, 'complete');
  assert.equal(attempts[1]?.status, 'completed');

  const eventKinds = repo.listEvents(mission.id).map((event) => event.kind);
  assert.ok(eventKinds.includes('mission.retrying'));
  assert.ok(eventKinds.includes('mission.completed'));
});

test('mission runtime continues the same attempt after a normal partial exit and counts provider turns separately from attempts', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-continue-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-continue-state-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-continue-root-'));
  writeWorkflow(cwd, `
version: 1
maxTurns: 3
maxAttempts: 2
continuation: allow
`);
  const repo = new JsonFileMissionRepository(stateDir);
  const nowRef = { value: 1_700_810_000_000 };
  const prompts: Array<{ mode: 'start' | 'continue'; text: string }> = [];
  const waitOrder: string[] = [];

  const provider: MissionProvider = {
    kind: 'fake-provider',
    async start(input) {
      prompts.push({ mode: 'start', text: input.promptText });
      return {
        providerRunId: 'run-continue-1',
        providerThreadId: 'thread-runtime-continue',
      };
    },
    async continue(input) {
      prompts.push({ mode: 'continue', text: input.promptText });
      return {
        providerRunId: 'run-continue-2',
        providerThreadId: 'thread-runtime-continue',
      };
    },
    async wait(runId) {
      nowRef.value += 100;
      waitOrder.push(runId);
      if (runId === 'run-continue-1') {
        return {
          outcome: 'partial',
          text: 'Collected logs, but the final summary is not ready yet.',
          artifacts: [],
          previewText: 'Collected logs only.',
          errorMessage: null,
          requiresHuman: false,
          handoffState: null,
          continuationEligible: true,
          stopReason: null,
          rawState: 'partial',
        };
      }
      return {
        outcome: 'completed',
        text: 'Patched the preview flow and reran the regression tests.',
        artifacts: [],
        previewText: 'Patched the preview flow and reran the regression tests.',
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

  const verifier: MissionVerifier = {
    async verify(input) {
      nowRef.value += 50;
      assert.equal(input.attempt.index, 1);
      assert.equal(input.attemptCount, 1);
      assert.equal(input.turnCount, 2);
      return createMissionVerifierResult({
        verdict: 'complete',
        summary: 'Acceptance criteria satisfied after the continuation turn.',
      });
    },
  };

  const mission = createQueuedMission({
    id: 'mission-runtime-continue',
    cwd,
    maxAttempts: 2,
    maxTurns: 3,
    now: nowRef.value,
  });
  repo.saveMission(mission);

  const runtime = createRuntimeHarness({
    repository: repo,
    provider,
    verifier,
    rootDir,
    nowRef,
    ids: ['attempt-runtime-continue-1'],
  });
  const result = await runtime.runMission(mission.id, {
    ownerId: 'worker-runtime-continue',
  });

  assert.equal(result.mission.status, 'completed');
  assert.equal(result.mission.attemptCount, 1);
  assert.equal(result.turnsUsed, 2);
  assert.deepEqual(waitOrder, ['run-continue-1', 'run-continue-2']);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0]?.mode, 'start');
  assert.equal(prompts[1]?.mode, 'continue');
  assert.match(prompts[1]?.text ?? '', /Continuation contract/);

  const events = repo.listEvents(mission.id);
  const turnEvents = events.filter((event) => event.kind === 'attempt.started');
  assert.equal(turnEvents.length, 2);
  assert.equal(turnEvents.every((event) => event.metadata.providerTurn === true), true);
});

test('mission runtime converts verifier repair verdicts into budget-exhausted failure when no retry budget remains', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-budget-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-budget-state-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-budget-root-'));
  writeWorkflow(cwd, `
version: 1
maxTurns: 4
maxAttempts: 4
continuation: allow
`);
  const repo = new JsonFileMissionRepository(stateDir);
  const nowRef = { value: 1_700_820_000_000 };

  let starts = 0;
  const provider: MissionProvider = {
    kind: 'fake-provider',
    async start() {
      starts += 1;
      return {
        providerRunId: `run-budget-${starts}`,
        providerThreadId: 'thread-runtime-budget',
      };
    },
    async continue() {
      throw new Error('continuation should not run in the budget test');
    },
    async wait() {
      nowRef.value += 100;
      return {
        outcome: 'completed',
        text: 'Patched code, but verification still needs more evidence.',
        artifacts: [],
        previewText: 'Patched code, but verification still needs more evidence.',
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

  const verifier: MissionVerifier = {
    async verify() {
      nowRef.value += 50;
      return createMissionVerifierResult({
        verdict: 'repair',
        summary: 'Retry required to collect the missing verification evidence.',
        missingAcceptanceCriteria: ['Tests prove the fix'],
      });
    },
  };

  const mission = createQueuedMission({
    id: 'mission-runtime-budget',
    cwd,
    maxAttempts: 1,
    maxTurns: 4,
    now: nowRef.value,
  });
  repo.saveMission(mission);

  const runtime = createRuntimeHarness({
    repository: repo,
    provider,
    verifier,
    rootDir,
    nowRef,
    ids: ['attempt-runtime-budget-1'],
  });
  const result = await runtime.runMission(mission.id, {
    ownerId: 'worker-runtime-budget',
  });

  assert.equal(result.mission.status, 'failed');
  assert.match(result.mission.statusReason ?? '', /max attempts exhausted/);
  assert.equal(starts, 1);

  const attempts = repo.listAttempts(mission.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.verifierVerdict, 'failed');
  assert.match(attempts[0]?.verifierSummary ?? '', /Mission budget exhausted/);
});

test('mission runtime stopMission interrupts the active provider run and marks the attempt stopped', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-stop-state-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-stop-root-'));
  const repo = new JsonFileMissionRepository(stateDir);
  const nowRef = { value: 1_700_830_000_000 };
  let interruptedRunId: string | null = null;

  const provider: MissionProvider = {
    kind: 'fake-provider',
    async start() {
      throw new Error('start should not be called in stopMission test');
    },
    async continue() {
      throw new Error('continue should not be called in stopMission test');
    },
    async wait() {
      throw new Error('wait should not be called in stopMission test');
    },
    async interrupt(runId) {
      interruptedRunId = runId;
    },
  };

  const verifier: MissionVerifier = {
    async verify() {
      return createMissionVerifierResult({
        verdict: 'complete',
      });
    },
  };

  const baseMission = createQueuedMission({
    id: 'mission-runtime-stop',
    cwd: rootDir,
    now: nowRef.value,
  });
  const runningMission = transitionMission(baseMission, 'running', {
    at: nowRef.value + 20,
    activeAttemptId: 'attempt-runtime-stop-1',
    lease: {
      ownerId: 'worker-runtime-stop',
      acquiredAt: nowRef.value + 20,
      heartbeatAt: nowRef.value + 20,
      expiresAt: nowRef.value + 60_000,
      releasedAt: null,
    },
  });
  const attempt: MissionAttempt = {
    id: 'attempt-runtime-stop-1',
    missionId: runningMission.id,
    index: 1,
    status: 'running',
    providerRunId: 'run-stop-1',
    providerThreadId: 'thread-stop-1',
    promptDigest: 'digest-stop-1',
    verifierVerdict: null,
    verifierSummary: null,
    missingAcceptanceCriteria: [],
    outputPreview: null,
    error: null,
    startedAt: nowRef.value + 20,
    endedAt: null,
    createdAt: nowRef.value + 20,
    updatedAt: nowRef.value + 20,
  };
  repo.saveMission(runningMission);
  repo.saveAttempt(attempt);

  const runtime = createRuntimeHarness({
    repository: repo,
    provider,
    verifier,
    rootDir,
    nowRef,
  });
  const stoppedMission = await runtime.stopMission(runningMission.id, {
    ownerId: 'worker-runtime-stop',
    reason: 'User requested stop.',
  });

  assert.equal(interruptedRunId, 'run-stop-1');
  assert.equal(stoppedMission.status, 'stopped');
  assert.equal(repo.getAttemptById(attempt.id)?.status, 'stopped');
  assert.equal(repo.getAttemptById(attempt.id)?.error, 'User requested stop.');
  const eventKinds = repo.listEvents(runningMission.id).map((event) => event.kind);
  assert.ok(eventKinds.includes('attempt.stopped'));
  assert.ok(eventKinds.includes('mission.stopped'));
});
