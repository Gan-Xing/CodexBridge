const SESSION_PAUSE_DURATION_MS = 60 * 60 * 1000;

export const SESSION_EXPIRED_ERRCODE = -14;

const pauseUntilMap = new Map<string, number>();

export function pauseSession(accountId: string): void {
  pauseUntilMap.set(accountId, Date.now() + SESSION_PAUSE_DURATION_MS);
}

export function isSessionPaused(accountId: string): boolean {
  const until = pauseUntilMap.get(accountId);
  if (until === undefined) {
    return false;
  }
  if (Date.now() >= until) {
    pauseUntilMap.delete(accountId);
    return false;
  }
  return true;
}

export function getRemainingPauseMs(accountId: string): number {
  const until = pauseUntilMap.get(accountId);
  if (until === undefined) {
    return 0;
  }
  const remaining = until - Date.now();
  if (remaining <= 0) {
    pauseUntilMap.delete(accountId);
    return 0;
  }
  return remaining;
}

export function assertSessionActive(accountId: string): void {
  if (!isSessionPaused(accountId)) {
    return;
  }
  const remainingMinutes = Math.ceil(getRemainingPauseMs(accountId) / 60_000);
  throw new Error(
    `session paused for accountId=${accountId}, ${remainingMinutes} min remaining (errcode ${SESSION_EXPIRED_ERRCODE})`,
  );
}

export function _resetSessionGuardForTest(): void {
  pauseUntilMap.clear();
}
