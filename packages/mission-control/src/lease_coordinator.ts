import crypto from 'node:crypto';
import { transitionMission } from './state_machine.js';
import type { MissionRepository } from './repository.js';
import type { Mission, MissionEvent, MissionLease, MissionStatus } from './types.js';

const CLAIMABLE_MISSION_STATUS_SET = new Set<MissionStatus>([
  'queued',
  'planning',
  'running',
  'verifying',
  'repairing',
]);

const STALE_REQUEUE_STATUS_SET = new Set<MissionStatus>([
  'queued',
  'planning',
  'running',
]);

const STALE_RESUME_IN_PLACE_STATUS_SET = new Set<MissionStatus>([
  'verifying',
  'repairing',
]);

export class MissionLeaseConflictError extends Error {
  readonly missionId: string;

  readonly ownerId: string;

  readonly currentOwnerId: string;

  constructor(message: string, params: {
    missionId: string;
    ownerId: string;
    currentOwnerId: string;
  }) {
    super(message);
    this.name = 'MissionLeaseConflictError';
    this.missionId = params.missionId;
    this.ownerId = params.ownerId;
    this.currentOwnerId = params.currentOwnerId;
  }
}

export class MissionConcurrentLimitError extends Error {
  readonly ownerId: string;

  readonly maxConcurrentMissions: number;

  readonly activeMissionIds: string[];

  constructor(message: string, params: {
    ownerId: string;
    maxConcurrentMissions: number;
    activeMissionIds: string[];
  }) {
    super(message);
    this.name = 'MissionConcurrentLimitError';
    this.ownerId = params.ownerId;
    this.maxConcurrentMissions = params.maxConcurrentMissions;
    this.activeMissionIds = [...params.activeMissionIds];
  }
}

export interface MissionLeaseCoordinatorOptions {
  defaultTtlMs?: number;
  maxConcurrentMissions?: number;
  now?: () => number;
}

export class MissionLeaseCoordinator {
  private readonly repository: MissionRepository;

  private readonly defaultTtlMs: number;

  private readonly maxConcurrentMissions: number;

  private readonly now: () => number;

  constructor(
    repository: MissionRepository,
    {
      defaultTtlMs = 60_000,
      maxConcurrentMissions = Number.POSITIVE_INFINITY,
      now = () => Date.now(),
    }: MissionLeaseCoordinatorOptions = {},
  ) {
    this.repository = repository;
    this.defaultTtlMs = defaultTtlMs;
    this.maxConcurrentMissions = maxConcurrentMissions;
    this.now = now;
  }

  claimMission(
    missionId: string,
    params: {
      ownerId: string;
      ttlMs?: number;
    },
  ): Mission {
    const mission = this.requireClaimableMission(missionId);
    const now = this.now();
    const ttlMs = clampLeaseTtl(params.ttlMs ?? this.defaultTtlMs);
    const lease = mission.lease;

    if (hasActiveLease(mission, now)) {
      if (lease?.ownerId === params.ownerId) {
        return this.persistLeaseHeartbeat(mission, ttlMs, now, 'lease.heartbeat', 'Lease heartbeat refreshed.');
      }
      throw new MissionLeaseConflictError(
        `mission ${missionId} is already leased by ${lease?.ownerId ?? 'unknown owner'}`,
        {
          missionId,
          ownerId: params.ownerId,
          currentOwnerId: lease?.ownerId ?? 'unknown',
        },
      );
    }

    this.assertConcurrentLimit(params.ownerId, mission.id, now);
    const next = saveMissionLease(mission, {
      ownerId: params.ownerId,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: now + ttlMs,
      releasedAt: null,
    }, now);
    this.repository.saveMission(next);
    this.appendLeaseEvent(next, 'lease.acquired', 'Mission lease acquired.', {
      ownerId: params.ownerId,
      expiresAt: now + ttlMs,
    }, now);
    return next;
  }

  heartbeatMission(
    missionId: string,
    params: {
      ownerId: string;
      ttlMs?: number;
    },
  ): Mission {
    const mission = this.requireMission(missionId);
    const now = this.now();
    const ttlMs = clampLeaseTtl(params.ttlMs ?? this.defaultTtlMs);
    const lease = mission.lease;
    if (!lease || lease.releasedAt !== null || lease.ownerId !== params.ownerId || lease.expiresAt <= now) {
      throw new MissionLeaseConflictError(
        `mission ${missionId} is not actively leased by ${params.ownerId}`,
        {
          missionId,
          ownerId: params.ownerId,
          currentOwnerId: lease?.ownerId ?? 'none',
        },
      );
    }
    return this.persistLeaseHeartbeat(mission, ttlMs, now, 'lease.heartbeat', 'Mission lease heartbeat renewed.');
  }

  releaseMission(
    missionId: string,
    params: {
      ownerId: string;
      reason?: string | null;
    },
  ): Mission {
    const mission = this.requireMission(missionId);
    const now = this.now();
    const lease = mission.lease;
    if (!lease) {
      return mission;
    }
    if (lease.ownerId !== params.ownerId && lease.releasedAt === null && lease.expiresAt > now) {
      throw new MissionLeaseConflictError(
        `mission ${missionId} is actively leased by ${lease.ownerId}`,
        {
          missionId,
          ownerId: params.ownerId,
          currentOwnerId: lease.ownerId,
        },
      );
    }
    const next = saveMissionLease(mission, {
      ...lease,
      releasedAt: now,
    }, now, params.reason ?? mission.statusReason);
    this.repository.saveMission(next);
    this.appendLeaseEvent(next, 'lease.released', params.reason ?? 'Mission lease released.', {
      ownerId: lease.ownerId,
    }, now);
    return next;
  }

  recoverStaleMissions(now = this.now()): Mission[] {
    const recovered: Mission[] = [];
    for (const mission of this.repository.listMissions()) {
      if (!hasExpiredUnreleasedLease(mission, now)) {
        continue;
      }
      const lease = mission.lease!;
      const releasedLease = {
        ...lease,
        releasedAt: now,
      };
      let next: Mission;
      if (STALE_REQUEUE_STATUS_SET.has(mission.status)) {
        next = {
          ...saveMissionLease(
            mission,
            releasedLease,
            now,
            'Runner lease expired; mission re-queued for continuation.',
            null,
          ),
          status: 'queued',
          stoppedAt: null,
          updatedAt: now,
        };
      } else if (STALE_RESUME_IN_PLACE_STATUS_SET.has(mission.status)) {
        next = saveMissionLease(
          mission,
          releasedLease,
          now,
          'Runner lease expired; verifier state preserved for continuation.',
        );
      } else {
        next = saveMissionLease(mission, releasedLease, now, mission.statusReason);
      }
      this.repository.saveMission(next);
      this.appendLeaseEvent(next, 'lease.released', 'Recovered stale mission lease.', {
        ownerId: lease.ownerId,
        stale: true,
      }, now);
      recovered.push(next);
    }
    return recovered;
  }

  private requireMission(missionId: string): Mission {
    const mission = this.repository.getMissionById(missionId);
    if (!mission) {
      throw new Error(`unknown mission: ${missionId}`);
    }
    return mission;
  }

  private requireClaimableMission(missionId: string): Mission {
    const mission = this.requireMission(missionId);
    if (!CLAIMABLE_MISSION_STATUS_SET.has(mission.status)) {
      throw new Error(`mission ${missionId} is not claimable from status ${mission.status}`);
    }
    return mission;
  }

  private assertConcurrentLimit(ownerId: string, missionId: string, now: number): void {
    if (!Number.isFinite(this.maxConcurrentMissions)) {
      return;
    }
    const activeMissionIds = this.repository.listMissions()
      .filter((mission) => mission.id !== missionId)
      .filter((mission) => hasActiveLease(mission, now))
      .map((mission) => mission.id);
    if (activeMissionIds.length >= this.maxConcurrentMissions) {
      throw new MissionConcurrentLimitError(
        `maximum concurrent missions reached for ${ownerId}`,
        {
          ownerId,
          maxConcurrentMissions: this.maxConcurrentMissions,
          activeMissionIds,
        },
      );
    }
  }

  private persistLeaseHeartbeat(
    mission: Mission,
    ttlMs: number,
    now: number,
    kind: MissionEvent['kind'],
    summary: string,
  ): Mission {
    const next = saveMissionLease(mission, {
      ownerId: mission.lease!.ownerId,
      acquiredAt: mission.lease!.acquiredAt,
      heartbeatAt: now,
      expiresAt: now + ttlMs,
      releasedAt: null,
    }, now);
    this.repository.saveMission(next);
    this.appendLeaseEvent(next, kind, summary, {
      ownerId: mission.lease!.ownerId,
      expiresAt: now + ttlMs,
    }, now);
    return next;
  }

  private appendLeaseEvent(
    mission: Mission,
    kind: MissionEvent['kind'],
    summary: string,
    metadata: Record<string, unknown>,
    createdAt: number,
  ): void {
    this.repository.appendEvent({
      id: crypto.randomUUID(),
      missionId: mission.id,
      attemptId: null,
      generationId: mission.activeGenerationId,
      generationIndex: mission.activeGenerationIndex,
      kind,
      summary,
      detail: null,
      metadata,
      createdAt,
    });
  }
}

function hasActiveLease(mission: Mission, now: number): boolean {
  return Boolean(mission.lease && mission.lease.releasedAt === null && mission.lease.expiresAt > now);
}

function hasExpiredUnreleasedLease(mission: Mission, now: number): boolean {
  return Boolean(mission.lease && mission.lease.releasedAt === null && mission.lease.expiresAt <= now);
}

function saveMissionLease(
  mission: Mission,
  lease: MissionLease | null,
  at: number,
  statusReason: string | null = mission.statusReason,
  activeAttemptId = mission.activeAttemptId,
): Mission {
  return {
    ...mission,
    lease: lease ? { ...lease } : null,
    statusReason,
    activeAttemptId,
    updatedAt: at,
  };
}

function clampLeaseTtl(value: number): number {
  if (!Number.isFinite(value)) {
    return 60_000;
  }
  return Math.max(1_000, Math.min(24 * 60 * 60 * 1_000, Math.trunc(value)));
}
