import {
  hashChecklistSnapshot,
  normalizeMissionRecord,
  normalizeWorkflowHash,
  normalizeWorkflowResolverReason,
} from './domain_records.js';
import { isMissionResumable } from './state_machine.js';
import type { MissionRepository } from './repository.js';
import type {
  ChecklistSnapshot,
  Mission,
  MissionAttempt,
  MissionEvent,
  MissionGeneration,
  PlanChangeRequest,
  WorkItem,
} from './types.js';

type InMemoryState = {
  workItems: WorkItem[];
  missions: Mission[];
  generations: MissionGeneration[];
  checklistSnapshots: ChecklistSnapshot[];
  planChangeRequests: PlanChangeRequest[];
  attempts: MissionAttempt[];
  events: MissionEvent[];
};

const DEFAULT_STATE: InMemoryState = {
  workItems: [],
  missions: [],
  generations: [],
  checklistSnapshots: [],
  planChangeRequests: [],
  attempts: [],
  events: [],
};

export class InMemoryMissionRepository implements MissionRepository {
  private state: InMemoryState;

  constructor(seedState: Partial<InMemoryState> = {}) {
    this.state = normalizeState({
      ...DEFAULT_STATE,
      ...cloneValue(seedState),
    });
  }

  getWorkItemById(id: string): WorkItem | null {
    return this.state.workItems.find((workItem) => workItem.id === id) ?? null;
  }

  saveWorkItem(workItem: WorkItem): WorkItem {
    this.state.workItems = upsertById(this.state.workItems, workItem);
    return cloneValue(workItem);
  }

  getMissionById(id: string): Mission | null {
    return this.state.missions.find((mission) => mission.id === id) ?? null;
  }

  listMissions(): Mission[] {
    return cloneValue(this.state.missions);
  }

  listResumableMissions(now = Date.now()): Mission[] {
    return this.state.missions
      .filter((mission) => isMissionResumable(mission, now))
      .map((mission) => cloneValue(mission));
  }

  saveMission(mission: Mission): Mission {
    this.state.missions = upsertById(this.state.missions, mission);
    return cloneValue(mission);
  }

  resetMission(mission: Mission): Mission {
    this.state.workItems = this.state.workItems.filter((workItem) => workItem.id !== mission.workItemId);
    this.state.missions = upsertById(this.state.missions, mission);
    this.state.generations = this.state.generations.filter((generation) => generation.missionId !== mission.id);
    this.state.checklistSnapshots = this.state.checklistSnapshots.filter((snapshot) => snapshot.missionId !== mission.id);
    this.state.planChangeRequests = this.state.planChangeRequests.filter((changeRequest) => changeRequest.missionId !== mission.id);
    this.state.attempts = this.state.attempts.filter((attempt) => attempt.missionId !== mission.id);
    this.state.events = this.state.events.filter((event) => event.missionId !== mission.id);
    return cloneValue(mission);
  }

  getGenerationById(id: string): MissionGeneration | null {
    return this.state.generations.find((generation) => generation.id === id) ?? null;
  }

  listGenerations(missionId: string): MissionGeneration[] {
    return this.state.generations
      .filter((generation) => generation.missionId === missionId)
      .map((generation) => cloneValue(generation));
  }

  saveGeneration(generation: MissionGeneration): MissionGeneration {
    this.state.generations = upsertById(this.state.generations, generation);
    return cloneValue(generation);
  }

  getChecklistSnapshotById(id: string): ChecklistSnapshot | null {
    return this.state.checklistSnapshots.find((snapshot) => snapshot.id === id) ?? null;
  }

  listChecklistSnapshots(missionId: string): ChecklistSnapshot[] {
    return this.state.checklistSnapshots
      .filter((snapshot) => snapshot.missionId === missionId)
      .map((snapshot) => cloneValue(snapshot));
  }

  saveChecklistSnapshot(snapshot: ChecklistSnapshot): ChecklistSnapshot {
    this.state.checklistSnapshots = upsertById(this.state.checklistSnapshots, snapshot);
    return cloneValue(snapshot);
  }

  getPlanChangeRequestById(id: string): PlanChangeRequest | null {
    return this.state.planChangeRequests.find((changeRequest) => changeRequest.id === id) ?? null;
  }

  listPlanChangeRequests(missionId: string): PlanChangeRequest[] {
    return this.state.planChangeRequests
      .filter((changeRequest) => changeRequest.missionId === missionId)
      .map((changeRequest) => cloneValue(changeRequest));
  }

  savePlanChangeRequest(changeRequest: PlanChangeRequest): PlanChangeRequest {
    this.state.planChangeRequests = upsertById(this.state.planChangeRequests, changeRequest);
    return cloneValue(changeRequest);
  }

  getAttemptById(id: string): MissionAttempt | null {
    return this.state.attempts.find((attempt) => attempt.id === id) ?? null;
  }

  listAttempts(missionId: string): MissionAttempt[] {
    return this.state.attempts
      .filter((attempt) => attempt.missionId === missionId)
      .map((attempt) => cloneValue(attempt));
  }

  saveAttempt(attempt: MissionAttempt): MissionAttempt {
    this.state.attempts = upsertById(this.state.attempts, attempt);
    return cloneValue(attempt);
  }

  listEvents(missionId: string): MissionEvent[] {
    return this.state.events
      .filter((event) => event.missionId === missionId)
      .map((event) => cloneValue(event));
  }

  appendEvent(event: MissionEvent): MissionEvent {
    this.state.events = [...this.state.events, cloneValue(event)];
    return cloneValue(event);
  }
}

function normalizeState(state: InMemoryState): InMemoryState {
  return {
    workItems: Array.isArray(state.workItems)
      ? state.workItems.map((workItem) => normalizeWorkItem(cloneValue(workItem)))
      : [],
    missions: Array.isArray(state.missions)
      ? state.missions.map((mission) => normalizeMissionRecord(cloneValue(mission)))
      : [],
    generations: Array.isArray(state.generations)
      ? state.generations.map((generation) => normalizeGeneration(cloneValue(generation)))
      : [],
    checklistSnapshots: Array.isArray(state.checklistSnapshots)
      ? state.checklistSnapshots.map((snapshot) => normalizeChecklistSnapshot(cloneValue(snapshot)))
      : [],
    planChangeRequests: Array.isArray(state.planChangeRequests) ? cloneValue(state.planChangeRequests) : [],
    attempts: Array.isArray(state.attempts)
      ? state.attempts.map((attempt) => normalizeAttempt(cloneValue(attempt)))
      : [],
    events: Array.isArray(state.events) ? cloneValue(state.events) : [],
  };
}

function normalizeWorkItem(workItem: WorkItem): WorkItem {
  return {
    ...workItem,
    sourceRef: typeof workItem.sourceRef === 'string' ? workItem.sourceRef : null,
    sourceRevision: typeof workItem.sourceRevision === 'string' ? workItem.sourceRevision : null,
    metadata: isRecord(workItem.metadata) ? cloneValue(workItem.metadata) : null,
  };
}

function normalizeChecklistSnapshot(snapshot: ChecklistSnapshot): ChecklistSnapshot {
  const normalized: ChecklistSnapshot = {
    ...snapshot,
    generationId: typeof snapshot.generationId === 'string' ? snapshot.generationId : null,
    sourceRef: typeof snapshot.sourceRef === 'string' ? snapshot.sourceRef : null,
    sourceRevision: typeof snapshot.sourceRevision === 'string' ? snapshot.sourceRevision : null,
    expectedOutput: typeof snapshot.expectedOutput === 'string' ? snapshot.expectedOutput : null,
    acceptanceCriteria: Array.isArray(snapshot.acceptanceCriteria) ? [...snapshot.acceptanceCriteria] : [],
    plan: Array.isArray(snapshot.plan) ? [...snapshot.plan] : [],
    items: Array.isArray(snapshot.items)
      ? snapshot.items.map((item) => ({
        ...item,
        detail: typeof item.detail === 'string' ? item.detail : null,
        sourceRef: typeof item.sourceRef === 'string' ? item.sourceRef : null,
        completionSummary: typeof item.completionSummary === 'string' ? item.completionSummary : null,
      }))
      : [],
  };
  return {
    ...normalized,
    hash: typeof snapshot.hash === 'string' && snapshot.hash.trim().length > 0
      ? snapshot.hash
      : hashChecklistSnapshot(normalized),
  };
}

function normalizeGeneration(generation: MissionGeneration): MissionGeneration {
  return {
    ...generation,
    checklistSnapshotId: typeof generation.checklistSnapshotId === 'string'
      ? generation.checklistSnapshotId
      : null,
    parentGenerationId: typeof generation.parentGenerationId === 'string'
      ? generation.parentGenerationId
      : null,
    workflowPath: typeof generation.workflowPath === 'string' ? generation.workflowPath : null,
    workflowHash: normalizeWorkflowHash(generation.workflowHash),
    resolverReason: normalizeWorkflowResolverReason(generation.resolverReason),
    summary: typeof generation.summary === 'string' ? generation.summary : null,
  };
}

function normalizeAttempt(attempt: MissionAttempt): MissionAttempt {
  return {
    ...attempt,
    missingAcceptanceCriteria: Array.isArray(attempt.missingAcceptanceCriteria)
      ? [...attempt.missingAcceptanceCriteria]
      : [],
    generationId: typeof attempt.generationId === 'string' ? attempt.generationId : null,
    generationIndex: normalizePositiveInteger(attempt.generationIndex),
    checklistSnapshotId: typeof attempt.checklistSnapshotId === 'string' ? attempt.checklistSnapshotId : null,
    workflowPath: typeof attempt.workflowPath === 'string' ? attempt.workflowPath : null,
    workflowHash: normalizeWorkflowHash(attempt.workflowHash),
    resolverReason: normalizeWorkflowResolverReason(attempt.resolverReason),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function upsertById<T extends { id: string }>(items: T[], value: T): T[] {
  const next = cloneValue(items);
  const index = next.findIndex((item) => item.id === value.id);
  if (index === -1) {
    next.push(cloneValue(value));
    return next;
  }
  next[index] = cloneValue(value);
  return next;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
