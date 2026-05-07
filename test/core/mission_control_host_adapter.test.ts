import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexBridgeMissionHostAdapter } from '../../src/core/mission_control_host_adapter.js';
import type { AgentJob, BridgeSession } from '../../src/types/core.js';

function createAgentJob(): AgentJob {
  return {
    id: 'job-host-adapter-1',
    platform: 'weixin',
    externalScopeId: 'wx-host-adapter-1',
    title: 'Host adapter test',
    originalInput: 'run the mission',
    goal: 'Finish the mission',
    expectedOutput: 'A verified result',
    plan: ['Inspect', 'Patch', 'Verify'],
    category: 'code',
    riskLevel: 'medium',
    mode: 'codex',
    providerProfileId: 'codex-default',
    bridgeSessionId: 'session-host-adapter-1',
    cwd: '/repo',
    locale: 'zh-CN',
    status: 'queued',
    running: false,
    stopRequested: false,
    maxAttempts: 2,
    attemptCount: 0,
    lastRunAt: null,
    completedAt: null,
    lastResultPreview: null,
    resultText: null,
    resultArtifacts: null,
    lastError: null,
    verificationSummary: null,
    missionWorkflowPath: null,
    missionWorkflowSourceLabel: null,
    missionWorkpadLatestBlocker: null,
    missionWorkpadLatestVerifierSummary: null,
    missionWorkpadFinalResultSummary: null,
    missionAttemptHistory: [],
    missionRuntimeState: null,
    createdAt: 1_701_300_000_000,
    updatedAt: 1_701_300_000_000,
  };
}

function createBridgeSession(): BridgeSession {
  return {
    id: 'session-host-adapter-1',
    providerProfileId: 'codex-default',
    codexThreadId: 'thread-host-adapter-1',
    cwd: '/repo',
    title: 'Host adapter thread',
    createdAt: 1_701_300_000_000,
    updatedAt: 1_701_300_000_000,
  };
}

test('CodexBridgeMissionHostAdapter forwards context, binding, progress, and approvals through the host boundary', async () => {
  const job = createAgentJob();
  const session = createBridgeSession();
  const bound: Array<{
    missionId: string;
    hostSessionId: string | null;
    bridgeSessionId?: string | null;
    providerThreadId: string | null;
  }> = [];
  const progress: Array<Record<string, unknown>> = [];
  const approvals: Array<Record<string, unknown>> = [];

  const adapter = new CodexBridgeMissionHostAdapter({
    jobId: job.id,
    resolveJob: () => job,
    resolveSession: () => session,
    bindThread: async (binding) => {
      bound.push(binding);
    },
    onProgress: async (update) => {
      progress.push(update as unknown as Record<string, unknown>);
    },
    onApprovalRequest: async (request) => {
      approvals.push(request as unknown as Record<string, unknown>);
    },
  });

  const context = await adapter.getContext(job.id);
  assert.equal(context.hostSessionId, session.id);
  assert.equal(context.bridgeSessionId, session.id);
  assert.equal(context.providerThreadId, session.codexThreadId);
  assert.equal(context.locale, 'zh-CN');

  await adapter.bindProviderThread({
    missionId: job.id,
    hostSessionId: 'session-host-adapter-2',
    providerThreadId: 'thread-host-adapter-2',
  });
  assert.deepEqual(bound[0], {
    missionId: job.id,
    hostSessionId: 'session-host-adapter-2',
    bridgeSessionId: 'session-host-adapter-2',
    providerThreadId: 'thread-host-adapter-2',
  });

  await adapter.publishProgress({
    missionId: job.id,
    attemptId: 'attempt-host-adapter-1',
    status: 'running',
    text: 'Mission is running.',
    outputKind: 'commentary',
  });
  assert.equal(progress[0]?.text, 'Mission is running.');
  assert.equal(progress[0]?.delta, 'Mission is running.');
  assert.equal(progress[0]?.outputKind, 'commentary');

  await adapter.requestApproval({
    missionId: job.id,
    attemptId: 'attempt-host-adapter-1',
    requestId: 'approval-host-adapter-1',
    kind: 'provider',
    summary: 'Need approval to run npm test.',
    options: [
      { index: 1, label: 'approve' },
      { index: 2, label: 'deny' },
    ],
    details: {
      command: 'npm test',
      cwd: '/repo',
      turnId: 'turn-host-adapter-1',
      fileWritePermissions: ['/repo'],
    },
  });
  assert.equal(approvals[0]?.requestId, 'approval-host-adapter-1');
  assert.equal(approvals[0]?.kind, 'command');
  assert.equal(approvals[0]?.threadId, session.codexThreadId);
  assert.equal(approvals[0]?.command, 'npm test');
  assert.deepEqual(approvals[0]?.fileWritePermissions, ['/repo']);
});
