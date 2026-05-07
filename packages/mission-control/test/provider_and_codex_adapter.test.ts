import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CodexMissionProvider,
  MissionWorkspaceService,
  applyMissionProviderStartToAttempt,
  canScheduleMissionContinuation,
  createMission,
  mapMissionProviderResultToMissionStatus,
  normalizeCodexMissionDriverResult,
  toCodexMissionDriverExecutionInput,
  transitionMission,
} from '../src/index.js';
import type { LoadedMissionWorkflow, MissionAttempt } from '../src/index.js';

test('provider helpers persist provider ids on attempts and map terminal outcomes into mission states', () => {
  const attempt: MissionAttempt = {
    id: 'attempt-provider-1',
    missionId: 'mission-provider-1',
    index: 1,
    status: 'running',
    providerRunId: null,
    providerThreadId: null,
    promptDigest: null,
    verifierVerdict: null,
    verifierSummary: null,
    missingAcceptanceCriteria: [],
    outputPreview: null,
    error: null,
    startedAt: null,
    endedAt: null,
    createdAt: 1_700_600_000_000,
    updatedAt: 1_700_600_000_000,
  };

  const linked = applyMissionProviderStartToAttempt(attempt, {
    providerRunId: 'run-provider-1',
    providerThreadId: 'thread-provider-1',
  }, 1_700_600_000_100);
  assert.equal(linked.providerRunId, 'run-provider-1');
  assert.equal(linked.providerThreadId, 'thread-provider-1');
  assert.equal(linked.startedAt, 1_700_600_000_100);

  const complete = normalizeCodexMissionDriverResult({
    outputState: 'complete',
    outputText: 'Patched and verified locally.',
    previewText: 'Patched and verified locally.',
  });
  assert.equal(mapMissionProviderResultToMissionStatus(complete), 'verifying');
  assert.equal(complete.continuationEligible, true);

  const interrupted = normalizeCodexMissionDriverResult({
    outputState: 'interrupted',
    previewText: 'Stopped by user.',
  });
  assert.equal(mapMissionProviderResultToMissionStatus(interrupted), 'stopped');
  assert.equal(interrupted.continuationEligible, false);

  const blocked = normalizeCodexMissionDriverResult({
    requiresHuman: true,
    handoffState: 'needs_human',
    previewText: 'Approval required.',
  });
  assert.equal(mapMissionProviderResultToMissionStatus(blocked), 'needs_human');
});

test('continuation scheduling only applies to active missions with remaining budget', () => {
  const eligible = normalizeCodexMissionDriverResult({
    outputState: 'complete',
    outputText: 'Candidate output.',
  });

  assert.equal(canScheduleMissionContinuation({
    missionStatus: 'running',
    remainingAttempts: 1,
    result: eligible,
  }), true);

  assert.equal(canScheduleMissionContinuation({
    missionStatus: 'completed',
    remainingAttempts: 1,
    result: eligible,
  }), false);

  assert.equal(canScheduleMissionContinuation({
    missionStatus: 'running',
    remainingAttempts: 0,
    result: eligible,
  }), false);
});

test('CodexMissionProvider reuses provider profile, thread binding, and workspace assignment safely', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-provider-cwd-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-provider-root-'));
  const mission = transitionMission(
    transitionMission(createMission({
      id: 'mission-provider-2',
      source: 'weixin',
      platform: 'weixin',
      externalScopeId: 'wx-provider-2',
      title: 'Repair provider adapter',
      goal: 'Repair the provider adapter and summarize the result.',
      expectedOutput: 'A provider adapter summary.',
      providerProfileId: 'codex-default',
      cwd,
      codexThreadId: 'thread-bound-mission',
      now: 1_700_600_100_000,
    }), 'queued', {
      at: 1_700_600_100_050,
    }),
    'running',
    {
      at: 1_700_600_100_100,
      activeAttemptId: 'attempt-provider-2',
    },
  );

  const attempt: MissionAttempt = {
    id: 'attempt-provider-2',
    missionId: mission.id,
    index: 2,
    status: 'running',
    providerRunId: 'run-existing',
    providerThreadId: 'thread-existing-attempt',
    promptDigest: 'digest-provider-2',
    verifierVerdict: null,
    verifierSummary: null,
    missingAcceptanceCriteria: [],
    outputPreview: null,
    error: null,
    startedAt: 1_700_600_100_100,
    endedAt: null,
    createdAt: 1_700_600_100_000,
    updatedAt: 1_700_600_100_100,
  };

  const workflow: LoadedMissionWorkflow = {
    source: {
      kind: 'built-in-default',
      path: path.join(cwd, '.codexbridge', 'mission', 'WORKFLOW.md'),
      label: 'built-in defaults',
    },
    policy: {
      version: 1,
      maxTurns: null,
      maxAttempts: null,
      maxRuntimeMs: null,
      maxArtifactCount: null,
      maxArtifactBytes: null,
      continuation: 'allow',
      requirePlanUpdate: true,
      requireWorkpadUpdate: true,
      defaultHandoffState: 'needs_human',
      stopConditions: [],
      finalReportSections: ['summary', 'verification', 'artifacts', 'next_steps'],
      promptBody: 'Do the work.',
    },
    rawFrontMatter: {},
    rawText: 'Do the work.',
  };

  const workspaceService = new MissionWorkspaceService({
    rootDir,
    host: 'provider-host',
    now: () => 1_700_600_100_200,
  });
  const workspace = workspaceService.ensureWorkspace(mission);

  const seen: Array<{ mode: 'start' | 'continue'; input: ReturnType<typeof toCodexMissionDriverExecutionInput> }> = [];
  const provider = new CodexMissionProvider({
    async start(input) {
      seen.push({ mode: 'start', input });
      return {
        providerRunId: 'run-started',
        providerThreadId: input.threadId,
      };
    },
    async continue(input) {
      seen.push({ mode: 'continue', input });
      return {
        providerRunId: 'run-continued',
        providerThreadId: input.threadId,
      };
    },
    async wait() {
      return {
        outputState: 'complete',
        outputText: 'Verified result.',
      };
    },
    async interrupt() {},
  });

  await provider.start({
    mission,
    attempt,
    workflow,
    workspace,
    promptText: 'Attempt prompt.',
  });
  await provider.continue({
    mission,
    attempt,
    workflow,
    workspace,
    promptText: 'Attempt prompt.',
  });

  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.input.providerProfileId, 'codex-default');
  assert.equal(seen[0]?.input.threadId, 'thread-existing-attempt');
  assert.equal(seen[0]?.input.workspacePath, workspace.workspacePath);
  assert.equal(seen[1]?.mode, 'continue');
  assert.equal(seen[1]?.input.workflowPath, workflow.source.path);
});
