/**
 * Sarah Voice Orb — pure logic (no React, no DOM). Unit-tested in sarahOrb.test.ts.
 * Geometry: 5 bars in a 32×32 box. The silhouette of each state is DIFFERENT, so state is
 * readable without colour and without motion (reduced-motion users get the static pose).
 */
export const SARAH_STATES = ['idle', 'listening', 'thinking', 'speaking', 'handoff', 'emergency', 'offline'] as const;
export type SarahState = (typeof SARAH_STATES)[number];

export const SARAH_LABELS: Record<SarahState, string> = {
  idle: 'ready',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  handoff: 'handing off to your team',
  emergency: 'emergency alert',
  offline: 'offline',
};

/** Resting bar heights (0–1), outer → centre → outer. */
export const POSES: Record<SarahState, readonly number[]> = {
  idle: [0.2, 0.32, 0.46, 0.32, 0.2], //       low dome
  listening: [0.55, 0.36, 0.26, 0.36, 0.55], // open "ear" (inverted dome)
  thinking: [0.2, 0.35, 0.5, 0.65, 0.8], //     ascending steps
  speaking: [0.45, 0.75, 1, 0.75, 0.45], //     tall dome
  handoff: [0.8, 0.65, 0.5, 0.35, 0.2], //      descending steps (points away)
  emergency: [0.9, 0.9, 0.9, 0.9, 0.9], //      flat wall
  offline: [0.12, 0.12, 0.12, 0.12, 0.12], //   flat line
};

/** How much live amplitude lifts each bar toward full height (centre moves most). */
export const AMP_WEIGHT: readonly number[] = [0.55, 0.8, 1, 0.8, 0.55];

/** States whose bars follow real audio when an amplitude source is supplied. */
export const AMPLITUDE_STATES: readonly SarahState[] = ['listening', 'speaking'];
export const isAmplitudeState = (s: SarahState) => AMPLITUDE_STATES.includes(s);

export const MIN_SIZE = 16;
export const MAX_SIZE = 256;
/** At or below this size the orb draws 3 bars and no ring (5 bars turn to mush at 16–24px). */
export const COMPACT_MAX = 24;

export const clampSize = (n: number) => (Number.isFinite(n) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n))) : 32);
export const barCountFor = (size: number): 3 | 5 => (clampSize(size) <= COMPACT_MAX ? 3 : 5);

/** The pose for a bar count: 3 bars use the inner three of the 5-bar pose. */
export function poseFor(state: SarahState, count: 3 | 5): number[] {
  const p = POSES[state];
  return count === 5 ? [...p] : [p[1], p[2], p[3]];
}
export function weightsFor(count: 3 | 5): number[] {
  return count === 5 ? [...AMP_WEIGHT] : [AMP_WEIGHT[1], AMP_WEIGHT[2], AMP_WEIGHT[3]];
}

/** Noise gate + gentle lift so quiet voices still move the orb. Input: raw 0–1 level (e.g. Vapi `volume-level`). */
export function normalizeLevel(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0.02) return 0;
  return Math.min(1, Math.pow(Math.min(1, raw), 0.6));
}

/** Frame-rate independent attack/release smoothing. Fast to rise, slow to fall — reads as speech, not flicker. */
export function smoothAmplitude(prev: number, target: number, dtMs: number, attackMs = 60, releaseMs = 220): number {
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs, 250) : 16;
  const tau = target > prev ? attackMs : releaseMs;
  const a = 1 - Math.exp(-dt / tau);
  const next = prev + (target - prev) * a;
  return Math.min(1, Math.max(0, Math.abs(next - target) < 0.001 ? target : next));
}

/** Bar height after amplitude (same maths the CSS calc() performs; kept here so it is testable). */
export function barHeight(base: number, weight: number, amp: number): number {
  const a = Math.min(1, Math.max(0, amp));
  return Math.min(1, Math.max(0.1, base + (1 - base) * a * weight));
}

/** Accessible name. Decorative orbs get none (the surrounding UI carries the status text). */
export function orbLabel(state: SarahState, label?: string): string {
  return label?.trim() || `Sarah, ${SARAH_LABELS[state]}`;
}

/** Maps call/live states from elsewhere in Vireek onto an orb state. Unknown → idle (never throws). */
export function stateFromCall(input: {
  online?: boolean;
  status?: 'ringing' | 'in_progress' | 'ended' | string | null;
  isEmergency?: boolean;
  handoff?: 'none' | 'requested' | 'failed' | string | null;
  speaking?: boolean;
  thinking?: boolean;
}): SarahState {
  if (input.online === false) return 'offline';
  if (input.isEmergency && input.status !== 'ended') return 'emergency';
  if (input.handoff === 'requested' && input.status !== 'ended') return 'handoff';
  if (input.status === 'in_progress') return input.speaking ? 'speaking' : input.thinking ? 'thinking' : 'listening';
  return 'idle';
}
