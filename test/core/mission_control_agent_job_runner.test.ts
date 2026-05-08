import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryMissionRepository } from '../../packages/mission-control/src/index.js';
import type { MissionHostNotification } from '../../packages/mission-control/src/index.js';
import { AgentJobService } from '../../src/core/agent_job_service.js';
import { runAgentJobWithMissionControl } from '../../src/core/mission_control_agent_job_runner.js';
import { InMemoryAgentJobRepository } from '../../src/store/in_memory/in_memory_agent_job_repository.js';
import type { BridgeSession, PlatformScopeRef } from '../../src/types/core.js';
import type { ProviderTurnProgress } from '../../src/types/provider.js';

test('runAgentJobWithMissionControl persists provider progress through the package-owned progress sink', async () => {
  const nowRef = { value: 1_701_700_000_000 };
  const session: BridgeSession = {
    id: 'session-runner-progress-1',
    providerProfileId: 'codex-default',
    codexThreadId: 'thread-runner-progress-1',
    cwd: '/repo',
    title: 'Runner progress session',
    createdAt: nowRef.value - 100,
    updatedAt: nowRef.value - 50,
  };
  const missionRepository = new InMemoryMissionRepository();
  const agentJobs = new InMemoryAgentJobRepository();
  const service = new AgentJobService({
    agentJobs,
    missionRepository,
    bridgeSessions: {
      getSessionById(bridgeSessionId: string) {
        return bridgeSessionId === session.id ? session : null;
      },
    },
    now: () => nowRef.value,
  });
  const job = service.createJob({
    scopeRef: {
      platform: 'weixin',
      externalScopeId: 'wx-runner-progress-1',
    },
    title: 'Persist bridge-side progress',
    originalInput: '/agent persist progress',
    goal: 'Keep provider progress in authoritative mission state.',
    expectedOutput: 'A verified result summary.',
    plan: ['Start provider', 'Persist progress', 'Verify result'],
    category: 'code',
    riskLevel: 'medium',
    mode: 'codex',
    providerProfileId: 'codex-default',
    bridgeSessionId: session.id,
    cwd: '/repo',
    locale: 'en',
    maxAttempts: 2,
  });

  const progress: ProviderTurnProgress[] = [
    {
      text: 'Scanned the failing tests.',
      delta: 'Scanned the failing tests.',
      outputKind: 'commentary',
    },
    {
      text: 'Ready to verify the patch.',
      delta: 'Ready to verify the patch.',
      outputKind: 'status',
    },
  ];

  await runAgentJobWithMissionControl({
    job,
    agentJobs: service,
    resolveSession: () => session,
    startTurnWithRecovery: async (
      _scopeRef: PlatformScopeRef,
      bridgeSession,
      _event,
      options,
    ) => {
      for (const entry of progress) {
        await options.onProgress?.(entry);
      }
      return {
        result: {
          outputText: 'Patched the preview flow and verified the fix.',
          previewText: 'Patched the preview flow and verified the fix.',
          outputState: 'complete',
          threadId: bridgeSession.codexThreadId,
          turnId: 'turn-runner-progress-1',
          title: bridgeSession.title,
        },
        session: bridgeSession,
      };
    },
    stopSession: async () => {},
    verifyJob: async () => ({
      pass: true,
      summary: 'Verification passed.',
      issues: [],
      nextAction: 'complete',
    }),
    progressText: {
      running: (attempt, maxAttempts) => `Running attempt ${attempt}/${maxAttempts}.`,
      verifying: () => 'Verifying the provider result.',
      retrying: () => 'Retrying after verifier feedback.',
    },
    now: () => {
      nowRef.value += 10;
      return nowRef.value;
    },
  });

  const mission = missionRepository.getMissionById(job.id);
  assert.equal(mission?.status, 'completed');
  assert.equal(mission?.workpad.summary, 'Verification passed.');
  assert.ok(mission?.workpad.notes.includes('Scanned the failing tests.'));
  assert.ok(mission?.workpad.notes.includes('Summary: Ready to verify the patch.'));
  assert.equal(mission?.workpad.latestVerifierSummary, 'Verification passed.');

  const progressEvents = missionRepository
    .listEvents(job.id)
    .filter((event) => event.kind === 'attempt.progress');
  assert.equal(progressEvents.length >= 3, true);
  assert.equal(progressEvents[0]?.summary, 'Running attempt 1/2.');
  assert.equal(progressEvents[1]?.summary, 'Scanned the failing tests.');
  assert.equal(progressEvents[2]?.summary, 'Ready to verify the patch.');
  assert.equal(progressEvents.some((event) => event.summary === 'Verifying the provider result.'), true);
});

test('runAgentJobWithMissionControl forwards package-backed loop notifications through the host adapter boundary', async () => {
  const nowRef = { value: 1_701_710_000_000 };
  const session: BridgeSession = {
    id: 'session-runner-notify-1',
    providerProfileId: 'codex-default',
    codexThreadId: 'thread-runner-notify-1',
    cwd: '/repo',
    title: 'Runner notification session',
    createdAt: nowRef.value - 100,
    updatedAt: nowRef.value - 50,
  };
  const missionRepository = new InMemoryMissionRepository();
  const agentJobs = new InMemoryAgentJobRepository();
  const service = new AgentJobService({
    agentJobs,
    missionRepository,
    bridgeSessions: {
      getSessionById(bridgeSessionId: string) {
        return bridgeSessionId === session.id ? session : null;
      },
    },
    now: () => nowRef.value,
  });
  const job = service.createJob({
    scopeRef: {
      platform: 'weixin',
      externalScopeId: 'wx-runner-notify-1',
    },
    title: 'Forward mission notifications',
    originalInput: '/agent notify',
    goal: 'Forward authoritative loop notifications back to the host.',
    expectedOutput: 'A verified repair summary.',
    plan: ['Run provider', 'Retry once', 'Verify result'],
    category: 'code',
    riskLevel: 'medium',
    mode: 'codex',
    providerProfileId: 'codex-default',
    bridgeSessionId: session.id,
    cwd: '/repo',
    locale: 'en',
    maxAttempts: 3,
  });

  const notifications: MissionHostNotification[] = [];
  let verifierCallCount = 0;
  let turnCount = 0;

  await runAgentJobWithMissionControl({
    job,
    agentJobs: service,
    resolveSession: () => session,
    startTurnWithRecovery: async (
      _scopeRef: PlatformScopeRef,
      bridgeSession,
    ) => {
      turnCount += 1;
      return {
        result: {
          outputText: turnCount === 1
            ? 'Patched the preview flow.'
            : 'Patched the preview flow and reran the tests.',
          previewText: turnCount === 1
            ? 'Patched the preview flow.'
            : 'Patched the preview flow and reran the tests.',
          outputState: 'complete',
          threadId: bridgeSession.codexThreadId,
          turnId: `turn-runner-notify-${turnCount}`,
          title: bridgeSession.title,
        },
        session: bridgeSession,
      };
    },
    stopSession: async () => {},
    verifyJob: async () => {
      verifierCallCount += 1;
      if (verifierCallCount === 1) {
        return {
          pass: false,
          summary: 'Verification requested a repair before the mission can continue.',
          issues: ['Tests prove the fix'],
          nextAction: 'retry',
        };
      }
      return {
        pass: true,
        summary: 'Verification passed after the retry.',
        issues: [],
        nextAction: 'complete',
      };
    },
    progressText: {
      running: (attempt, maxAttempts) => `Running attempt ${attempt}/${maxAttempts}.`,
      verifying: () => 'Verifying the provider result.',
      retrying: () => 'Retrying after verifier feedback.',
    },
    now: () => {
      nowRef.value += 10;
      return nowRef.value;
    },
    onNotification: async (notification) => {
      notifications.push(notification);
    },
  });

  assert.equal(turnCount >= 2, true);
  assert.equal(notifications.length >= 2, true);
  const loopNotification = notifications.find(
    (notification) => notification.cycleResult?.status === 'continue'
      || notification.cycleResult?.status === 'retry',
  );
  const doneNotification = notifications.findLast(
    (notification) => notification.cycleResult?.status === 'done',
  );
  assert.equal(notifications[0]?.kind, 'cycle_update');
  assert.equal(loopNotification?.loopSnapshot?.currentStage?.startsWith('verifier.'), true);
  assert.equal(loopNotification?.loopSnapshot?.currentCycle, 1);
  assert.equal(doneNotification?.status, 'completed');
  assert.equal(doneNotification?.loopSnapshot?.currentStage, 'verifier.complete');
});

test('runAgentJobWithMissionControl pauses the first host on package-backed formal checklist refinement requests', async () => {
  const nowRef = { value: 1_701_720_000_000 };
  const session: BridgeSession = {
    id: 'session-runner-plan-change-1',
    providerProfileId: 'codex-default',
    codexThreadId: 'thread-runner-plan-change-1',
    cwd: '/repo',
    title: 'Runner plan-change session',
    createdAt: nowRef.value - 100,
    updatedAt: nowRef.value - 50,
  };
  const missionRepository = new InMemoryMissionRepository();
  const agentJobs = new InMemoryAgentJobRepository();
  const service = new AgentJobService({
    agentJobs,
    missionRepository,
    bridgeSessions: {
      getSessionById(bridgeSessionId: string) {
        return bridgeSessionId === session.id ? session : null;
      },
    },
    now: () => nowRef.value,
  });
  const job = service.createJob({
    scopeRef: {
      platform: 'weixin',
      externalScopeId: 'wx-runner-plan-change-1',
    },
    title: 'Pause for checklist refinement approval',
    originalInput: '/agent refine checklist',
    goal: 'Keep formal checklist changes explicit and host-approved.',
    expectedOutput: 'A paused mission awaiting checklist refinement approval.',
    plan: ['Inspect failure', 'Patch code', 'Verify fix'],
    category: 'code',
    riskLevel: 'medium',
    mode: 'codex',
    providerProfileId: 'codex-default',
    bridgeSessionId: session.id,
    cwd: '/repo',
    locale: 'en',
    maxAttempts: 2,
  });

  const notifications: MissionHostNotification[] = [];
  await runAgentJobWithMissionControl({
    job,
    agentJobs: service,
    resolveSession: () => session,
    startTurnWithRecovery: async (
      _scopeRef: PlatformScopeRef,
      bridgeSession,
    ) => ({
      result: {
        outputText: 'Patched the preview flow, but the formal checklist needs a targeted regression-test step.',
        previewText: 'Patched the preview flow, but the formal checklist needs a targeted regression-test step.',
        outputState: 'complete',
        threadId: bridgeSession.codexThreadId,
        turnId: 'turn-runner-plan-change-1',
        title: bridgeSession.title,
      },
      session: bridgeSession,
    }),
    stopSession: async () => {},
    verifyJob: async () => ({
      pass: false,
      summary: 'The formal checklist needs a targeted regression-test refinement before retrying.',
      issues: ['Tests prove the fix'],
      nextAction: 'retry',
      progressSummary: 'Patched the preview flow and found that the confirmed checklist is missing a targeted regression-test step.',
      nextStep: 'Review the proposed checklist refinement before retrying.',
      latestBlocker: 'Need approval for a formal checklist refinement before continuing.',
      planChangeSuggestion: {
        rationale: 'Split verification into implementation and targeted regression-test steps.',
        proposedPlan: ['Inspect failure', 'Patch code', 'Add regression test coverage', 'Run targeted verification'],
        proposedAcceptanceCriteria: ['Patch exists', 'Targeted tests prove the fix'],
      },
    }),
    progressText: {
      running: (attempt, maxAttempts) => `Running attempt ${attempt}/${maxAttempts}.`,
      verifying: () => 'Verifying the provider result.',
      retrying: () => 'Retrying after verifier feedback.',
    },
    now: () => {
      nowRef.value += 10;
      return nowRef.value;
    },
    onNotification: async (notification) => {
      notifications.push(notification);
    },
  });

  const finalJob = service.getById(job.id);
  assert.equal(finalJob?.status, 'scope_change_pending');
  const missionDetail = service.getMissionDetail(job.id);
  assert.equal(missionDetail?.mission.status, 'scope_change_pending');
  assert.equal(missionDetail?.planChangeRequests.length, 1);
  assert.equal(missionDetail?.planChangeRequests[0]?.status, 'proposed');
  assert.deepEqual(missionDetail?.planChangeRequests[0]?.proposedPlan, [
    'Inspect failure',
    'Patch code',
    'Add regression test coverage',
    'Run targeted verification',
  ]);

  const planChangeNotification = notifications.findLast(
    (notification) => notification.cycleResult?.stage === 'verifier.plan_change',
  );
  assert.equal(planChangeNotification?.status, 'scope_change_pending');
  assert.equal(planChangeNotification?.cycleResult?.status, 'waiting_user');
  assert.equal(
    planChangeNotification?.cycleResult?.planChangeSuggestion?.rationale,
    'Split verification into implementation and targeted regression-test steps.',
  );
});
