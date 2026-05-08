import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DirectMissionControlApi,
  InMemoryMissionRepository,
  MissionLeaseCoordinator,
  MissionRuntime,
  MissionWorkspaceService,
  createMissionVerifierResult,
  createNoopMissionHostAdapter,
  type MissionHostArtifactPublication,
  type MissionHostNotification,
  type MissionHostProgressUpdate,
  type MissionHostThreadBinding,
  type MissionProvider,
  type MissionVerifier,
} from '../src/index.js';

test('package-owned mission contracts can drive a later non-CodexBridge host without changing mission core behavior', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-cli-proof-cwd-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-cli-proof-root-'));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-cli-proof-artifacts-'));
  const artifactPath = path.join(artifactDir, 'cli-host-proof.md');
  fs.writeFileSync(artifactPath, '# CLI host proof\n', 'utf8');

  const repository = new InMemoryMissionRepository();
  const nowRef = { value: 1_701_900_000_000 };
  let generatedIdCounter = 0;
  const api = new DirectMissionControlApi({
    repository,
    now: () => nowRef.value,
    generateId: () => `cli-proof-event-${generatedIdCounter++}`,
  });

  const progressUpdates: MissionHostProgressUpdate[] = [];
  const threadBindings: MissionHostThreadBinding[] = [];
  const artifactPublications: MissionHostArtifactPublication[] = [];
  const notifications: MissionHostNotification[] = [];

  const hostAdapter = createNoopMissionHostAdapter({
    async getContext(missionId) {
      return {
        missionId,
        platform: 'cli',
        externalScopeId: 'cli-user-proof-1',
        hostSessionId: 'cli-session-proof-1',
        bridgeSessionId: null,
        providerThreadId: null,
        actorId: 'cli-user-proof-1',
        actorDisplayName: 'CLI Proof User',
        locale: 'en-US',
        authContext: {
          kind: 'local-cli',
        },
        metadata: {
          host: 'cli-proof',
        },
      };
    },
    async bindProviderThread(input) {
      threadBindings.push(structuredClone(input));
    },
    async publishProgress(update) {
      progressUpdates.push(structuredClone(update));
    },
    async publishArtifacts(publication) {
      artifactPublications.push(structuredClone(publication));
    },
    async notify(notification) {
      notifications.push(structuredClone(notification));
    },
  });

  await api.commands.createMission({
    meta: {
      requestId: 'req-cli-proof-create-1',
      correlationId: 'corr-cli-proof-create-1',
      idempotencyKey: 'idem-cli-proof-create-1',
    },
    input: {
      missionId: 'mission-cli-proof-1',
      workItem: {
        source: 'manual',
        sourceRef: 'manual:cli-proof-1',
        sourceRevision: 'cli-proof-rev-1',
        title: 'Prove the host-neutral runtime contract',
        goal: 'Run Mission Control from a CLI host without CodexBridge runtime imports.',
        expectedOutput: 'A verified CLI host proof.',
        acceptanceCriteria: [
          'Mission completes through the package runtime',
        ],
        plan: [
          'Create the mission through the package API',
          'Run the provider and verifier through a generic host adapter',
          'Read the result back through package queries and streams',
        ],
        metadata: {
          surface: 'cli-proof',
        },
      },
      platform: 'cli',
      externalScopeId: 'cli-user-proof-1',
      providerProfileId: 'codex-default',
      hostSessionId: 'cli-session-proof-1',
      cwd,
      initialStatus: 'queued',
      maxAttempts: 2,
      maxTurns: 4,
      reason: 'CLI host queued a mission through the package contract.',
      actor: {
        actorId: 'cli-proof-host',
        actorType: 'host',
      },
    },
  });

  const createdExecution = api.queries.getMissionExecution({
    meta: {
      requestId: 'req-cli-proof-execution-before-run',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-cli-proof-1',
    },
  }).data;
  assert.equal(createdExecution?.hostBindings.platform, 'cli');
  assert.equal(createdExecution?.hostBindings.hostSessionId, 'cli-session-proof-1');
  assert.equal(createdExecution?.hostBindings.providerThreadId, null);

  const provider: MissionProvider = {
    kind: 'cli-proof-provider',
    async start(input) {
      const context = await hostAdapter.getContext(input.mission.id);
      assert.equal(context.platform, 'cli');
      assert.equal(context.hostSessionId, 'cli-session-proof-1');
      assert.equal(context.providerThreadId, null);
      await hostAdapter.publishProgress({
        missionId: input.mission.id,
        attemptId: input.attempt.id,
        status: 'running',
        text: 'CLI host dispatched the mission through the package runtime.',
        outputKind: 'commentary',
        details: {
          workflowPath: input.workflow.source.path,
        },
      });
      const binding: MissionHostThreadBinding = {
        missionId: input.mission.id,
        hostSessionId: context.hostSessionId,
        providerThreadId: 'thread-cli-proof-1',
      };
      await hostAdapter.bindProviderThread(binding);
      return {
        providerRunId: 'run-cli-proof-1',
        providerThreadId: binding.providerThreadId,
        previewText: 'CLI host dispatched the mission.',
      };
    },
    async continue() {
      throw new Error('continuation is not expected in the host-neutral proof');
    },
    async wait(runId) {
      assert.equal(runId, 'run-cli-proof-1');
      nowRef.value += 100;
      return {
        outcome: 'completed',
        text: 'CLI host proof completed through the package runtime.',
        artifacts: [
          {
            type: 'file',
            name: 'cli-host-proof.md',
            path: artifactPath,
            mimeType: 'text/markdown',
            caption: 'CLI host proof artifact',
          },
        ],
        previewText: 'CLI host proof completed.',
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
      assert.equal(input.mission.platform, 'cli');
      assert.equal(input.mission.bridgeSessionId, 'cli-session-proof-1');
      assert.equal(input.providerResult.artifacts.length, 1);
      await hostAdapter.publishProgress({
        missionId: input.mission.id,
        attemptId: input.attempt.id,
        status: 'verifying',
        text: 'CLI host is verifying the acceptance criteria.',
        outputKind: 'status',
        details: {
          activeChecklistItem: input.activeChecklistItem?.title ?? null,
        },
      });
      await hostAdapter.publishArtifacts({
        missionId: input.mission.id,
        attemptId: input.attempt.id,
        artifacts: input.providerResult.artifacts,
      });
      return createMissionVerifierResult({
        verdict: 'complete',
        summary: 'CLI host proof accepted through the package-owned verifier contract.',
      });
    },
  };

  const runtime = new MissionRuntime({
    repository,
    provider,
    verifier,
    hostAdapter,
    workspaceService: new MissionWorkspaceService({
      rootDir,
      host: 'cli-proof-host',
      now: () => nowRef.value,
    }),
    leaseCoordinator: new MissionLeaseCoordinator(repository, {
      defaultTtlMs: 60_000,
      maxConcurrentMissions: 1,
      now: () => nowRef.value,
    }),
    now: () => nowRef.value,
    generateId: () => `cli-proof-generated-${generatedIdCounter++}`,
  });

  const runResult = await runtime.runMission('mission-cli-proof-1', {
    ownerId: 'cli-proof-host',
    readOnly: true,
    allowSharedCwd: true,
  });

  assert.equal(runResult.mission.status, 'completed');
  assert.equal(runResult.mission.resultText, 'CLI host proof completed through the package runtime.');
  assert.equal(runResult.latestCycleResult?.status, 'done');

  const summaries = api.queries.listMissionSummaries({
    meta: {
      requestId: 'req-cli-proof-list-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      filter: {
        platform: 'cli',
        externalScopeId: 'cli-user-proof-1',
      },
    },
  }).data;
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.mission.status, 'completed');

  const detail = api.queries.getMissionDetail({
    meta: {
      requestId: 'req-cli-proof-detail-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-cli-proof-1',
    },
  }).data;
  assert.equal(detail?.hostBindings.hostSessionId, 'cli-session-proof-1');
  assert.equal(detail?.hostBindings.providerThreadId, 'thread-cli-proof-1');
  assert.equal(detail?.hostBindings.bridgeSessionId, 'cli-session-proof-1');
  assert.equal(detail?.artifactRefs[0]?.path, artifactPath);
  assert.equal(detail?.latestVerifierSummary, 'CLI host proof accepted through the package-owned verifier contract.');
  assert.equal(detail?.loopSnapshot.status, 'completed');
  assert.equal(detail?.loopSnapshot.currentCycle, 3);
  assert.equal(detail?.loopSnapshot.currentStage, 'verifier.complete');
  assert.equal(detail?.loopSnapshot.overallCompletion, 100);

  const execution = api.queries.getMissionExecution({
    meta: {
      requestId: 'req-cli-proof-execution-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-cli-proof-1',
    },
  }).data;
  assert.equal(execution?.executionRefs.providerRunId, 'run-cli-proof-1');
  assert.equal(execution?.executionRefs.providerThreadId, 'thread-cli-proof-1');
  assert.equal(execution?.hostBindings.platform, 'cli');
  assert.equal(execution?.artifactRefs[0]?.name, 'cli-host-proof.md');
  assert.equal(execution?.loopSnapshot.loopStatus, 'done');
  assert.equal(
    execution?.loopSnapshot.nextStep,
    null,
  );

  const loopSnapshot = api.queries.getMissionLoopSnapshot({
    meta: {
      requestId: 'req-cli-proof-loop-snapshot-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-cli-proof-1',
    },
  }).data;
  assert.equal(loopSnapshot?.status, 'completed');
  assert.equal(loopSnapshot?.loopStatus, 'done');
  assert.equal(loopSnapshot?.overallCompletion, 100);

  const streamFrameTypes: string[] = [];
  for await (const frame of api.streams.streamMission({
    meta: {
      requestId: 'req-cli-proof-stream-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-cli-proof-1',
      includeHistory: true,
    },
  })) {
    streamFrameTypes.push(frame.data.type);
  }
  assert.equal(streamFrameTypes[0], 'detail');
  assert.ok(streamFrameTypes.includes('timeline_entry'));

  const streamedSnapshots = [];
  for await (const frame of api.streams.streamMissionSnapshots({
    meta: {
      requestId: 'req-cli-proof-stream-snapshot-1',
      correlationId: null,
      idempotencyKey: null,
    },
    input: {
      missionId: 'mission-cli-proof-1',
    },
  })) {
    streamedSnapshots.push(frame.data);
  }
  assert.equal(streamedSnapshots.length, 1);
  assert.equal(streamedSnapshots[0]?.currentStage, 'verifier.complete');

  assert.deepEqual(progressUpdates.map((update) => update.status), [
    'running',
    'verifying',
    'running',
    'verifying',
    'running',
    'verifying',
  ]);
  assert.deepEqual(threadBindings, [
    {
      missionId: 'mission-cli-proof-1',
      hostSessionId: 'cli-session-proof-1',
      providerThreadId: 'thread-cli-proof-1',
    },
    {
      missionId: 'mission-cli-proof-1',
      hostSessionId: 'cli-session-proof-1',
      providerThreadId: 'thread-cli-proof-1',
    },
    {
      missionId: 'mission-cli-proof-1',
      hostSessionId: 'cli-session-proof-1',
      providerThreadId: 'thread-cli-proof-1',
    },
  ]);
  assert.equal(artifactPublications.length, 3);
  assert.equal(artifactPublications.every((publication) => publication.artifacts[0]?.path === artifactPath), true);
  assert.equal(notifications.length, 3);
  assert.equal(notifications.at(-1)?.status, 'completed');
  assert.equal(notifications.at(-1)?.kind, 'cycle_update');
  assert.equal(notifications.at(-1)?.loopSnapshot?.currentStage, 'verifier.complete');
  assert.equal(notifications.at(-1)?.cycleResult?.status, 'done');
});
