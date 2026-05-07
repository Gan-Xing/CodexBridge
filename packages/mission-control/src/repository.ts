import type { Mission, MissionAttempt, MissionEvent } from './types.js';

export interface MissionRepository {
  getMissionById(id: string): Mission | null;
  listMissions(): Mission[];
  listResumableMissions(now?: number): Mission[];
  saveMission(mission: Mission): Mission;
  resetMission(mission: Mission): Mission;

  getAttemptById(id: string): MissionAttempt | null;
  listAttempts(missionId: string): MissionAttempt[];
  saveAttempt(attempt: MissionAttempt): MissionAttempt;

  listEvents(missionId: string): MissionEvent[];
  appendEvent(event: MissionEvent): MissionEvent;
}
