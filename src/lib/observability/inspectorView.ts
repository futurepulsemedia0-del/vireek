// View helpers for the staff voice-observability page. Pure so they can be unit-tested.

export type Tone = 'good' | 'warn' | 'bad' | 'none';

export function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

/** Latency tone follows the alert rule thresholds (warn 2.5 s, critical 4 s). */
export function latencyTone(ms: number | null | undefined): Tone {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'none';
  return ms > 4000 ? 'bad' : ms > 2500 ? 'warn' : 'good';
}

/** Rate tone for "higher is better" SLIs (answer rate, completion, booking). */
export function rateTone(v: number | null | undefined, warnBelow: number, badBelow: number): Tone {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'none';
  return v < badBelow ? 'bad' : v < warnBelow ? 'warn' : 'good';
}

export const TONE_CLASS: Record<Tone, string> = {
  good: 'text-success-500',
  warn: 'text-warning-500',
  bad: 'text-danger',
  none: 'text-text-secondary',
};

/** Bar width (0..100) for a timeline row relative to the slowest event; never 0 for a real value so it stays visible. */
export function barPercent(ms: number | null | undefined, maxMs: number): number {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0 || maxMs <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((ms / maxMs) * 100)));
}

export function reasonValid(reason: string): boolean {
  return reason.trim().length >= 10 && reason.trim().length <= 500;
}

export const FLAG_LABEL: Record<string, string> = {
  long_silence: 'Long silence', repeated_ask: 'Repeated question', abrupt_hangup: 'Abrupt hang-up',
  low_asr_confidence: 'Low ASR confidence', slow_response: 'Slow response', tool_failure: 'Tool failure',
};
