import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DirectMissionControlApi,
  JsonFileMissionRepository,
  createMission,
  createMissionChecklistSnapshot,
  createMissionCycleResult,
  createMissionGeneration,
  createMissionResumeSnapshot,
  createMissionWorkItem,
  transitionMission,
  type MissionAttempt,
  type MissionEvent,
  type PlanChangeRequest,
} from '../src/index.js';

function createQueuedMission(now: number) {
  return transitionMission(createMission({
    id: 'mission-api-1',
    source: 'weixin',
    sourceRef: 'job-api-1',
    platform: 'weixin',
    externalScopeId: 'wx-user-api-1',
    title: 'Repair the release blocker',
    goal: 'Repair the release blocker and verify the fix.',
    expectedOutput: 'A verified repair summary.',
    acceptanceCriteria: ['Patch exists', 'Tests prove the fix'],
    plan: ['Inspect the regression', 'Patch the code', 'Verify the fix'],
    providerProfileId: 'codex-default',
    bridgeSessionId: 'session-api-1',
    codexThreadId: 'thread-api-1',
    cwd: '/repo',
    workflowPath: '/repo/.codexbridge/mission/WORKFLOW.md',
    workflowHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    workflowResolverReason: 'explicit_override',
    workspacePath: '/tmp/mission-control/workspaces/mission-api-1',
    maxAttempts: 3,
    maxTurns: 5,
    now,
  }), 'queued', {
    at: now + 10,
    reason: 'Mission queued for execution.',
  });
}

function createApiHarness(now = 1_701_200_000_000) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-api-'));
  const repo = new JsonFileMissionRepository(stateDir);
  const nowRef = { value: now };
  const api = new DirectMissionControlApi({
    repository: repo,
    now: () => nowRef.value,
    generateId: () => `event-${nowRef.value++}`,
  });
  return { repo, api, nowRef };
}

test('direct mission control api can create a queued mission from a source-backed work item summary', async () => {
  const { repo, api, nowRef } = createApiHarness(1_701_200_050_000);

  const created = await api.commands.createMission({
    meta: {
      requestId: 'req-create-1',
      correlationId: 'corr-create-1',
      idempotencyKey: 'idem-create-1',
    },
    input: {
      missionId: 'mission-api-create-1',
      workItem: {
        source: 'manual',
        sourceRef: 'manual:api-create-1',
        sourceRevision: 'manual-rev-1',
        title: 'Repair the preview timeout',
        goal: 'Repair the preview timeout without regressing the chat flow.',
        expectedOutput: 'A verified repair summary.',
        acceptanceCriteria: ['Patch exists', 'Targeted test passes'],
        plan: ['Inspect the timeout path', 'Patch the flaky branch', 'Verify the fix'],
        metadata: {
          category: 'code',
        },
      },
      platform: 'weixin',
      externalScopeId: 'wx-user-create-1',
      providerProfileId: 'codex-default',
      hostSessionId: 'session-api-create-1',
      providerThreadId: 'thread-api-create-1',
      cwd: '/repo',
      riskLevel: 'medium',
      maxAttempts: 3,
      maxTurns: 8,
      initialStatus: 'queued',
      reason: 'Mission queued from the manual work item source.',
      actor: {
        actorId: 'test-host',
        actorType: 'host',
      },
    },
  });

  assert.equal(created.meta.requestId, 'req-create-1');
  assert.equal(created.data.mission.status, 'queued');
  assert.equal(created.data.mission.source, 'manual');
  assert.equal(created.data.hostBindings.platform, 'weixin');
  assert.equal(created.data.hostBindings.source, 'manual');
  assert.equal(created.data.hostBindings.hostSessionId, 'session-api-create-1');
  assert.equal(created.data.hostBindings.providerThreadId, 'thread-api-create-1');
  assert.equal(created.data.hostBindings.bridgeSessionId, 'session-api-create-1');
  assert.equal(created.data.hostBindings.codexThreadId, 'thread-api-create-1');
  assert.equal(created.data.workItem?.sourceRevision, 'manual-rev-1');
  assert.deepEqual(created.data.workItem?.metadata, { category: 'code' });
  assert.equal(created.data.activeGeneration?.id, 'mission-api-create-1:generation:1');
  assert.equal(created.data.currentChecklistSnapshot?.sourceRevision, 'manual-rev-1');
  assert.deepEqual(
    created.data.currentChecklistSnapshot?.acceptanceCriteria,
    ['Patch exists', 'Targeted test passes'],
  );

  const events = repo.listEvents('mission-api-create-1');
  assert.deepEqual(events.map((event) => event.kind), ['mission.created', 'mission.queued']);
  assert.equal(events[0]?.metadata.sourceRef, 'manual:api-create-1');
  assert.equal(events[1]?.summary, 'Mission queued from the manual work item source.');

  const repeated = await api.commands.createMission({
    meta: {
      requestId: 'req-create-2',
      correlationId: null,
      idempotencyKey: 'idem-create-1',
    },
    input: {
      missionId: 'mission-api-create-1',
      workItem: {
        source: 'manual',
        sourceRef: 'manual:api-create-1',
        sourceRevision: 'manual-rev-2',
        title: 'Changed title should not overwrite the existing mission',
        goal: 'Changed goal',
        expectedOutput: 'Changed output',
        acceptanceCriteria: ['Changed acceptance'],
        plan: ['Changed plan'],
        metadata: null,
      },
      platform: 'weixin',
      externalScopeId: 'wx-user-create-1',
      providerProfileId: 'codex-default',
    },
  });

  assert.equal(repeated.data.mission.title, 'Repair the preview timeout');
  assert.equal(repo.listEvents('mission-api-create-1').length, 2);
  assert.equal(repo.getChecklistSnapshotById('mission-api-create-1:checklist:1')?.hash?.length, 64);
  assert.deepEqual(events.map((event) => event.id), ['event-1701200050000', 'event-1701200050001']);
  assert.equal(nowRef.value, 1_701_200_050_002);
});

test('direct mission control api exposes host-neutral binding views from generic session and provider thread fields', async () => {
  const { api } = createApiHarness(1_701_200_055_000);

  const created = await api.commands.createMission({
    meta: {
      requestId: 'req-create-cli-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-api-cli-create-1',
      workItem: {
        source: 'manual',
        sourceRef: 'manual:api-cli-create-1',
        sourceRevision: 'manual-cli-rev-1',
        title: 'Inspect the CLI host contract',
        goal: 'Create a mission through generic host-neutral bindings.',
        expectedOutput: 'A host-neutral mission detail view.',
        acceptanceCriteria: ['Mission is created'],
        plan: ['Create the mission'],
        metadata: null,
      },
      platform: 'cli',
      externalScopeId: 'cli-user-create-1',
      providerProfileId: 'codex-default',
      hostSessionId: 'cli-session-1',
      providerThreadId: 'thread-cli-create-1',
      initialStatus: 'queued',
    },
  });

  assert.equal(created.data.hostBindings.platform, 'cli');
  assert.equal(created.data.hostBindings.externalScopeId, 'cli-user-create-1');
  assert.equal(created.data.hostBindings.hostSessionId, 'cli-session-1');
  assert.equal(created.data.hostBindings.providerThreadId, 'thread-cli-create-1');
  assert.equal(created.data.hostBindings.bridgeSessionId, 'cli-session-1');
  assert.equal(created.data.hostBindings.codexThreadId, 'thread-cli-create-1');
});

test('direct mission control api stages checklist and immutable prompt confirmation before the first queue', async () => {
  const { repo, api } = createApiHarness(1_701_200_057_000);

  const created = await api.commands.createMission({
    meta: {
      requestId: 'req-start-create-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-api-start-1',
      workItem: {
        source: 'manual',
        sourceRef: 'manual:api-start-1',
        sourceRevision: 'manual-start-rev-1',
        title: 'Stabilize the preview flow',
        goal: 'Stabilize the preview flow before the first autonomous run.',
        expectedOutput: 'A verified preview-flow repair summary.',
        acceptanceCriteria: ['Patch exists', 'Targeted test passes'],
        plan: ['Inspect the preview flow', 'Patch the flaky branch', 'Verify the result'],
        metadata: null,
      },
      platform: 'weixin',
      externalScopeId: 'wx-user-start-1',
      providerProfileId: 'codex-default',
      initialStatus: 'draft',
    },
  });

  assert.equal(created.data.mission.status, 'draft');
  assert.equal(repo.listEvents('mission-api-start-1').map((event) => event.kind).join(','), 'mission.created');

  const checklistPending = await api.commands.startMission({
    meta: {
      requestId: 'req-start-checklist-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-api-start-1',
    },
  });
  assert.equal(checklistPending.data.mission.status, 'awaiting_checklist_confirm');
  assert.match(checklistPending.data.pendingApproval?.summary ?? '', /checklist/i);

  const promptPending = await api.commands.startMission({
    meta: {
      requestId: 'req-start-prompt-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-api-start-1',
      confirmChecklist: true,
    },
  });
  assert.equal(promptPending.data.mission.status, 'awaiting_prompt_confirm');
  assert.match(promptPending.data.pendingApproval?.summary ?? '', /immutable prompt/i);

  const queued = await api.commands.startMission({
    meta: {
      requestId: 'req-start-queue-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-api-start-1',
      confirmPrompt: true,
    },
  });
  assert.equal(queued.data.mission.status, 'queued');
  assert.equal(queued.data.pendingApproval, null);
  assert.deepEqual(
    repo.listEvents('mission-api-start-1').map((event) => event.kind),
    [
      'mission.created',
      'mission.awaiting_checklist_confirm',
      'mission.awaiting_prompt_confirm',
      'mission.queued',
    ],
  );
});

test('direct mission control api resolves workflow confirmations and paused approvals through package-owned approval commands', async () => {
  const { repo, api, nowRef } = createApiHarness(1_701_200_058_000);

  await api.commands.createMission({
    meta: {
      requestId: 'req-approval-create-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-api-approval-1',
      workItem: {
        source: 'manual',
        sourceRef: 'manual:api-approval-1',
        sourceRevision: 'manual-approval-rev-1',
        title: 'Confirm the first autonomous cycle',
        goal: 'Require package-owned approval resolution before the first run.',
        expectedOutput: 'A queued mission after approvals.',
        acceptanceCriteria: ['Checklist confirmed', 'Prompt confirmed'],
        plan: ['Inspect the checklist', 'Inspect the immutable prompt'],
        metadata: null,
      },
      platform: 'weixin',
      externalScopeId: 'wx-user-approval-1',
      providerProfileId: 'codex-default',
      initialStatus: 'draft',
    },
  });

  await api.commands.startMission({
    meta: {
      requestId: 'req-approval-stage-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-api-approval-1',
    },
  });

  const promptPending = await api.commands.submitApproval({
    meta: {
      requestId: 'req-approval-checklist-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-api-approval-1',
      decision: 'approve',
      actor: {
        actorId: 'test-user',
        actorType: 'user',
      },
    },
  });
  assert.equal(promptPending.data.mission.status, 'awaiting_prompt_confirm');
  assert.match(promptPending.data.pendingApproval?.summary ?? '', /immutable prompt/i);

  const queued = await api.commands.submitApproval({
    meta: {
      requestId: 'req-approval-prompt-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-api-approval-1',
      decision: 'approve',
      actor: {
        actorId: 'test-user',
        actorType: 'user',
      },
    },
  });
  assert.equal(queued.data.mission.status, 'queued');
  assert.equal(queued.data.pendingApproval, null);

  const waitingBase = createQueuedMission(nowRef.value + 500);
  const waitingRunning = transitionMission(waitingBase, 'running', {
    at: nowRef.value + 520,
    activeAttemptId: 'attempt-api-approval-waiting-1',
  });
  const waitingMission = transitionMission(waitingRunning, 'waiting_user', {
    at: nowRef.value + 530,
    reason: 'Need approval on the deployment window.',
    lastError: 'Need approval on the deployment window.',
    pendingApproval: {
      requestId: 'approval-waiting-1',
      kind: 'manual',
      summary: 'Approve or reject the proposed deployment window before continuing.',
      options: [
        { index: 1, label: 'Approve window' },
        { index: 2, label: 'Reject window' },
      ],
      createdAt: nowRef.value + 530,
    },
  });
  waitingMission.attemptCount = 1;

  repo.saveMission(waitingMission);
  repo.saveWorkItem(createMissionWorkItem(waitingMission, { at: nowRef.value + 510 }));

  const approvalResolved = await api.commands.submitApproval({
    meta: {
      requestId: 'req-approval-waiting-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: waitingMission.id,
      approvalId: 'approval-waiting-1',
      decision: 'reject',
      responseText: 'Do not deploy today; wait for tomorrow morning.',
      actor: {
        actorId: 'release-manager',
        actorType: 'user',
      },
    },
  });

  assert.equal(approvalResolved.data.mission.status, 'queued');
  assert.equal(approvalResolved.data.pendingApproval, null);
  assert.equal(approvalResolved.data.workpadStatus.summary, 'Mission queued after human response.');
  assert.match(
    approvalResolved.data.workpadStatus.notes.at(-1) ?? '',
    /Do not deploy today; wait for tomorrow morning\./,
  );
  const finalEvent = repo.listEvents(waitingMission.id).at(-1) as MissionEvent | undefined;
  assert.equal(finalEvent?.kind, 'mission.queued');
  assert.equal((finalEvent?.metadata as Record<string, unknown> | undefined)?.decision, 'reject');
  assert.equal(
    (finalEvent?.metadata as Record<string, unknown> | undefined)?.responseText,
    'Do not deploy today; wait for tomorrow morning.',
  );
});

test('direct mission control api can sync a pristine mission from a refreshed source summary before attempts start', async () => {
  const { repo, api, nowRef } = createApiHarness(1_701_200_060_000);

  await api.commands.createMission({
    meta: {
      requestId: 'req-sync-create-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-api-sync-1',
      workItem: {
        source: 'manual',
        sourceRef: 'manual:api-sync-1',
        sourceRevision: 'manual-rev-1',
        title: 'Repair the preview timeout',
        goal: 'Repair the preview timeout without regressing the chat flow.',
        expectedOutput: 'A verified repair summary.',
        acceptanceCriteria: ['Patch exists', 'Targeted test passes'],
        plan: ['Inspect the timeout path', 'Patch the flaky branch', 'Verify the fix'],
        metadata: {
          category: 'code',
        },
      },
      platform: 'weixin',
      externalScopeId: 'wx-user-sync-1',
      providerProfileId: 'codex-default',
      bridgeSessionId: 'session-api-sync-1',
      codexThreadId: 'thread-api-sync-1',
      cwd: '/repo',
      riskLevel: 'medium',
      maxAttempts: 3,
      maxTurns: 8,
      initialStatus: 'queued',
      reason: 'Mission queued from the manual work item source.',
      actor: {
        actorId: 'test-host',
        actorType: 'host',
      },
    },
  });
  const createdMission = repo.getMissionById('mission-api-sync-1');
  const createdSnapshot = repo.getChecklistSnapshotById('mission-api-sync-1:checklist:1');

  nowRef.value += 50;
  const syncAt = nowRef.value;

  const synced = await api.commands.syncMissionSource({
    meta: {
      requestId: 'req-sync-1',
      correlationId: 'corr-sync-1',
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-api-sync-1',
      workItem: {
        source: 'manual',
        sourceRef: 'manual:api-sync-1',
        sourceRevision: 'manual-rev-2',
        title: 'Repair the preview timeout quickly',
        goal: 'Repair the preview timeout and keep the delivery path stable.',
        expectedOutput: 'A refreshed verified repair summary.',
        acceptanceCriteria: ['Patch exists', 'Targeted test passes', 'Delivery preview stays stable'],
        plan: ['Inspect the timeout path', 'Patch the flaky branch', 'Verify the fix', 'Check preview delivery'],
        metadata: {
          category: 'code',
          sync: true,
        },
      },
      reason: 'Mission source synced before execution.',
      actor: {
        actorId: 'test-host',
        actorType: 'host',
      },
    },
  });

  assert.equal(synced.meta.requestId, 'req-sync-1');
  assert.equal(synced.data.mission.title, 'Repair the preview timeout quickly');
  assert.equal(synced.data.mission.immutableGoal, 'Repair the preview timeout and keep the delivery path stable.');
  assert.equal(synced.data.workItem?.sourceRevision, 'manual-rev-2');
  assert.deepEqual(synced.data.workItem?.metadata, {
    category: 'code',
    sync: true,
  });
  assert.equal(synced.data.currentChecklistSnapshot?.version, 2);
  assert.deepEqual(
    synced.data.currentChecklistSnapshot?.acceptanceCriteria,
    ['Patch exists', 'Targeted test passes', 'Delivery preview stays stable'],
  );
  assert.deepEqual(
    synced.data.currentChecklistSnapshot?.plan,
    ['Inspect the timeout path', 'Patch the flaky branch', 'Verify the fix', 'Check preview delivery'],
  );
  assert.equal(synced.data.mission.createdAt, createdMission?.createdAt);
  assert.equal(synced.data.currentChecklistSnapshot?.createdAt, syncAt);
  assert.notEqual(synced.data.currentChecklistSnapshot?.hash, createdSnapshot?.hash);
  assert.equal(repo.getChecklistSnapshotById('mission-api-sync-1:checklist:1')?.supersededAt, syncAt);
  assert.equal(repo.listChecklistSnapshots('mission-api-sync-1').length, 2);
  assert.equal(repo.getGenerationById('mission-api-sync-1:generation:1')?.checklistSnapshotId, 'mission-api-sync-1:checklist:2');

  const events = repo.listEvents('mission-api-sync-1');
  assert.deepEqual(events.map((event) => event.kind), ['mission.created', 'mission.queued', 'mission.source_synced']);
  assert.equal(events[2]?.metadata.previousSourceRevision, 'manual-rev-1');
  assert.equal(events[2]?.metadata.sourceRevision, 'manual-rev-2');
});

test('direct mission control api can propose and apply a scope change through a new checklist snapshot version', async () => {
  const { repo, api, nowRef } = createApiHarness(1_701_200_060_500);
  const queued = createQueuedMission(nowRef.value);
  const running = transitionMission(queued, 'running', {
    at: nowRef.value + 20,
    activeAttemptId: 'attempt-api-plan-change-1',
  });
  running.attemptCount = 1;

  repo.saveMission(running);
  repo.saveWorkItem(createMissionWorkItem(running, { at: nowRef.value + 5 }));
  repo.saveGeneration(createMissionGeneration(running, {
    at: nowRef.value + 5,
    trigger: 'initial',
  }));
  repo.saveChecklistSnapshot(createMissionChecklistSnapshot(running, {
    at: nowRef.value + 6,
    generationId: running.activeGenerationId,
  }));

  const proposed = await api.commands.proposePlanChange({
    meta: {
      requestId: 'req-plan-change-propose-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: running.id,
      rationale: 'The release fix also needs a dry-run acceptance gate.',
      proposedExpectedOutput: 'A verified repair summary plus release dry-run evidence.',
      proposedAcceptanceCriteria: ['Patch exists', 'Tests prove the fix', 'Release dry-run passes'],
      proposedPlan: ['Inspect the regression', 'Patch the code', 'Run the release dry-run'],
      actor: {
        actorId: 'test-host',
        actorType: 'host',
      },
    },
  });

  assert.equal(proposed.data.mission.status, 'scope_change_pending');
  assert.equal(proposed.data.planChangeRequests.length, 1);
  assert.equal(proposed.data.planChangeRequests[0]?.status, 'proposed');
  assert.match(proposed.data.pendingApproval?.summary ?? '', /scope change/i);

  const approved = await api.commands.resolvePlanChange({
    meta: {
      requestId: 'req-plan-change-approve-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: running.id,
      decision: 'approve',
      actor: {
        actorId: 'test-user',
        actorType: 'user',
      },
    },
  });

  assert.equal(approved.data.mission.status, 'queued');
  assert.equal(approved.data.pendingApproval, null);
  assert.equal(approved.data.mission.expectedOutput, 'A verified repair summary plus release dry-run evidence.');
  assert.deepEqual(
    approved.data.mission.acceptanceCriteria,
    ['Patch exists', 'Tests prove the fix', 'Release dry-run passes'],
  );
  assert.deepEqual(
    approved.data.mission.plan,
    ['Inspect the regression', 'Patch the code', 'Run the release dry-run'],
  );
  assert.equal(approved.data.currentChecklistSnapshot?.version, 2);
  assert.equal(approved.data.currentChecklistSnapshot?.expectedOutput, 'A verified repair summary plus release dry-run evidence.');
  assert.equal(approved.data.planChangeRequests[0]?.status, 'applied');
  assert.equal(approved.data.planChangeRequests[0]?.decidedBy, 'test-user');
  assert.equal(
    repo.getChecklistSnapshotById('mission-api-1:checklist:1')?.supersededAt,
    approved.data.currentChecklistSnapshot?.createdAt ?? null,
  );
  assert.equal(repo.getGenerationById('mission-api-1:generation:1')?.checklistSnapshotId, 'mission-api-1:checklist:2');
  assert.equal(repo.getWorkItemById(running.workItemId)?.expectedOutput, 'A verified repair summary.');
  assert.deepEqual(
    repo.listEvents(running.id).map((event) => event.kind),
    ['mission.scope_change_pending', 'mission.plan_change_applied'],
  );
});

test('direct mission control api can reject a pending scope change and keep the current checklist version', async () => {
  const { repo, api, nowRef } = createApiHarness(1_701_200_060_800);
  const queued = createQueuedMission(nowRef.value);
  const running = transitionMission(queued, 'running', {
    at: nowRef.value + 20,
    activeAttemptId: 'attempt-api-plan-change-2',
  });
  running.attemptCount = 1;

  repo.saveMission(running);
  repo.saveWorkItem(createMissionWorkItem(running, { at: nowRef.value + 5 }));
  repo.saveGeneration(createMissionGeneration(running, {
    at: nowRef.value + 5,
    trigger: 'initial',
  }));
  repo.saveChecklistSnapshot(createMissionChecklistSnapshot(running, {
    at: nowRef.value + 6,
    generationId: running.activeGenerationId,
  }));

  await api.commands.proposePlanChange({
    meta: {
      requestId: 'req-plan-change-propose-2',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: running.id,
      rationale: 'Do not broaden scope unless the operator explicitly approves it.',
      proposedAcceptanceCriteria: ['Patch exists', 'Tests prove the fix', 'Release dry-run passes'],
      proposedPlan: ['Inspect the regression', 'Patch the code', 'Run the release dry-run'],
    },
  });

  const rejected = await api.commands.resolvePlanChange({
    meta: {
      requestId: 'req-plan-change-reject-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: running.id,
      decision: 'reject',
      actor: {
        actorId: 'test-user',
        actorType: 'user',
      },
    },
  });

  assert.equal(rejected.data.mission.status, 'queued');
  assert.equal(rejected.data.pendingApproval, null);
  assert.equal(rejected.data.currentChecklistSnapshot?.version, 1);
  assert.deepEqual(rejected.data.mission.acceptanceCriteria, ['Patch exists', 'Tests prove the fix']);
  assert.deepEqual(rejected.data.mission.plan, ['Inspect the regression', 'Patch the code', 'Verify the fix']);
  assert.equal(rejected.data.planChangeRequests[0]?.status, 'rejected');
  assert.equal(repo.listChecklistSnapshots(running.id).length, 1);
  assert.deepEqual(
    repo.listEvents(running.id).map((event) => event.kind),
    ['mission.scope_change_pending', 'mission.plan_change_rejected'],
  );
});

test('direct mission control api keeps pristine source sync history across repeated pre-attempt refreshes', async () => {
  const { repo, api, nowRef } = createApiHarness(1_701_200_061_000);

  await api.commands.createMission({
    meta: {
      requestId: 'req-sync-repeat-create-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-api-sync-repeat-1',
      workItem: {
        source: 'manual',
        sourceRef: 'manual:api-sync-repeat-1',
        sourceRevision: 'manual-repeat-rev-1',
        title: 'Repair the preview timeout',
        goal: 'Repair the preview timeout without regressing the chat flow.',
        expectedOutput: 'A verified repair summary.',
        acceptanceCriteria: ['Patch exists'],
        plan: ['Inspect the timeout path'],
        metadata: null,
      },
      platform: 'weixin',
      externalScopeId: 'wx-user-sync-repeat-1',
      providerProfileId: 'codex-default',
      initialStatus: 'queued',
    },
  });

  nowRef.value += 25;
  const firstSyncAt = nowRef.value;
  await api.commands.syncMissionSource({
    meta: {
      requestId: 'req-sync-repeat-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-api-sync-repeat-1',
      workItem: {
        source: 'manual',
        sourceRef: 'manual:api-sync-repeat-1',
        sourceRevision: 'manual-repeat-rev-2',
        title: 'Repair the preview timeout quickly',
        goal: 'Repair the preview timeout quickly.',
        expectedOutput: 'A refreshed repair summary.',
        acceptanceCriteria: ['Patch exists', 'Targeted test passes'],
        plan: ['Inspect the timeout path', 'Patch the flaky branch'],
        metadata: null,
      },
    },
  });

  nowRef.value += 25;
  const secondSyncAt = nowRef.value;
  await api.commands.syncMissionSource({
    meta: {
      requestId: 'req-sync-repeat-2',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-api-sync-repeat-1',
      workItem: {
        source: 'manual',
        sourceRef: 'manual:api-sync-repeat-1',
        sourceRevision: 'manual-repeat-rev-3',
        title: 'Repair the preview timeout with delivery coverage',
        goal: 'Repair the preview timeout and keep delivery coverage stable.',
        expectedOutput: 'A final refreshed repair summary.',
        acceptanceCriteria: ['Patch exists', 'Targeted test passes', 'Delivery preview stays stable'],
        plan: ['Inspect the timeout path', 'Patch the flaky branch', 'Check preview delivery'],
        metadata: null,
      },
    },
  });

  assert.deepEqual(
    repo.listEvents('mission-api-sync-repeat-1').map((event) => event.kind),
    ['mission.created', 'mission.queued', 'mission.source_synced', 'mission.source_synced'],
  );
  assert.deepEqual(
    repo.listChecklistSnapshots('mission-api-sync-repeat-1').map((snapshot) => ({
      version: snapshot.version,
      supersededAt: snapshot.supersededAt,
    })),
    [
      { version: 1, supersededAt: firstSyncAt },
      { version: 2, supersededAt: secondSyncAt },
      { version: 3, supersededAt: null },
    ],
  );
  assert.equal(repo.getMissionById('mission-api-sync-repeat-1')?.currentChecklistSnapshotVersion, 3);
});

test('direct mission control api rejects source sync once a mission has started attempts', () => {
  const { repo, api, nowRef } = createApiHarness(1_701_200_070_000);
  const queued = createQueuedMission(nowRef.value);
  const running = transitionMission(queued, 'running', {
    at: nowRef.value + 20,
    activeAttemptId: 'attempt-api-sync-running-1',
  });
  running.attemptCount = 1;
  const attempt: MissionAttempt = {
    id: 'attempt-api-sync-running-1',
    missionId: running.id,
    generationId: running.activeGenerationId,
    generationIndex: running.activeGenerationIndex,
    checklistSnapshotId: running.currentChecklistSnapshotId,
    index: 1,
    status: 'running',
    providerRunId: 'run-api-sync-running-1',
    providerThreadId: 'thread-api-sync-running-1',
    workflowPath: running.workflowPath,
    workflowHash: running.workflowHash,
    resolverReason: running.workflowResolverReason,
    promptDigest: 'digest-api-sync-running-1',
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

  repo.saveMission(running);
  repo.saveWorkItem(createMissionWorkItem(running, { at: nowRef.value + 5 }));
  repo.saveGeneration(createMissionGeneration(running, {
    at: nowRef.value + 5,
    trigger: 'initial',
  }));
  repo.saveChecklistSnapshot(createMissionChecklistSnapshot(running, {
    at: nowRef.value + 6,
    generationId: running.activeGenerationId,
  }));
  repo.saveAttempt(attempt);

  assert.throws(() => {
    api.commands.syncMissionSource({
      meta: {
        requestId: 'req-sync-reject-1',
        correlationId: null,
        idempotencyKey: null,
      },
      input: {
        missionId: running.id,
        workItem: {
          source: 'weixin',
          sourceRef: running.sourceRef ?? running.id,
          sourceRevision: 'sync-reject-rev-1',
          title: 'Should not overwrite a running mission',
          goal: 'Changed goal',
          expectedOutput: 'Changed output',
          acceptanceCriteria: ['Changed acceptance'],
          plan: ['Changed plan'],
          metadata: null,
        },
      },
    });
  }, /before attempts start/);
});

test('direct mission control api exposes package-owned query views with boundary metadata', async () => {
  const { repo, api, nowRef } = createApiHarness();
  const queued = createQueuedMission(nowRef.value);
  const running = transitionMission(queued, 'running', {
    at: nowRef.value + 20,
    activeAttemptId: 'attempt-api-1',
    lastResultPreview: 'Patched the release gate.',
  });
  const verifying = transitionMission(running, 'verifying', {
    at: nowRef.value + 30,
  });
  verifying.attemptCount = 1;
  verifying.workpad.summary = 'Release blocker investigation is in progress.';
  verifying.workpad.latestBlocker = 'Waiting for the verification pass.';
  verifying.workpad.latestVerifierSummary = 'Verification has not finished yet.';
  verifying.resultArtifacts = [{
    type: 'file',
    path: '/tmp/report.md',
    name: 'report.md',
    mimeType: 'text/markdown',
    caption: 'repair report',
  }];
  verifying.pendingApproval = {
    requestId: 'approval-api-1',
    kind: 'provider',
    summary: 'Need permission to run the release script.',
    options: [{ index: 0, label: 'Approve' }],
    createdAt: nowRef.value + 31,
  };

  const attempt: MissionAttempt = {
    id: 'attempt-api-1',
    missionId: verifying.id,
    generationId: verifying.activeGenerationId,
    generationIndex: verifying.activeGenerationIndex,
    checklistSnapshotId: verifying.currentChecklistSnapshotId,
    index: 1,
    status: 'verifying',
    providerRunId: 'run-api-1',
    providerThreadId: 'thread-api-1',
    workflowPath: verifying.workflowPath,
    workflowHash: verifying.workflowHash,
    resolverReason: verifying.workflowResolverReason,
    promptDigest: 'digest-api-1',
    verifierVerdict: null,
    verifierSummary: null,
    missingAcceptanceCriteria: [],
    outputPreview: 'Patched the release gate.',
    error: null,
    startedAt: nowRef.value + 20,
    endedAt: null,
    createdAt: nowRef.value + 20,
    updatedAt: nowRef.value + 30,
  };
  const planChangeRequest: PlanChangeRequest = {
    id: 'plan-change-api-1',
    missionId: verifying.id,
    generationId: verifying.activeGenerationId,
    checklistSnapshotId: verifying.currentChecklistSnapshotId,
    status: 'proposed',
    rationale: 'Expand the verification coverage.',
    proposedExpectedOutput: null,
    proposedAcceptanceCriteria: ['Patch exists', 'Tests prove the fix', 'Release dry-run passes'],
    proposedPlan: ['Inspect the regression', 'Patch the code', 'Run the release dry-run'],
    createdAt: nowRef.value + 32,
    decidedAt: null,
    decidedBy: null,
  };
  const event: MissionEvent = {
    id: 'event-api-existing',
    missionId: verifying.id,
    attemptId: attempt.id,
    generationId: verifying.activeGenerationId,
    generationIndex: verifying.activeGenerationIndex,
    kind: 'mission.verifying',
    summary: 'Mission moved into verification.',
    detail: null,
    metadata: {
      source: 'test',
      cycleResult: createMissionCycleResult({
        mission: verifying,
        attempt,
        checklistSnapshot: createMissionChecklistSnapshot(verifying, {
          at: nowRef.value + 6,
          generationId: verifying.activeGenerationId,
        }),
        cycle: 1,
        status: 'retry',
        stage: 'verifier.repair',
        progress: 'Verification found missing release dry-run evidence.',
        nextStep: 'Retry the mission with the missing verification evidence.',
        verifierSummary: 'Verification found missing release dry-run evidence.',
        blocker: 'Release dry-run evidence is still missing.',
        evidence: {
          missingAcceptanceCriteria: ['Release dry-run passes'],
        },
        eventSeq: 1,
        updatedAt: nowRef.value + 33,
      }),
    },
    createdAt: nowRef.value + 33,
  };

  repo.saveMission(verifying);
  repo.saveWorkItem(createMissionWorkItem(verifying, { at: nowRef.value + 5 }));
  repo.saveGeneration(createMissionGeneration(verifying, {
    at: nowRef.value + 5,
    trigger: 'initial',
  }));
  repo.saveChecklistSnapshot(createMissionChecklistSnapshot(verifying, {
    at: nowRef.value + 6,
    generationId: verifying.activeGenerationId,
  }));
  repo.savePlanChangeRequest(planChangeRequest);
  repo.saveAttempt(attempt);
  repo.saveEnvironmentStamp({
    id: `${verifying.id}:env:${attempt.id}`,
    missionId: verifying.id,
    generationId: verifying.activeGenerationId,
    generationIndex: verifying.activeGenerationIndex,
    attemptId: attempt.id,
    cycle: 1,
    cwd: '/repo',
    workspacePath: '/tmp/mission-api-existing',
    gitSha: 'abcdef0123456789abcdef0123456789abcdef01',
    gitBranch: 'track/mission-control',
    workflowHash: verifying.workflowHash,
    providerProfileId: verifying.providerProfileId,
    capturedAt: nowRef.value + 30,
  });
  repo.saveCheckpoint({
    id: `${verifying.id}:checkpoint:1`,
    missionId: verifying.id,
    attemptId: attempt.id,
    generationId: verifying.activeGenerationId,
    generationIndex: verifying.activeGenerationIndex,
    cycle: 1,
    stage: 'provider.candidate_ready',
    summary: 'Provider returned a candidate result for verification.',
    payload: {
      providerRunId: attempt.providerRunId,
      workflowHash: verifying.workflowHash,
    },
    createdAt: nowRef.value + 32,
  });
  repo.appendEvent(event);

  const listResult = await api.queries.listMissionSummaries({
    meta: {
      requestId: 'req-list-1',
      correlationId: 'corr-list-1',
      idempotencyKey: 'idem-list-1',
    },
    input: {
      filter: {
        platform: 'weixin',
      },
    },
  });
  assert.equal(listResult.meta.requestId, 'req-list-1');
  assert.equal(listResult.data.length, 1);
  assert.equal(listResult.data[0]?.mission.id, verifying.id);
  assert.equal(listResult.data[0]?.latestBlocker, 'Waiting for the verification pass.');
  assert.equal(listResult.data[0]?.pendingApproval?.requestId, 'approval-api-1');
  assert.equal(listResult.data[0]?.executionRefs.providerRunId, 'run-api-1');
  assert.equal(listResult.data[0]?.artifactRefs[0]?.path, '/tmp/report.md');
  assert.equal(listResult.data[0]?.latestCycleResult?.status, 'retry');
  assert.equal(listResult.data[0]?.loopSnapshot.currentCycle, 1);
  assert.equal(listResult.data[0]?.loopSnapshot.currentStage, 'verifier.repair');
  assert.equal(
    listResult.data[0]?.loopSnapshot.currentProgress,
    'Verification found missing release dry-run evidence.',
  );
  assert.equal(listResult.data[0]?.loopSnapshot.currentItemTitle, 'Inspect the regression');
  assert.equal(
    listResult.data[0]?.loopSnapshot.nextStep,
    'Retry the mission with the missing verification evidence.',
  );
  assert.equal(listResult.data[0]?.workflow.status, 'loaded');
  assert.equal(listResult.data[0]?.checklistStatus.generationIndex, 1);
  assert.equal(listResult.data[0]?.checklistStatus.currentItem?.title, 'Inspect the regression');
  assert.equal(listResult.data[0]?.workpadStatus.summary, 'Release blocker investigation is in progress.');

  const detailResult = await api.queries.getMissionDetail({
    meta: {
      requestId: 'req-detail-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: verifying.id,
    },
  });
  assert.equal(detailResult.data?.workItem?.id, verifying.workItemId);
  assert.equal(detailResult.data?.activeGeneration?.id, verifying.activeGenerationId);
  assert.equal(detailResult.data?.currentChecklistSnapshot?.id, verifying.currentChecklistSnapshotId);
  assert.equal(detailResult.data?.planChangeRequests.length, 1);
  assert.equal(detailResult.data?.attempts.length, 1);
  assert.equal(detailResult.data?.environmentStamps.length, 1);
  assert.equal(detailResult.data?.environmentStamps[0]?.workspacePath, '/tmp/mission-api-existing');
  assert.equal(detailResult.data?.checkpoints.length, 1);
  assert.equal(detailResult.data?.checkpoints[0]?.stage, 'provider.candidate_ready');
  assert.equal(detailResult.data?.latestCycleResult?.stage, 'verifier.repair');
  assert.equal(detailResult.data?.loopSnapshot.loopStatus, 'retry');
  assert.equal(detailResult.data?.loopSnapshot.currentItemTitle, 'Inspect the regression');
  assert.equal(detailResult.data?.loopSnapshot.overallCompletion, 0);
  assert.equal(detailResult.data?.loopSnapshot.latestVerifierSummary, 'Verification has not finished yet.');
  assert.equal(detailResult.data?.workflow.status, 'loaded');
  assert.equal(detailResult.data?.workflow.error, null);
  assert.equal(detailResult.data?.checklistStatus.totalItems, 3);
  assert.equal(detailResult.data?.checklistStatus.completedItems, 0);
  assert.equal(detailResult.data?.checklistStatus.overallCompletion, 0);
  assert.equal(detailResult.data?.checklistStatus.currentItem?.title, 'Inspect the regression');
  assert.equal(detailResult.data?.workpadStatus.summary, 'Release blocker investigation is in progress.');
  assert.equal(detailResult.data?.workpadStatus.latestBlocker, 'Waiting for the verification pass.');
  assert.match(detailResult.data?.workpadStatus.attemptHistory[0] ?? '', /#1 verifying/);

  const timelineResult = await api.queries.getMissionTimeline({
    meta: {
      requestId: 'req-timeline-1',
      correlationId: 'corr-timeline-1',
      idempotencyKey: null,
    },
    input: {
      missionId: verifying.id,
    },
  });
  assert.equal(timelineResult.data?.entries.length, 7);
  assert.deepEqual(
    timelineResult.data?.entries.map((entry) => entry.type),
    ['generation', 'checklist_snapshot', 'attempt', 'environment_stamp', 'plan_change_request', 'checkpoint', 'event'],
  );

  const attemptsResult = await api.queries.getMissionAttempts({
    meta: {
      requestId: 'req-attempts-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: verifying.id,
    },
  });
  assert.equal(attemptsResult.data?.attempts[0]?.providerRunId, 'run-api-1');

  const executionResult = await api.queries.getMissionExecution({
    meta: {
      requestId: 'req-execution-1',
      correlationId: 'corr-execution-1',
      idempotencyKey: null,
    },
    input: {
      missionId: verifying.id,
    },
  });
  assert.equal(executionResult.data?.hostBindings.hostSessionId, 'session-api-1');
  assert.equal(executionResult.data?.hostBindings.providerThreadId, 'thread-api-1');
  assert.equal(executionResult.data?.hostBindings.bridgeSessionId, 'session-api-1');
  assert.equal(executionResult.data?.executionRefs.workflowPath, '/repo/.codexbridge/mission/WORKFLOW.md');
  assert.equal(
    executionResult.data?.executionRefs.workflowHash,
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  );
  assert.equal(executionResult.data?.executionRefs.resolverReason, 'explicit_override');
  assert.equal(executionResult.data?.artifactRefs[0]?.name, 'report.md');
  assert.equal(executionResult.data?.latestCycleResult?.audit.eventSeq, 1);
  assert.equal(executionResult.data?.latestEnvironmentStamp?.workspacePath, '/tmp/mission-api-existing');
  assert.equal(executionResult.data?.latestEnvironmentStamp?.gitBranch, 'track/mission-control');
  assert.equal(executionResult.data?.latestCheckpoint?.stage, 'provider.candidate_ready');
  assert.equal(executionResult.data?.loopSnapshot.status, 'verifying');
  assert.equal(executionResult.data?.loopSnapshot.currentCycle, 1);
  assert.equal(executionResult.data?.loopSnapshot.currentStage, 'verifier.repair');
  assert.equal(executionResult.data?.loopSnapshot.currentItemTitle, 'Inspect the regression');
  assert.equal(
    executionResult.data?.loopSnapshot.nextStep,
    'Retry the mission with the missing verification evidence.',
  );
  assert.equal(executionResult.data?.workflow.status, 'loaded');
  assert.equal(executionResult.data?.checklistStatus.currentItem?.title, 'Inspect the regression');
  assert.equal(executionResult.data?.workpadStatus.latestVerifierSummary, 'Verification has not finished yet.');

  const loopSnapshotResult = await api.queries.getMissionLoopSnapshot({
    meta: {
      requestId: 'req-loop-snapshot-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: verifying.id,
    },
  });
  assert.equal(loopSnapshotResult.data?.status, 'verifying');
  assert.equal(loopSnapshotResult.data?.loopStatus, 'retry');
  assert.equal(loopSnapshotResult.data?.currentCycle, 1);
  assert.equal(loopSnapshotResult.data?.currentStage, 'verifier.repair');
  assert.equal(loopSnapshotResult.data?.currentItemTitle, 'Inspect the regression');
  assert.equal(loopSnapshotResult.data?.latestBlocker, 'Waiting for the verification pass.');
  assert.equal(loopSnapshotResult.data?.latestVerifierSummary, 'Verification has not finished yet.');

  const loopSnapshotFrames = [];
  for await (const frame of api.streams.streamMissionSnapshots({
    meta: {
      requestId: 'req-loop-stream-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: verifying.id,
    },
  })) {
    loopSnapshotFrames.push(frame.data);
  }
  assert.equal(loopSnapshotFrames.length, 1);
  assert.equal(loopSnapshotFrames[0]?.currentStage, 'verifier.repair');
  assert.equal(loopSnapshotFrames[0]?.currentItemTitle, 'Inspect the regression');
});

test('direct mission control api surfaces invalid workflow state through package-owned read models', async () => {
  const { repo, api, nowRef } = createApiHarness(1_701_200_090_000);
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-api-workflow-invalid-'));
  const workflowPath = path.join(workspacePath, '.codexbridge', 'mission', 'WORKFLOW.md');
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(workflowPath, `---
version: 2
maxTurns: many
---
Broken workflow.
`);
  const queued = transitionMission(createMission({
    id: 'mission-api-invalid-workflow-1',
    source: 'manual',
    sourceRef: 'manual:invalid-workflow-1',
    platform: 'weixin',
    externalScopeId: 'wx-user-invalid-workflow-1',
    title: 'Investigate invalid workflow handling',
    goal: 'Expose workflow load failures through the package query contract.',
    expectedOutput: 'A workflow status summary.',
    acceptanceCriteria: ['Workflow error is visible'],
    plan: ['Load the workflow', 'Report the failure'],
    providerProfileId: 'codex-default',
    cwd: workspacePath,
    workflowPath,
    now: nowRef.value,
  }), 'queued', {
    at: nowRef.value + 10,
    reason: 'Mission queued for workflow status inspection.',
  });

  repo.saveMission(queued);
  repo.saveWorkItem(createMissionWorkItem(queued, { at: nowRef.value + 5 }));
  repo.saveGeneration(createMissionGeneration(queued, {
    at: nowRef.value + 5,
    trigger: 'initial',
  }));
  repo.saveChecklistSnapshot(createMissionChecklistSnapshot(queued, {
    at: nowRef.value + 6,
    generationId: queued.activeGenerationId,
  }));

  const detailResult = await api.queries.getMissionDetail({
    meta: {
      requestId: 'req-detail-invalid-workflow-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: queued.id,
    },
  });

  assert.equal(detailResult.data?.workflow.status, 'invalid');
  assert.equal(detailResult.data?.workflow.source.kind, 'file');
  assert.equal(detailResult.data?.workflow.source.path, workflowPath);
  assert.match(detailResult.data?.workflow.error ?? '', /version|maxTurns/);
});

test('direct mission control api commands persist retry, resume, and stop transitions', async () => {
  const { repo, api, nowRef } = createApiHarness(1_701_200_100_000);

  const completedBase = createQueuedMission(nowRef.value);
  const completedRunning = transitionMission(completedBase, 'running', {
    at: nowRef.value + 20,
    activeAttemptId: 'attempt-api-retry-1',
  });
  const completedVerifying = transitionMission(completedRunning, 'verifying', {
    at: nowRef.value + 30,
  });
  const completedMission = transitionMission(completedVerifying, 'completed', {
    at: nowRef.value + 40,
    reason: 'Verification passed.',
    lastResultPreview: 'Verified repair summary.',
    resultText: 'Verified repair summary.',
  });
  completedMission.attemptCount = 1;
  repo.saveMission(completedMission);
  repo.saveWorkItem(createMissionWorkItem(completedMission, { at: nowRef.value + 10 }));
  repo.saveGeneration(createMissionGeneration(completedMission, {
    at: nowRef.value + 10,
    trigger: 'initial',
  }));
  repo.saveChecklistSnapshot(createMissionChecklistSnapshot(completedMission, {
    at: nowRef.value + 11,
    generationId: completedMission.activeGenerationId,
  }));

  const retryResult = await api.commands.retryMission({
    meta: {
      requestId: 'req-retry-1',
      correlationId: 'corr-retry-1',
      idempotencyKey: 'idem-retry-1',
    },
    input: {
      missionId: completedMission.id,
      reason: 'User requested another pass.',
      providerThreadId: 'thread-api-retry-2',
      actor: {
        actorId: 'wx-user-1',
        actorType: 'user',
      },
    },
  });
  assert.equal(retryResult.data.mission.status, 'queued');
  assert.equal(retryResult.data.mission.activeGenerationIndex, 2);
  assert.equal(retryResult.data.mission.codexThreadId, 'thread-api-retry-2');
  assert.equal(repo.listGenerations(completedMission.id).length, 2);
  assert.equal(repo.listChecklistSnapshots(completedMission.id).length, 2);
  assert.equal(repo.listEvents(completedMission.id).slice(-1)[0]?.kind, 'mission.retrying');

  const waitingBase = createQueuedMission(nowRef.value + 1_000);
  const waitingRunning = transitionMission(waitingBase, 'running', {
    at: nowRef.value + 1_020,
    activeAttemptId: 'attempt-api-resume-1',
    lastResultPreview: 'Collected the target branch candidates.',
  });
  const waitingMission = transitionMission(waitingRunning, 'waiting_user', {
    at: nowRef.value + 1_030,
    reason: 'Need the user to confirm the target branch.',
    lastError: 'Need the user to confirm the target branch.',
  });
  waitingMission.attemptCount = 1;
  repo.saveMission(waitingMission);
  repo.saveWorkItem(createMissionWorkItem(waitingMission, { at: nowRef.value + 1_010 }));

  const resumeResult = await api.commands.resumeMission({
    meta: {
      requestId: 'req-resume-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: waitingMission.id,
      reason: 'User supplied the branch name.',
      actor: {
        actorId: 'wx-user-2',
        actorType: 'user',
      },
    },
  });
  assert.equal(resumeResult.data.mission.status, 'queued');
  assert.equal(resumeResult.data.mission.attemptCount, 1);
  assert.equal(repo.listEvents(waitingMission.id).slice(-1)[0]?.kind, 'mission.queued');

  const stopBase = createQueuedMission(nowRef.value + 2_000);
  const stopMission = transitionMission(stopBase, 'running', {
    at: nowRef.value + 2_020,
    activeAttemptId: 'attempt-api-stop-1',
  });
  const stopAttempt: MissionAttempt = {
    id: 'attempt-api-stop-1',
    missionId: stopMission.id,
    generationId: stopMission.activeGenerationId,
    generationIndex: stopMission.activeGenerationIndex,
    checklistSnapshotId: stopMission.currentChecklistSnapshotId,
    index: 1,
    status: 'running',
    providerRunId: 'run-api-stop-1',
    providerThreadId: 'thread-api-stop-1',
    workflowPath: stopMission.workflowPath,
    workflowHash: stopMission.workflowHash,
    resolverReason: stopMission.workflowResolverReason,
    promptDigest: 'digest-api-stop-1',
    verifierVerdict: null,
    verifierSummary: null,
    missingAcceptanceCriteria: [],
    outputPreview: null,
    error: null,
    startedAt: nowRef.value + 2_020,
    endedAt: null,
    createdAt: nowRef.value + 2_020,
    updatedAt: nowRef.value + 2_020,
  };
  repo.saveMission(stopMission);
  repo.saveWorkItem(createMissionWorkItem(stopMission, { at: nowRef.value + 2_010 }));
  repo.saveAttempt(stopAttempt);

  const stopResult = await api.commands.stopMission({
    meta: {
      requestId: 'req-stop-1',
      correlationId: 'corr-stop-1',
      idempotencyKey: null,
    },
    input: {
      missionId: stopMission.id,
      reason: 'Stop requested by the host.',
      actor: {
        actorId: 'bridge',
        actorType: 'host',
      },
    },
  });
  assert.equal(stopResult.data.mission.status, 'running');
  assert.equal(stopResult.data.mission.stopRequest?.reason, 'Stop requested by the host.');
  assert.equal(repo.getAttemptById(stopAttempt.id)?.status, 'running');
  assert.equal(repo.getMissionById(stopMission.id)?.stopRequest?.actorType, 'host');
  assert.deepEqual(
    repo.listEvents(stopMission.id).slice(-1).map((event) => event.kind),
    ['mission.stop_requested'],
  );

  const pausedStopBase = createQueuedMission(nowRef.value + 3_000);
  const pausedStopRunning = transitionMission(pausedStopBase, 'running', {
    at: nowRef.value + 3_020,
    activeAttemptId: 'attempt-api-stop-paused-1',
  });
  const pausedStopMission = transitionMission(pausedStopRunning, 'waiting_user', {
    at: nowRef.value + 3_030,
    reason: 'Need the deployment window.',
    lastError: 'Need the deployment window.',
  });
  const pausedStopAttempt: MissionAttempt = {
    id: 'attempt-api-stop-paused-1',
    missionId: pausedStopMission.id,
    generationId: pausedStopMission.activeGenerationId,
    generationIndex: pausedStopMission.activeGenerationIndex,
    checklistSnapshotId: pausedStopMission.currentChecklistSnapshotId,
    index: 1,
    status: 'waiting_user',
    providerRunId: 'run-api-stop-paused-1',
    providerThreadId: 'thread-api-stop-paused-1',
    workflowPath: pausedStopMission.workflowPath,
    workflowHash: pausedStopMission.workflowHash,
    resolverReason: pausedStopMission.workflowResolverReason,
    promptDigest: 'digest-api-stop-paused-1',
    verifierVerdict: null,
    verifierSummary: 'Need the deployment window.',
    missingAcceptanceCriteria: [],
    outputPreview: 'Waiting for the deployment window.',
    error: 'Need the deployment window.',
    startedAt: nowRef.value + 3_020,
    endedAt: nowRef.value + 3_030,
    createdAt: nowRef.value + 3_020,
    updatedAt: nowRef.value + 3_030,
  };
  repo.saveMission(pausedStopMission);
  repo.saveWorkItem(createMissionWorkItem(pausedStopMission, { at: nowRef.value + 3_010 }));
  repo.saveAttempt(pausedStopAttempt);

  const pausedStopResult = await api.commands.stopMission({
    meta: {
      requestId: 'req-stop-2',
      correlationId: 'corr-stop-2',
      idempotencyKey: null,
    },
    input: {
      missionId: pausedStopMission.id,
      reason: 'Stop the paused mission instead of resuming it.',
      actor: {
        actorId: 'bridge',
        actorType: 'host',
      },
    },
  });
  assert.equal(pausedStopResult.data.mission.status, 'stopped');
  assert.equal(pausedStopResult.data.mission.stopRequest, null);
  assert.deepEqual(
    repo.listEvents(pausedStopMission.id).slice(-2).map((event) => event.kind),
    ['mission.stop_requested', 'mission.stopped'],
  );
});

test('direct mission control api stream emits detail first and then timeline history', async () => {
  const { repo, api, nowRef } = createApiHarness(1_701_200_200_000);
  const queued = createQueuedMission(nowRef.value);
  const waiting = createMissionResumeSnapshot(transitionMission(transitionMission(queued, 'running', {
    at: nowRef.value + 20,
    activeAttemptId: 'attempt-api-stream-1',
  }), 'waiting_user', {
    at: nowRef.value + 30,
    reason: 'Need the branch name.',
    lastError: 'Need the branch name.',
  }), {
    at: nowRef.value + 40,
    reason: 'User supplied the branch name.',
  });
  repo.saveMission(waiting);
  repo.saveWorkItem(createMissionWorkItem(waiting, { at: nowRef.value + 10 }));
  repo.saveGeneration(createMissionGeneration(waiting, {
    at: nowRef.value + 10,
    trigger: 'initial',
  }));
  repo.saveChecklistSnapshot(createMissionChecklistSnapshot(waiting, {
    at: nowRef.value + 11,
    generationId: waiting.activeGenerationId,
  }));

  const frames: string[] = [];
  for await (const frame of api.streams.streamMission({
    meta: {
      requestId: 'req-stream-1',
      correlationId: 'corr-stream-1',
      idempotencyKey: null,
    },
    input: {
      missionId: waiting.id,
      includeHistory: true,
    },
  })) {
    frames.push(frame.data.type);
  }

  assert.deepEqual(frames, ['detail', 'timeline_entry', 'timeline_entry']);
});
