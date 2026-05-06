import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AutomationJobService } from '../../src/core/automation_job_service.js';
import { runAutomationJobWithMissionControl } from '../../src/core/mission_control_automation_job_runner.js';
import { InMemoryAutomationJobRepository } from '../../src/store/in_memory/in_memory_automation_job_repository.js';

test('automation mission runner persists rebound bridge sessions across continuation turns', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-auto-mission-cwd-'));
  const repository = new InMemoryAutomationJobRepository();
  const sessions = new Map<string, any>([
    ['session-auto-1', {
      id: 'session-auto-1',
      providerProfileId: 'openai-default',
      codexThreadId: 'thread-auto-1',
      cwd,
      title: 'Automation 1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
    ['session-auto-2', {
      id: 'session-auto-2',
      providerProfileId: 'openai-default',
      codexThreadId: 'thread-auto-2',
      cwd,
      title: 'Automation 2',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
  ]);
  const automationJobs = new AutomationJobService({
    automationJobs: repository,
    bridgeSessions: {
      getSessionById(bridgeSessionId: string) {
        return sessions.get(bridgeSessionId) ?? null;
      },
    },
  });
  const job = automationJobs.createJob({
    scopeRef: {
      platform: 'weixin',
      externalScopeId: 'wx-auto-runner-1',
    },
    title: '部署巡检',
    mode: 'standalone',
    providerProfileId: 'openai-default',
    bridgeSessionId: 'session-auto-1',
    cwd,
    prompt: '检查部署状态并返回摘要',
    locale: 'zh-CN',
    schedule: {
      kind: 'interval',
      everySeconds: 300,
      label: 'every 5m',
    },
  });

  const seenSessionIds: string[] = [];
  let callCount = 0;
  const run = await runAutomationJobWithMissionControl({
    job,
    automationJobs,
    resolveSession: (liveJob) => automationJobs.getSession(liveJob),
    startTurnWithRecovery: async (_scopeRef, session) => {
      callCount += 1;
      seenSessionIds.push(session.id);
      if (callCount === 1) {
        return {
          session: sessions.get('session-auto-2'),
          result: {
            outputText: '',
            previewText: 'Still collecting deployment details.',
            outputState: 'partial',
            finalSource: 'test',
          },
        };
      }
      return {
        session: sessions.get('session-auto-2'),
        result: {
          outputText: '部署状态已确认，最终摘要如下。',
          previewText: '部署状态已确认，最终摘要如下。',
          outputState: 'complete',
          finalSource: 'test',
        },
      };
    },
    stopSession: async () => {},
  });

  const finalJob = automationJobs.requireById(job.id);
  assert.deepEqual(seenSessionIds, ['session-auto-1', 'session-auto-2']);
  assert.equal(finalJob.bridgeSessionId, 'session-auto-2');
  assert.equal(run.finalSession?.id, 'session-auto-2');
  assert.equal(run.runResult.mission.status, 'completed');
  assert.equal(finalJob.missionAttemptHistory?.length, 1);
  assert.equal(finalJob.missionWorkpadLatestVerifierSummary, 'Scheduled automation produced a deliverable result.');
  assert.equal(run.finalBridgeResult?.outputText, '部署状态已确认，最终摘要如下。');
});
