import assert from 'node:assert/strict';
import test from 'node:test';
import { AutomationJobService } from '../../src/core/automation_job_service.js';

test('AutomationJobService reclaims stale running jobs before claiming due work', () => {
  const jobs = new Map<string, any>([
    ['job-1', {
      id: 'job-1',
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      title: '助理检查提醒',
      mode: 'standalone',
      providerProfileId: 'openai-default',
      bridgeSessionId: 'session-1',
      cwd: '/tmp/codexbridge',
      prompt: '检查代办',
      locale: 'zh-CN',
      schedule: {
        kind: 'daily',
        hour: 13,
        minute: 0,
        timeZone: 'UTC',
        label: 'daily 13:00 UTC',
      },
      status: 'active',
      running: true,
      nextRunAt: 5_000,
      lastRunAt: null,
      lastDeliveredAt: null,
      lastResultPreview: null,
      lastError: null,
      createdAt: 1_000,
      updatedAt: 7_000,
    }],
  ]);

  const repository = {
    list() {
      return [...jobs.values()];
    },
    getById(id: string) {
      return jobs.get(id) ?? null;
    },
    save(job: any) {
      jobs.set(job.id, {
        ...job,
      });
    },
    delete(id: string) {
      jobs.delete(id);
    },
  };

  const service = new AutomationJobService({
    automationJobs: repository as any,
    now: () => 10_000,
    staleRunningMs: 2_000,
  });

  const claimed = service.claimDueJobs('weixin');
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]?.id, 'job-1');
  assert.equal(jobs.get('job-1')?.running, true);
  assert.equal(jobs.get('job-1')?.updatedAt, 10_000);
});

test('AutomationJobService strips legacy mission compatibility fields from automation jobs', () => {
  const jobs = new Map<string, any>([
    ['job-legacy', {
      id: 'job-legacy',
      platform: 'weixin',
      externalScopeId: 'wxid_legacy',
      title: '巡检任务',
      mode: 'standalone',
      providerProfileId: 'openai-default',
      bridgeSessionId: 'session-legacy',
      cwd: '/tmp/codexbridge',
      prompt: '检查运行状态',
      locale: 'zh-CN',
      schedule: {
        kind: 'interval',
        everySeconds: 300,
        label: 'every 5m',
      },
      status: 'active',
      running: false,
      nextRunAt: 5_000,
      lastRunAt: null,
      lastDeliveredAt: null,
      lastResultPreview: null,
      lastError: null,
      missionWorkflowPath: '/repo/.codexbridge/mission/WORKFLOW.md',
      missionWorkflowSourceLabel: 'configured workflow',
      missionWorkpadLatestBlocker: 'stale blocker',
      missionWorkpadLatestVerifierSummary: 'stale verifier',
      missionWorkpadFinalResultSummary: 'stale final summary',
      missionAttemptHistory: [{ attempt: 1, status: 'completed' }],
      missionRuntimeState: { mission: { status: 'completed' }, attempts: [], events: [] },
      createdAt: 1_000,
      updatedAt: 1_000,
    }],
  ]);

  const repository = {
    list() {
      return [...jobs.values()];
    },
    getById(id: string) {
      return jobs.get(id) ?? null;
    },
    save(job: any) {
      jobs.set(job.id, {
        ...job,
      });
      return job;
    },
    delete(id: string) {
      jobs.delete(id);
    },
  };

  const service = new AutomationJobService({
    automationJobs: repository as any,
    now: () => 2_000,
  });

  const loaded = service.getById('job-legacy') as any;
  assert.ok(loaded);
  assert.equal('missionRuntimeState' in loaded, false);
  assert.equal('missionAttemptHistory' in loaded, false);
  assert.equal('missionWorkflowPath' in loaded, false);

  service.completeJob('job-legacy', {
    resultPreview: '执行完成',
    error: null,
    deliveredAt: 2_000,
  });

  const persisted = jobs.get('job-legacy');
  assert.equal('missionRuntimeState' in persisted, false);
  assert.equal('missionAttemptHistory' in persisted, false);
  assert.equal('missionWorkflowPath' in persisted, false);
  assert.equal(persisted.lastResultPreview, '执行完成');
});
