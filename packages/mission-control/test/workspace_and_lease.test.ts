import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  JsonFileMissionRepository,
  MissionConcurrentLimitError,
  MissionLeaseConflictError,
  MissionLeaseCoordinator,
  MissionWorkspaceService,
  createMission,
  transitionMission,
} from '../src/index.js';

test('workspace service creates deterministic isolated mission workspaces and default layout', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-workspace-root-'));
  const service = new MissionWorkspaceService({
    rootDir,
    host: 'workspace-host',
    now: () => 1_700_300_000_000,
  });
  const mission = createMission({
    id: 'mission-workspace-1',
    source: 'weixin',
    platform: 'weixin',
    externalScopeId: 'wx-workspace-1',
    title: 'Patch preview bug',
    goal: 'Patch the preview bug and verify the result.',
    expectedOutput: 'Verified patch summary.',
    providerProfileId: 'codex-default',
    cwd: '/repo',
    now: 1_700_300_000_000,
  });

  const first = service.ensureWorkspace(mission);
  const second = service.ensureWorkspace(mission);

  assert.equal(first.mode, 'isolated');
  assert.equal(first.workspacePath, second.workspacePath);
  assert.equal(first.workspacePath, path.join(rootDir, 'workspaces', mission.id));
  assert.equal(first.artifactsPath, path.join(rootDir, 'artifacts', mission.id));
  assert.equal(first.logPath, path.join(rootDir, 'logs', `${mission.id}.jsonl`));
  assert.equal(fs.existsSync(first.layout.workflowsDir), true);
  assert.equal(fs.existsSync(first.workspacePath), true);
  assert.equal(first.environmentStamp.host, 'workspace-host');
  assert.equal(first.environmentStamp.mode, 'isolated');
});

test('workspace service can reuse bound cwd for explicit read-only missions', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-workspace-shared-'));
  const sharedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-shared-cwd-'));
  const service = new MissionWorkspaceService({
    rootDir,
    host: 'workspace-host',
    now: () => 1_700_300_100_000,
  });
  const mission = createMission({
    id: 'mission-workspace-2',
    source: 'manual',
    platform: 'weixin',
    externalScopeId: 'wx-workspace-2',
    title: 'Read-only audit',
    goal: 'Inspect logs and summarize the audit.',
    expectedOutput: 'Read-only audit summary.',
    providerProfileId: 'codex-default',
    cwd: sharedCwd,
    now: 1_700_300_100_000,
  });

  const assignment = service.ensureWorkspace(mission, {
    readOnly: true,
    allowSharedCwd: true,
  });

  assert.equal(assignment.mode, 'shared-cwd');
  assert.equal(assignment.workspacePath, sharedCwd);
  assert.equal(assignment.artifactsPath, path.join(rootDir, 'artifacts', mission.id));
  assert.equal(assignment.logPath, path.join(rootDir, 'logs', `${mission.id}.jsonl`));
  assert.equal(assignment.environmentStamp.mode, 'shared-cwd');
});

test('lease coordinator enforces concurrent limits, conflict checks, and heartbeat updates', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-lease-active-'));
  const repo = new JsonFileMissionRepository(stateDir);
  const missionA = transitionMission(createMission({
    id: 'mission-lease-1',
    source: 'weixin',
    platform: 'weixin',
    externalScopeId: 'wx-lease-1',
    title: 'Mission A',
    goal: 'Run mission A.',
    expectedOutput: 'Mission A output.',
    providerProfileId: 'codex-default',
    now: 1_700_400_000_000,
  }), 'queued', { at: 1_700_400_000_010 });
  const missionB = transitionMission(createMission({
    id: 'mission-lease-2',
    source: 'weixin',
    platform: 'weixin',
    externalScopeId: 'wx-lease-2',
    title: 'Mission B',
    goal: 'Run mission B.',
    expectedOutput: 'Mission B output.',
    providerProfileId: 'codex-default',
    now: 1_700_400_000_000,
  }), 'queued', { at: 1_700_400_000_020 });
  repo.saveMission(missionA);
  repo.saveMission(missionB);

  let now = 1_700_400_000_100;
  const coordinator = new MissionLeaseCoordinator(repo, {
    defaultTtlMs: 1_500,
    maxConcurrentMissions: 1,
    now: () => now,
  });

  const claimedA = coordinator.claimMission(missionA.id, {
    ownerId: 'worker-1',
  });
  assert.equal(claimedA.lease?.ownerId, 'worker-1');
  assert.equal(repo.listEvents(missionA.id).at(-1)?.kind, 'lease.acquired');

  assert.throws(() => coordinator.claimMission(missionA.id, {
    ownerId: 'worker-2',
  }), MissionLeaseConflictError);

  assert.throws(() => coordinator.claimMission(missionB.id, {
    ownerId: 'worker-1',
  }), MissionConcurrentLimitError);

  now = 1_700_400_000_120;
  const refreshedA = coordinator.heartbeatMission(missionA.id, {
    ownerId: 'worker-1',
    ttlMs: 1_800,
  });
  assert.equal(refreshedA.lease?.heartbeatAt, now);
  assert.equal(refreshedA.lease?.expiresAt, now + 1_800);
  assert.equal(repo.listEvents(missionA.id).at(-1)?.kind, 'lease.heartbeat');

  now = 1_700_400_000_130;
  const releasedA = coordinator.releaseMission(missionA.id, {
    ownerId: 'worker-1',
    reason: 'Worker finished mission A.',
  });
  assert.equal(releasedA.lease?.releasedAt, now);
  assert.equal(repo.listEvents(missionA.id).at(-1)?.kind, 'lease.released');

  const claimedB = coordinator.claimMission(missionB.id, {
    ownerId: 'worker-1',
  });
  assert.equal(claimedB.lease?.ownerId, 'worker-1');
});

test('stale lease recovery re-queues running missions, preserves verifier states, and supports restart-safe reclaim', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-control-lease-recovery-'));
  const repoA = new JsonFileMissionRepository(stateDir);
  const runningMission = transitionMission(
    transitionMission(createMission({
      id: 'mission-stale-running',
      source: 'manual',
      platform: 'weixin',
      externalScopeId: 'wx-stale-running',
      title: 'Running mission',
      goal: 'Recover the running mission.',
      expectedOutput: 'Recovered mission output.',
      providerProfileId: 'codex-default',
      now: 1_700_500_000_000,
    }), 'queued', { at: 1_700_500_000_010 }),
    'running',
    {
      at: 1_700_500_000_020,
      activeAttemptId: 'attempt-running-1',
      lease: {
        ownerId: 'worker-a',
        acquiredAt: 1_700_500_000_020,
        heartbeatAt: 1_700_500_000_030,
        expiresAt: 1_700_500_000_040,
        releasedAt: null,
      },
    },
  );
  const verifyingMission = transitionMission(
    transitionMission(createMission({
      id: 'mission-stale-verifying',
      source: 'manual',
      platform: 'weixin',
      externalScopeId: 'wx-stale-verifying',
      title: 'Verifying mission',
      goal: 'Recover the verifying mission.',
      expectedOutput: 'Verifier continues from persisted state.',
      providerProfileId: 'codex-default',
      now: 1_700_500_000_000,
    }), 'queued', { at: 1_700_500_000_015 }),
    'running',
    {
      at: 1_700_500_000_025,
      activeAttemptId: 'attempt-verifying-1',
      lease: {
        ownerId: 'worker-b',
        acquiredAt: 1_700_500_000_025,
        heartbeatAt: 1_700_500_000_030,
        expiresAt: 1_700_500_000_040,
        releasedAt: null,
      },
    },
  );
  repoA.saveMission(transitionMission(verifyingMission, 'verifying', {
    at: 1_700_500_000_035,
    reason: 'Awaiting verifier result.',
    lease: verifyingMission.lease,
    activeAttemptId: verifyingMission.activeAttemptId,
  }));
  repoA.saveMission(runningMission);

  const repoB = new JsonFileMissionRepository(stateDir);
  let now = 1_700_500_000_100;
  const coordinator = new MissionLeaseCoordinator(repoB, {
    defaultTtlMs: 1_500,
    maxConcurrentMissions: 2,
    now: () => now,
  });

  const recovered = coordinator.recoverStaleMissions(now);
  assert.equal(recovered.length, 2);

  const recoveredRunning = repoB.getMissionById(runningMission.id);
  const recoveredVerifying = repoB.getMissionById(verifyingMission.id);
  assert.equal(recoveredRunning?.status, 'queued');
  assert.equal(recoveredRunning?.activeAttemptId, null);
  assert.equal(recoveredRunning?.lease?.releasedAt, now);
  assert.equal(recoveredVerifying?.status, 'verifying');
  assert.equal(recoveredVerifying?.activeAttemptId, 'attempt-verifying-1');
  assert.equal(recoveredVerifying?.lease?.releasedAt, now);

  const resumable = repoB.listResumableMissions(now).map((mission) => mission.id).sort();
  assert.deepEqual(resumable, [runningMission.id, verifyingMission.id].sort());

  const restartedRepo = new JsonFileMissionRepository(stateDir);
  now = 1_700_500_000_120;
  const restartedCoordinator = new MissionLeaseCoordinator(restartedRepo, {
    defaultTtlMs: 1_500,
    maxConcurrentMissions: 2,
    now: () => now,
  });
  const reclaimed = restartedCoordinator.claimMission(runningMission.id, {
    ownerId: 'worker-c',
  });
  assert.equal(reclaimed.lease?.ownerId, 'worker-c');
  assert.equal(restartedRepo.listEvents(runningMission.id).at(-1)?.kind, 'lease.acquired');
});
