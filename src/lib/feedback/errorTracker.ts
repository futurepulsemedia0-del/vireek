// Remembers the last runtime error / incident so (a) feedback can attach the error ID and
// (b) surveys are never shown right after something broke.
let lastErrorAt = 0;
let lastIncidentId: string | null = null;
let installed = false;

export const ERROR_QUIET_MS = 5 * 60_000;

export function noteIncident(incidentId: string): void {
  lastIncidentId = incidentId;
  lastErrorAt = Date.now();
}
export const getLastIncidentId = (): string | null => lastIncidentId;
export const getLastErrorAt = (): number => lastErrorAt;
export function resetErrorTrackerForTests(): void {
  lastErrorAt = 0;
  lastIncidentId = null;
}

/** Idempotent; call once at app start (SurveyHost does it). */
export function installErrorTracker(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', () => { lastErrorAt = Date.now(); });
  window.addEventListener('unhandledrejection', () => { lastErrorAt = Date.now(); });
}
