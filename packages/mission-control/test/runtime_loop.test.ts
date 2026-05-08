import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  JsonFileMissionRepository,
  MissionLeaseCoordinator,
  MissionRuntime,
  MissionWorkspaceService,
  createNoopMissionHostAdapter,
  createMission,
  createMissionStopRequest,
  createMissionVerifierResult,
  transitionMission,
} from '../src/index.js';
import type {
  MissionHostAdapter,
  MissionHostNotification,
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

function initGitRepo(cwd: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'mission-control@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Mission Control'], { cwd, stdio: 'ignore' });
  fs.writeFileSync(path.join(cwd, 'README.md'), '# runtime test\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
}

function createQueuedMission(params: {
  id: string;
  cwd: string;
  expectedOutput?: string;
  acceptanceCriteria?: string[];
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
    expectedOutput: params.expectedOutput ?? 'A verified mission result.',
    acceptanceCriteria: params.acceptanceCriteria ?? ['Patch exists', 'Tests prove the fix'],
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
  hostAdapter?: MissionHostAdapter | null;
}) {
  const ids = [...(input.ids ?? [])];
  return new MissionRuntime({
    repository: input.repository,
    provider: input.provider,
    verifier: input.verifier,
    hostAdapter: input.hostAdapter ?? null,
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
  initGitRepo(cwd);
  const workflowPath = writeWorkflow(cwd, `
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
        assert.equal(input.activeChecklistItem?.title, 'Tests prove the fix');
        return createMissionVerifierResult({
          verdict: 'repair',
          summary: 'The patch exists, but test evidence is still missing.',
          missingAcceptanceCriteria: ['Tests prove the fix'],
        });
      }
      assert.equal(input.attemptCount, 2);
      assert.equal(input.activeChecklistItem?.title, 'Tests prove the fix');
      return createMissionVerifierResult({
        verdict: 'complete',
        summary: 'Acceptance criteria satisfied with test evidence.',
      });
    },
  };

  const mission = createQueuedMission({
    id: 'mission-runtime-repair',
    cwd,
    acceptanceCriteria: ['Tests prove the fix'],
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
  assert.deepEqual(result.cycleResults.map((cycle) => cycle.status), ['retry', 'done']);
  assert.equal(result.latestCycleResult?.status, 'done');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? '', /Verifier repair contract/);
  assert.match(prompts[1] ?? '', /Tests prove the fix/);

  const attempts = repo.listAttempts(mission.id).sort((left, right) => left.index - right.index);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.verifierVerdict, 'repair');
  assert.equal(attempts[0]?.status, 'repairing');
  assert.equal(attempts[1]?.verifierVerdict, 'complete');
  assert.equal(attempts[1]?.status, 'completed');
  assert.equal(attempts[0]?.workflowPath, workflowPath);
  assert.equal(attempts[0]?.workflowHash?.length, 64);
  assert.equal(attempts[0]?.resolverReason, 'cwd_default');

  const activeGeneration = repo.getGenerationById(result.mission.activeGenerationId);
  assert.equal(activeGeneration?.workflowPath, workflowPath);
  assert.equal(activeGeneration?.workflowHash?.length, 64);
  assert.equal(activeGeneration?.resolverReason, 'cwd_default');

  const environmentStamps = repo.listEnvironmentStamps(mission.id)
    .slice()
    .sort((left, right) => left.capturedAt - right.capturedAt);
  assert.equal(environmentStamps.length, 2);
  assert.deepEqual(
    environmentStamps.map((stamp) => stamp.attemptId).sort(),
    attempts.map((attempt) => attempt.id).sort(),
  );
  const firstAttemptStamp = environmentStamps.find((stamp) => stamp.attemptId === attempts[0]?.id);
  assert.equal(firstAttemptStamp?.workspacePath, path.join(rootDir, 'workspaces', mission.id));
  assert.equal(firstAttemptStamp?.cwd, cwd);
  assert.equal(firstAttemptStamp?.workflowHash?.length, 64);
  assert.equal(firstAttemptStamp?.providerProfileId, 'codex-default');
  assert.equal(firstAttemptStamp?.gitBranch, 'main');
  assert.equal(firstAttemptStamp?.gitSha?.length, 40);

  const checkpoints = repo.listCheckpoints(mission.id);
  assert.ok(checkpoints.some((checkpoint) => checkpoint.stage === 'attempt.started'));
  assert.ok(checkpoints.some((checkpoint) => checkpoint.stage === 'provider.candidate_ready'));
  assert.ok(checkpoints.some((checkpoint) => checkpoint.stage === 'verifier.repair'));
  assert.ok(checkpoints.some((checkpoint) => checkpoint.stage === 'verifier.complete'));

  const eventKinds = repo.listEvents(mission.id).map((event) => event.kind);
  assert.ok(eventKinds.includes('mission.retrying'));
  assert.ok(eventKinds.includes('mission.completed'));
  const finalChecklistSnapshot = repo.getChecklistSnapshotById(result.mission.currentChecklistSnapshotId);
  assert.equal(finalChecklistSnapshot?.items.every((item) => item.status === 'completed'), true);
});

test('mission runtime pauses in scope_change_pending when the verifier proposes a formal checklist refinement', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-plan-change-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-plan-change-state-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-plan-change-root-'));
  initGitRepo(cwd);
  writeWorkflow(cwd, `
version: 1
maxTurns: 4
maxAttempts: 3
continuation: allow
`);
  const repo = new JsonFileMissionRepository(stateDir);
  const nowRef = { value: 1_700_805_000_000 };

  const provider: MissionProvider = {
    kind: 'fake-provider',
    async start() {
      return {
        providerRunId: 'run-plan-change-1',
        providerThreadId: 'thread-runtime-plan-change',
      };
    },
    async continue() {
      throw new Error('continuation should not run in the plan-change test');
    },
    async wait() {
      nowRef.value += 100;
      return {
        outcome: 'completed',
        text: 'Patched the preview flow, but the confirmed checklist lacks a targeted regression-test step.',
        artifacts: [],
        previewText: 'Patched the preview flow, but the confirmed checklist lacks a targeted regression-test step.',
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
        summary: 'The mission needs a formal regression-test checklist refinement before another repair loop.',
        missingAcceptanceCriteria: ['Tests prove the fix'],
        progressSummary: 'Patched the preview flow and identified that the confirmed checklist is missing a targeted regression-test step.',
        nextStep: 'Review the proposed checklist refinement before retrying.',
        latestBlocker: 'Need approval for a formal checklist refinement before continuing.',
        planChangeSuggestion: {
          rationale: 'Split verification into implementation and targeted regression-test steps.',
          proposedPlan: ['Inspect failure', 'Patch code', 'Add regression test coverage', 'Run targeted verification'],
          proposedAcceptanceCriteria: ['Preview no longer freezes', 'Targeted tests prove the fix'],
        },
      });
    },
  };

  const mission = createQueuedMission({
    id: 'mission-runtime-plan-change',
    cwd,
    acceptanceCriteria: ['Preview no longer freezes', 'Tests prove the fix'],
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
    ids: [
      'attempt-runtime-plan-change-1',
      'request-runtime-plan-change-1',
      'event-runtime-plan-change-1',
      'event-runtime-plan-change-2',
    ],
  });
  const result = await runtime.runMission(mission.id, {
    ownerId: 'worker-runtime-plan-change',
  });
  const requests = repo.listPlanChangeRequests(mission.id);

  assert.equal(result.mission.status, 'scope_change_pending');
  assert.equal(
    result.verifierResult?.planChangeSuggestion?.rationale,
    'Split verification into implementation and targeted regression-test steps.',
  );
  assert.equal(result.latestCycleResult?.status, 'waiting_user');
  assert.equal(result.latestCycleResult?.stage, 'verifier.plan_change');
  assert.equal(
    result.latestCycleResult?.nextStep,
    'Review the proposed checklist refinement before retrying.',
  );
  assert.equal(
    result.latestCycleResult?.blocker,
    'Resolve the proposed checklist scope change before continuing the mission.',
  );
  assert.equal(
    result.latestCycleResult?.planChangeSuggestion?.planChangeRequestId,
    requests[0]?.id,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.status, 'proposed');
  assert.deepEqual(requests[0]?.proposedPlan, [
    'Inspect failure',
    'Patch code',
    'Add regression test coverage',
    'Run targeted verification',
  ]);

  const eventKinds = repo.listEvents(mission.id).map((event) => event.kind);
  assert.ok(eventKinds.includes('mission.scope_change_pending'));
  assert.ok(eventKinds.includes('mission.progress'));

  const checkpoints = repo.listCheckpoints(mission.id);
  assert.ok(checkpoints.some((checkpoint) => checkpoint.stage === 'verifier.plan_change'));
});

test('mission runtime emits package-backed host notifications after authoritative loop cycle updates', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-notify-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-notify-state-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-notify-root-'));
  initGitRepo(cwd);
  writeWorkflow(cwd, `
version: 1
maxTurns: 5
maxAttempts: 4
continuation: allow
`);
  const repo = new JsonFileMissionRepository(stateDir);
  const nowRef = { value: 1_700_810_000_000 };
  const notifications: MissionHostNotification[] = [];

  const waitResults = new Map<string, MissionProviderResult>([
    ['run-notify-1', {
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
    ['run-notify-2', {
      outcome: 'completed',
      text: 'Patched the preview path, but tests still need to run.',
      artifacts: [],
      previewText: 'Patched the preview path, but tests still need to run.',
      errorMessage: null,
      requiresHuman: false,
      handoffState: null,
      continuationEligible: true,
      stopReason: null,
      rawState: 'complete',
    }],
    ['run-notify-3', {
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
  let providerCallCount = 0;
  const provider: MissionProvider = {
    kind: 'fake-provider',
    async start() {
      providerCallCount += 1;
      return {
        providerRunId: `run-notify-${providerCallCount}`,
        providerThreadId: 'thread-runtime-notify',
      };
    },
    async continue() {
      throw new Error('continuation should not run in the notification test');
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
    async verify() {
      verifierCalls += 1;
      nowRef.value += 50;
      if (verifierCalls === 1) {
        return createMissionVerifierResult({
          verdict: 'complete',
          summary: 'Checklist item complete: Patch exists',
        });
      }
      if (verifierCalls === 2) {
        return createMissionVerifierResult({
          verdict: 'repair',
          summary: 'Verification requested another pass before the mission can finish.',
          missingAcceptanceCriteria: ['Tests prove the fix'],
        });
      }
      return createMissionVerifierResult({
        verdict: 'complete',
        summary: 'Acceptance criteria satisfied with test evidence.',
      });
    },
  };

  const mission = createQueuedMission({
    id: 'mission-runtime-notify',
    cwd,
    acceptanceCriteria: ['Patch exists', 'Tests prove the fix'],
    maxAttempts: 4,
    maxTurns: 5,
    now: nowRef.value,
  });
  repo.saveMission(mission);

  const runtime = createRuntimeHarness({
    repository: repo,
    provider,
    verifier,
    rootDir,
    nowRef,
    hostAdapter: createNoopMissionHostAdapter({
      async notify(notification) {
        notifications.push(structuredClone(notification) as MissionHostNotification);
      },
    }),
    ids: [
      'attempt-runtime-notify-1',
      'attempt-runtime-notify-2',
      'attempt-runtime-notify-3',
    ],
  });

  const result = await runtime.runMission(mission.id, {
    ownerId: 'worker-runtime-notify',
  });

  assert.equal(result.mission.status, 'completed');
  assert.deepEqual(
    notifications.map((notification) => notification.cycleResult?.status),
    ['continue', 'retry', 'done'],
  );
  assert.equal(notifications[0]?.status, 'queued');
  assert.equal(notifications[0]?.loopSnapshot?.currentStage, 'verifier.complete');
  assert.equal(notifications[0]?.loopSnapshot?.overallCompletion, 33);
  assert.equal(notifications[0]?.loopSnapshot?.currentItemTitle, 'Tests prove the fix');
  assert.equal(notifications[1]?.status, 'repairing');
  assert.equal(notifications[1]?.loopSnapshot?.currentStage, 'verifier.repair');
  assert.equal(notifications[1]?.loopSnapshot?.currentItemTitle, 'Tests prove the fix');
  assert.equal(notifications[2]?.status, 'completed');
  assert.equal(notifications[2]?.loopSnapshot?.currentStage, 'verifier.complete');
  assert.equal(notifications[2]?.loopSnapshot?.overallCompletion, 100);
});

test('mission runtime advances to the next checklist item when verifier feedback only blocks later acceptance criteria', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-item-advance-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-item-advance-state-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-item-advance-root-'));
  writeWorkflow(cwd, `
version: 1
maxTurns: 4
maxAttempts: 3
continuation: allow
`);
  const repo = new JsonFileMissionRepository(stateDir);
  const nowRef = { value: 1_700_805_000_000 };
  const prompts: string[] = [];

  const provider: MissionProvider = {
    kind: 'fake-provider',
    async start(input) {
      prompts.push(input.promptText);
      return {
        providerRunId: `run-item-advance-${prompts.length}`,
        providerThreadId: 'thread-runtime-item-advance',
      };
    },
    async continue() {
      throw new Error('continuation should not run in the item-advance test');
    },
    async wait(runId) {
      nowRef.value += 100;
      if (runId === 'run-item-advance-1') {
        return {
          outcome: 'completed',
          text: 'Patched the preview flow but still need to rerun tests.',
          artifacts: [],
          previewText: 'Patched the preview flow.',
          errorMessage: null,
          requiresHuman: false,
          handoffState: null,
          continuationEligible: true,
          stopReason: null,
          rawState: 'complete',
        };
      }
      return {
        outcome: 'completed',
        text: 'Reran the failing tests and confirmed the preview fix.',
        artifacts: [],
        previewText: 'Tests reran cleanly.',
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
    async verify(input) {
      verifierCalls += 1;
      nowRef.value += 50;
      if (verifierCalls === 1) {
        assert.equal(input.activeChecklistItem?.title, 'Patch exists');
        return createMissionVerifierResult({
          verdict: 'repair',
          summary: 'Patch exists, but test evidence is still missing.',
          missingAcceptanceCriteria: ['Tests prove the fix'],
        });
      }
      assert.equal(input.activeChecklistItem?.title, 'Tests prove the fix');
      return createMissionVerifierResult({
        verdict: 'complete',
        summary: 'Acceptance criteria satisfied with fresh test evidence.',
      });
    },
  };

  const mission = createQueuedMission({
    id: 'mission-runtime-item-advance',
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
    ids: ['attempt-runtime-item-advance-1', 'attempt-runtime-item-advance-2'],
  });
  const result = await runtime.runMission(mission.id, {
    ownerId: 'worker-runtime-item-advance',
  });

  assert.equal(result.mission.status, 'completed');
  assert.deepEqual(result.cycleResults.map((cycle) => cycle.status), ['continue', 'done']);
  assert.equal(result.latestCycleResult?.status, 'done');
  assert.equal(prompts.length, 2);
  assert.match(prompts[0] ?? '', /Current checklist item: \[acceptance\] Patch exists/);
  assert.match(prompts[1] ?? '', /Current checklist item: \[acceptance\] Tests prove the fix/);
  assert.doesNotMatch(prompts[1] ?? '', /Verifier repair contract/);

  const attempts = repo.listAttempts(mission.id).sort((left, right) => left.index - right.index);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.status, 'completed');
  assert.equal(attempts[0]?.verifierVerdict, 'repair');
  assert.equal(attempts[1]?.status, 'completed');
  assert.equal(attempts[1]?.verifierVerdict, 'complete');

  const finalChecklistSnapshot = repo.getChecklistSnapshotById(result.mission.currentChecklistSnapshotId);
  assert.equal(finalChecklistSnapshot?.items.every((item) => item.status === 'completed'), true);
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
    acceptanceCriteria: ['Patch exists'],
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
  assert.deepEqual(result.cycleResults.map((cycle) => cycle.status), ['continue', 'done']);
  assert.equal(result.latestCycleResult?.status, 'done');
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
  assert.deepEqual(result.cycleResults.map((cycle) => cycle.status), ['failed']);
  assert.equal(result.latestCycleResult?.stage, 'verifier.failed');
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
    workflowPath: runningMission.workflowPath,
    workflowHash: runningMission.workflowHash,
    resolverReason: runningMission.workflowResolverReason,
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

test('mission runtime consumes persisted stop requests before starting another provider turn', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-stop-request-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-stop-request-state-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-stop-request-root-'));
  writeWorkflow(cwd, `
version: 1
maxTurns: 4
maxAttempts: 3
continuation: allow
`);
  const repo = new JsonFileMissionRepository(stateDir);
  const nowRef = { value: 1_700_830_100_000 };
  let providerStarts = 0;

  const provider: MissionProvider = {
    kind: 'fake-provider',
    async start() {
      providerStarts += 1;
      return {
        providerRunId: `run-stop-request-${providerStarts}`,
        providerThreadId: 'thread-stop-request',
      };
    },
    async continue() {
      throw new Error('continue should not be called in stop-request test');
    },
    async wait() {
      throw new Error('wait should not be called in stop-request test');
    },
    async interrupt() {},
  };

  const verifier: MissionVerifier = {
    async verify() {
      throw new Error('verify should not be called in stop-request test');
    },
  };

  const runningMission = createMissionStopRequest(transitionMission(createQueuedMission({
    id: 'mission-runtime-stop-request',
    cwd,
    now: nowRef.value,
  }), 'running', {
    at: nowRef.value + 20,
    activeAttemptId: 'attempt-runtime-stop-request-1',
  }), {
    at: nowRef.value + 25,
    actorType: 'host',
    reason: 'Stop before the next provider turn starts.',
  });
  repo.saveMission(runningMission);
  repo.saveAttempt({
    id: 'attempt-runtime-stop-request-1',
    missionId: runningMission.id,
    generationId: runningMission.activeGenerationId,
    generationIndex: runningMission.activeGenerationIndex,
    checklistSnapshotId: runningMission.currentChecklistSnapshotId,
    index: 1,
    status: 'running',
    providerRunId: null,
    providerThreadId: null,
    workflowPath: runningMission.workflowPath,
    workflowHash: runningMission.workflowHash,
    resolverReason: runningMission.workflowResolverReason,
    promptDigest: null,
    verifierVerdict: null,
    verifierSummary: null,
    missingAcceptanceCriteria: [],
    outputPreview: null,
    error: null,
    startedAt: null,
    endedAt: null,
    createdAt: nowRef.value + 20,
    updatedAt: nowRef.value + 20,
  });

  const runtime = createRuntimeHarness({
    repository: repo,
    provider,
    verifier,
    rootDir,
    nowRef,
  });
  const result = await runtime.runMission(runningMission.id, {
    ownerId: 'worker-runtime-stop-request',
    readOnly: true,
    allowSharedCwd: true,
  });

  assert.equal(providerStarts, 0);
  assert.equal(result.mission.status, 'stopped');
  assert.equal(result.mission.stopRequest, null);
  assert.equal(repo.getAttemptById('attempt-runtime-stop-request-1')?.status, 'stopped');
  assert.deepEqual(
    repo.listEvents(runningMission.id).slice(-1).map((event) => event.kind),
    ['mission.stopped'],
  );
});

test('mission runtime persists provider-directed handoff as an explicit paused state with a handoff event', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-handoff-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-handoff-state-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-handoff-root-'));
  writeWorkflow(cwd, `
version: 1
maxTurns: 4
maxAttempts: 2
continuation: allow
`);
  const repo = new JsonFileMissionRepository(stateDir);
  const nowRef = { value: 1_700_830_150_000 };

  const provider: MissionProvider = {
    kind: 'fake-provider',
    async start() {
      return {
        providerRunId: 'run-handoff-1',
        providerThreadId: 'thread-handoff-1',
      };
    },
    async continue() {
      throw new Error('continuation should not run in the handoff test');
    },
    async wait() {
      nowRef.value += 100;
      return {
        outcome: 'blocked',
        text: 'Execution must be handed off to the release manager for the deploy window.',
        artifacts: [],
        previewText: 'Release-manager handoff required.',
        errorMessage: null,
        requiresHuman: false,
        handoffState: 'handoff',
        continuationEligible: false,
        stopReason: 'Hand off to the release manager before production deploy.',
        rawState: 'handoff',
      };
    },
    async interrupt() {},
  };

  const verifier: MissionVerifier = {
    async verify() {
      throw new Error('verify should not be called when the provider requests a handoff');
    },
  };

  const mission = createQueuedMission({
    id: 'mission-runtime-handoff',
    cwd,
    now: nowRef.value,
  });
  repo.saveMission(mission);

  const runtime = createRuntimeHarness({
    repository: repo,
    provider,
    verifier,
    rootDir,
    nowRef,
    ids: ['attempt-runtime-handoff-1'],
  });
  const result = await runtime.runMission(mission.id, {
    ownerId: 'worker-runtime-handoff',
    readOnly: true,
    allowSharedCwd: true,
  });

  assert.equal(result.mission.status, 'handoff');
  assert.equal(result.mission.statusReason, 'Hand off to the release manager before production deploy.');
  assert.equal(result.latestCycleResult?.status, 'handoff');
  assert.equal(result.latestCycleResult?.stage, 'provider.terminal');
  assert.equal(result.latestCycleResult?.blocker, 'Hand off to the release manager before production deploy.');
  assert.equal(result.attempt?.status, 'handoff');
  assert.equal(result.providerResult?.handoffState, 'handoff');

  const eventKinds = repo.listEvents(mission.id).map((event) => event.kind);
  assert.ok(eventKinds.includes('mission.handoff'));
});

test('mission runtime materializes max_loops_reached before opening another cycle beyond loopPolicy.maxCycles', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-max-cycles-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-max-cycles-state-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-max-cycles-root-'));
  writeWorkflow(cwd, `
version: 1
maxTurns: 4
maxAttempts: 4
continuation: allow
`);
  const repo = new JsonFileMissionRepository(stateDir);
  const nowRef = { value: 1_700_830_200_000 };
  const prompts: string[] = [];

  const provider: MissionProvider = {
    kind: 'fake-provider',
    async start(input) {
      prompts.push(input.promptText);
      return {
        providerRunId: `run-max-cycles-${prompts.length}`,
        providerThreadId: 'thread-max-cycles',
      };
    },
    async continue() {
      throw new Error('continue should not be called in max-cycles test');
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
    async verify(input) {
      verifierCalls += 1;
      nowRef.value += 20;
      assert.equal(input.activeChecklistItem?.title, 'Patch exists');
      return createMissionVerifierResult({
        verdict: 'complete',
        summary: 'Patch exists and is verified; continue to the remaining checklist item.',
      });
    },
  };

  const mission = transitionMission(createMission({
    id: 'mission-runtime-max-cycles',
    source: 'weixin',
    platform: 'weixin',
    externalScopeId: 'mission-runtime-max-cycles-scope',
    title: 'Mission runtime max cycles',
    goal: 'Stop once the configured cycle budget is exhausted.',
    expectedOutput: 'A verified mission result.',
    acceptanceCriteria: ['Patch exists', 'Tests prove the fix'],
    providerProfileId: 'codex-default',
    cwd,
    loopPolicy: {
      maxAttempts: 4,
      maxTurns: 4,
      maxCycles: 1,
      maxNoProgressCycles: null,
    },
    now: nowRef.value,
  }), 'queued', {
    at: nowRef.value + 10,
  });
  repo.saveMission(mission);

  const runtime = createRuntimeHarness({
    repository: repo,
    provider,
    verifier,
    rootDir,
    nowRef,
    ids: [
      'attempt-runtime-max-cycles-1',
      'event-runtime-max-cycles-1',
      'event-runtime-max-cycles-2',
      'event-runtime-max-cycles-3',
      'event-runtime-max-cycles-4',
      'event-runtime-max-cycles-5',
      'event-runtime-max-cycles-6',
    ],
  });
  const result = await runtime.runMission(mission.id, {
    ownerId: 'worker-runtime-max-cycles',
    readOnly: true,
    allowSharedCwd: true,
  });

  assert.equal(prompts.length, 1);
  assert.equal(verifierCalls, 1);
  assert.equal(result.mission.status, 'max_loops_reached');
  assert.match(result.mission.statusReason ?? '', /max cycles reached/i);
  assert.equal(result.mission.attemptCount, 1);
  assert.equal(result.latestCycleResult?.stage, 'runtime.max_cycles');
  assert.equal(result.latestCycleResult?.status, 'failed');
  assert.equal(result.latestCycleResult?.nextStep, 'Retry the mission to open a new generation with a fresh cycle budget.');

  const eventKinds = repo.listEvents(mission.id).map((event) => event.kind);
  assert.ok(eventKinds.includes('mission.progress'));
  assert.ok(eventKinds.includes('mission.max_loops_reached'));
});

test('mission runtime materializes max_loops_reached before opening another cycle after repeated no-progress repairs', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-max-no-progress-cwd-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-max-no-progress-state-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-runtime-max-no-progress-root-'));
  writeWorkflow(cwd, `
version: 1
maxTurns: 4
maxAttempts: 4
continuation: allow
`);
  const repo = new JsonFileMissionRepository(stateDir);
  const nowRef = { value: 1_700_830_400_000 };
  const prompts: string[] = [];

  const provider: MissionProvider = {
    kind: 'fake-provider',
    async start(input) {
      prompts.push(input.promptText);
      return {
        providerRunId: `run-max-no-progress-${prompts.length}`,
        providerThreadId: 'thread-max-no-progress',
      };
    },
    async continue() {
      throw new Error('continue should not be called in max-no-progress test');
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
    async verify(input) {
      verifierCalls += 1;
      nowRef.value += 20;
      assert.equal(input.activeChecklistItem?.title, 'Patch exists');
      return createMissionVerifierResult({
        verdict: 'repair',
        summary: `Still missing proof on cycle ${verifierCalls}.`,
        missingAcceptanceCriteria: ['Patch exists'],
      });
    },
  };

  const mission = transitionMission(createMission({
    id: 'mission-runtime-max-no-progress',
    source: 'weixin',
    platform: 'weixin',
    externalScopeId: 'mission-runtime-max-no-progress-scope',
    title: 'Mission runtime max no-progress cycles',
    goal: 'Stop once the configured no-progress budget is exhausted.',
    expectedOutput: 'A verified mission result.',
    acceptanceCriteria: ['Patch exists'],
    providerProfileId: 'codex-default',
    cwd,
    loopPolicy: {
      maxAttempts: 4,
      maxTurns: 4,
      maxCycles: 4,
      maxNoProgressCycles: 2,
    },
    now: nowRef.value,
  }), 'queued', {
    at: nowRef.value + 10,
  });
  repo.saveMission(mission);

  const runtime = createRuntimeHarness({
    repository: repo,
    provider,
    verifier,
    rootDir,
    nowRef,
    ids: [
      'attempt-runtime-max-no-progress-1',
      'event-runtime-max-no-progress-1',
      'event-runtime-max-no-progress-2',
      'event-runtime-max-no-progress-3',
      'event-runtime-max-no-progress-4',
      'attempt-runtime-max-no-progress-2',
      'event-runtime-max-no-progress-5',
      'event-runtime-max-no-progress-6',
      'event-runtime-max-no-progress-7',
      'event-runtime-max-no-progress-8',
      'event-runtime-max-no-progress-9',
    ],
  });
  const result = await runtime.runMission(mission.id, {
    ownerId: 'worker-runtime-max-no-progress',
    readOnly: true,
    allowSharedCwd: true,
  });

  assert.equal(prompts.length, 2);
  assert.equal(verifierCalls, 2);
  assert.equal(result.mission.status, 'max_loops_reached');
  assert.match(result.mission.statusReason ?? '', /max no-progress cycles reached/i);
  assert.equal(result.mission.attemptCount, 2);
  assert.equal(result.latestCycleResult?.stage, 'runtime.max_no_progress_cycles');
  assert.equal(result.latestCycleResult?.status, 'failed');
  assert.equal(result.latestCycleResult?.nextStep, 'Retry the mission to open a new generation with a fresh cycle budget.');

  const attempts = repo.listAttempts(mission.id).sort((left, right) => left.index - right.index);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.status, 'repairing');
  assert.equal(attempts[1]?.status, 'repairing');

  const eventKinds = repo.listEvents(mission.id).map((event) => event.kind);
  assert.ok(eventKinds.includes('mission.retrying'));
  assert.ok(eventKinds.includes('mission.max_loops_reached'));
});
