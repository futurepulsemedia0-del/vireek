// src/lib/trackingGate.ts
// Dependency-free client gate for the GPS trail. The server (filter_location_points) is the
// authority; this only stops points being recorded while the app already knows tracking is
// not allowed (off duty, or consent missing). Fails open when the status is unknown so a
// network blip never silently drops an on-shift technician's trail.

export type TrackingGateReason = 'allowed' | 'no_consent' | 'off_duty';

export interface TrackingGateState {
  allowed: boolean;
  reason: TrackingGateReason;
  /** epoch ms of the last server answer; 0 = never checked. */
  checkedAt: number;
}

let state: TrackingGateState = { allowed: true, reason: 'allowed', checkedAt: 0 };

export function setTrackingGate(reason: TrackingGateReason, now: number = Date.now()): TrackingGateState {
  state = { allowed: reason === 'allowed', reason, checkedAt: now };
  return state;
}

export function getTrackingGate(): TrackingGateState {
  return state;
}

export function isTrackingAllowedNow(): boolean {
  return state.allowed;
}

export function resetTrackingGate(): void {
  state = { allowed: true, reason: 'allowed', checkedAt: 0 };
}
