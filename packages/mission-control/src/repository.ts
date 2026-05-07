import type {
  ChecklistSnapshot,
  Mission,
  MissionAttempt,
  MissionEvent,
  MissionGeneration,
  PlanChangeRequest,
  WorkItem,
} from './types.js';

export interface MissionRepository {
  getMissionById(id: string): Mission | null;
  listMissions(): Mission[];
  listResumableMissions(now?: number): Mission[];
  saveMission(mission: Mission): Mission;
  resetMission(mission: Mission): Mission;

  getWorkItemById(id: string): WorkItem | null;
  saveWorkItem(workItem: WorkItem): WorkItem;

  getGenerationById(id: string): MissionGeneration | null;
  listGenerations(missionId: string): MissionGeneration[];
  saveGeneration(generation: MissionGeneration): MissionGeneration;

  getChecklistSnapshotById(id: string): ChecklistSnapshot | null;
  listChecklistSnapshots(missionId: string): ChecklistSnapshot[];
  saveChecklistSnapshot(snapshot: ChecklistSnapshot): ChecklistSnapshot;

  getPlanChangeRequestById(id: string): PlanChangeRequest | null;
  listPlanChangeRequests(missionId: string): PlanChangeRequest[];
  savePlanChangeRequest(changeRequest: PlanChangeRequest): PlanChangeRequest;

  getAttemptById(id: string): MissionAttempt | null;
  listAttempts(missionId: string): MissionAttempt[];
  saveAttempt(attempt: MissionAttempt): MissionAttempt;

  listEvents(missionId: string): MissionEvent[];
  appendEvent(event: MissionEvent): MissionEvent;
}
