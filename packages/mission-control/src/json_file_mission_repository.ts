import fs from 'node:fs';
import path from 'node:path';
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

type JsonState = {
  workItems: WorkItem[];
  missions: Mission[];
  generations: MissionGeneration[];
  checklistSnapshots: ChecklistSnapshot[];
  planChangeRequests: PlanChangeRequest[];
  attempts: MissionAttempt[];
  events: MissionEvent[];
};

const DEFAULT_JSON_STATE: JsonState = {
  workItems: [],
  missions: [],
  generations: [],
  checklistSnapshots: [],
  planChangeRequests: [],
  attempts: [],
  events: [],
};

export class JsonFileMissionRepository implements MissionRepository {
  private readonly statePath: string;

  constructor(stateDir: string, fileName = 'mission-control.json') {
    this.statePath = path.join(stateDir, fileName);
  }

  getWorkItemById(id: string): WorkItem | null {
    return this.loadState().workItems.find((workItem) => workItem.id === id) ?? null;
  }

  saveWorkItem(workItem: WorkItem): WorkItem {
    return this.updateState((state) => ({
      ...state,
      workItems: upsertById(state.workItems, workItem),
    })).workItems.find((entry) => entry.id === workItem.id) ?? workItem;
  }

  getMissionById(id: string): Mission | null {
    return this.loadState().missions.find((mission) => mission.id === id) ?? null;
  }

  listMissions(): Mission[] {
    return this.loadState().missions;
  }

  listResumableMissions(now = Date.now()): Mission[] {
    return this.loadState().missions.filter((mission) => isMissionResumable(mission, now));
  }

  saveMission(mission: Mission): Mission {
    return this.updateState((state) => ({
      ...state,
      missions: upsertById(state.missions, mission),
    })).missions.find((entry) => entry.id === mission.id) ?? mission;
  }

  resetMission(mission: Mission): Mission {
    return this.updateState((state) => ({
      ...state,
      workItems: state.workItems.filter((workItem) => workItem.id !== mission.workItemId),
      missions: upsertById(state.missions, mission),
      generations: state.generations.filter((generation) => generation.missionId !== mission.id),
      checklistSnapshots: state.checklistSnapshots.filter((snapshot) => snapshot.missionId !== mission.id),
      planChangeRequests: state.planChangeRequests.filter((changeRequest) => changeRequest.missionId !== mission.id),
      attempts: state.attempts.filter((attempt) => attempt.missionId !== mission.id),
      events: state.events.filter((event) => event.missionId !== mission.id),
    })).missions.find((entry) => entry.id === mission.id) ?? mission;
  }

  getGenerationById(id: string): MissionGeneration | null {
    return this.loadState().generations.find((generation) => generation.id === id) ?? null;
  }

  listGenerations(missionId: string): MissionGeneration[] {
    return this.loadState().generations.filter((generation) => generation.missionId === missionId);
  }

  saveGeneration(generation: MissionGeneration): MissionGeneration {
    return this.updateState((state) => ({
      ...state,
      generations: upsertById(state.generations, generation),
    })).generations.find((entry) => entry.id === generation.id) ?? generation;
  }

  getChecklistSnapshotById(id: string): ChecklistSnapshot | null {
    return this.loadState().checklistSnapshots.find((snapshot) => snapshot.id === id) ?? null;
  }

  listChecklistSnapshots(missionId: string): ChecklistSnapshot[] {
    return this.loadState().checklistSnapshots.filter((snapshot) => snapshot.missionId === missionId);
  }

  saveChecklistSnapshot(snapshot: ChecklistSnapshot): ChecklistSnapshot {
    return this.updateState((state) => ({
      ...state,
      checklistSnapshots: upsertById(state.checklistSnapshots, snapshot),
    })).checklistSnapshots.find((entry) => entry.id === snapshot.id) ?? snapshot;
  }

  getPlanChangeRequestById(id: string): PlanChangeRequest | null {
    return this.loadState().planChangeRequests.find((changeRequest) => changeRequest.id === id) ?? null;
  }

  listPlanChangeRequests(missionId: string): PlanChangeRequest[] {
    return this.loadState().planChangeRequests.filter((changeRequest) => changeRequest.missionId === missionId);
  }

  savePlanChangeRequest(changeRequest: PlanChangeRequest): PlanChangeRequest {
    return this.updateState((state) => ({
      ...state,
      planChangeRequests: upsertById(state.planChangeRequests, changeRequest),
    })).planChangeRequests.find((entry) => entry.id === changeRequest.id) ?? changeRequest;
  }

  getAttemptById(id: string): MissionAttempt | null {
    return this.loadState().attempts.find((attempt) => attempt.id === id) ?? null;
  }

  listAttempts(missionId: string): MissionAttempt[] {
    return this.loadState().attempts.filter((attempt) => attempt.missionId === missionId);
  }

  saveAttempt(attempt: MissionAttempt): MissionAttempt {
    return this.updateState((state) => ({
      ...state,
      attempts: upsertById(state.attempts, attempt),
    })).attempts.find((entry) => entry.id === attempt.id) ?? attempt;
  }

  listEvents(missionId: string): MissionEvent[] {
    return this.loadState().events.filter((event) => event.missionId === missionId);
  }

  appendEvent(event: MissionEvent): MissionEvent {
    this.updateState((state) => ({
      ...state,
      events: [...state.events, cloneValue(event)],
    }));
    return event;
  }

  private loadState(): JsonState {
    if (!fs.existsSync(this.statePath)) {
      return cloneValue(DEFAULT_JSON_STATE);
    }
    try {
      const raw = fs.readFileSync(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<JsonState>;
      return {
        workItems: Array.isArray(parsed.workItems)
          ? parsed.workItems.map((workItem) => normalizeWorkItem(cloneValue(workItem)))
          : [],
        missions: Array.isArray(parsed.missions)
          ? parsed.missions.map((mission) => normalizeMissionRecord(cloneValue(mission)))
          : [],
        generations: Array.isArray(parsed.generations)
          ? parsed.generations.map((generation) => normalizeGeneration(cloneValue(generation)))
          : [],
        checklistSnapshots: Array.isArray(parsed.checklistSnapshots)
          ? parsed.checklistSnapshots.map((snapshot) => normalizeChecklistSnapshot(cloneValue(snapshot)))
          : [],
        planChangeRequests: Array.isArray(parsed.planChangeRequests)
          ? parsed.planChangeRequests.map((changeRequest) => normalizePlanChangeRequest(cloneValue(changeRequest)))
          : [],
        attempts: Array.isArray(parsed.attempts)
          ? parsed.attempts.map((attempt) => normalizeAttempt(cloneValue(attempt)))
          : [],
        events: Array.isArray(parsed.events)
          ? parsed.events.map((event) => normalizeEvent(cloneValue(event)))
          : [],
      };
    } catch {
      return cloneValue(DEFAULT_JSON_STATE);
    }
  }

  private updateState(updater: (state: JsonState) => JsonState): JsonState {
    const current = this.loadState();
    const next = updater(current);
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, this.statePath);
    return cloneValue(next);
  }
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

function normalizeGeneration(generation: MissionGeneration): MissionGeneration {
  return {
    ...generation,
    checklistSnapshotId: typeof generation.checklistSnapshotId === 'string' ? generation.checklistSnapshotId : null,
    parentGenerationId: typeof generation.parentGenerationId === 'string' ? generation.parentGenerationId : null,
    workflowPath: typeof generation.workflowPath === 'string' ? generation.workflowPath : null,
    workflowHash: normalizeWorkflowHash(generation.workflowHash),
    resolverReason: normalizeWorkflowResolverReason(generation.resolverReason),
    summary: typeof generation.summary === 'string' ? generation.summary : null,
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

function normalizePlanChangeRequest(changeRequest: PlanChangeRequest): PlanChangeRequest {
  return {
    ...changeRequest,
    generationId: typeof changeRequest.generationId === 'string' ? changeRequest.generationId : null,
    checklistSnapshotId: typeof changeRequest.checklistSnapshotId === 'string'
      ? changeRequest.checklistSnapshotId
      : null,
    proposedExpectedOutput: typeof changeRequest.proposedExpectedOutput === 'string'
      ? changeRequest.proposedExpectedOutput
      : null,
    proposedAcceptanceCriteria: Array.isArray(changeRequest.proposedAcceptanceCriteria)
      ? [...changeRequest.proposedAcceptanceCriteria]
      : [],
    proposedPlan: Array.isArray(changeRequest.proposedPlan)
      ? [...changeRequest.proposedPlan]
      : [],
  };
}

function normalizeEvent(event: MissionEvent): MissionEvent {
  return {
    ...event,
    generationId: typeof event.generationId === 'string' ? event.generationId : null,
    generationIndex: normalizePositiveInteger(event.generationIndex),
  };
}

function normalizePositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function normalizeWorkItem(workItem: WorkItem): WorkItem {
  return {
    ...workItem,
    sourceRef: typeof workItem.sourceRef === 'string' ? workItem.sourceRef : null,
    sourceRevision: typeof workItem.sourceRevision === 'string' ? workItem.sourceRevision : null,
    metadata: isRecord(workItem.metadata) ? cloneValue(workItem.metadata) : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
