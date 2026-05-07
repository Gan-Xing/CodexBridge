import fs from 'node:fs';
import path from 'node:path';
import { isMissionResumable } from './state_machine.js';
import type { MissionRepository } from './repository.js';
import type { Mission, MissionAttempt, MissionEvent } from './types.js';

type JsonState = {
  missions: Mission[];
  attempts: MissionAttempt[];
  events: MissionEvent[];
};

const DEFAULT_JSON_STATE: JsonState = {
  missions: [],
  attempts: [],
  events: [],
};

export class JsonFileMissionRepository implements MissionRepository {
  private readonly statePath: string;

  constructor(stateDir: string, fileName = 'mission-control.json') {
    this.statePath = path.join(stateDir, fileName);
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
      missions: upsertById(state.missions, mission),
      attempts: state.attempts.filter((attempt) => attempt.missionId !== mission.id),
      events: state.events.filter((event) => event.missionId !== mission.id),
    })).missions.find((entry) => entry.id === mission.id) ?? mission;
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
        missions: Array.isArray(parsed.missions) ? cloneValue(parsed.missions) : [],
        attempts: Array.isArray(parsed.attempts)
          ? parsed.attempts.map((attempt) => normalizeAttempt(cloneValue(attempt)))
          : [],
        events: Array.isArray(parsed.events) ? cloneValue(parsed.events) : [],
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
  };
}
