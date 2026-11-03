// Agent Readiness — regression detection between two consecutive scans. Pure.
import type { Snapshot } from './engine.ts';

export interface ScanFacts { hours: string; booking_hours: string; holidays: number; feed_enabled: boolean; feed_ready: boolean }
export interface ScanSite { ok: boolean; local_business?: boolean; code?: string }
export interface ScanForDiff { score: number | null; facts: Partial<ScanFacts>; site: Partial<ScanSite> }
export type AlertKind = 'score_drop' | 'hours_changed' | 'feed_stale' | 'site_regression' | 'site_unreachable';
export interface AlertDraft { kind: AlertKind; detail: Record<string, string | number | boolean> }

export const SCORE_DROP_THRESHOLD = 10;

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

export function buildFacts(s: Snapshot): ScanFacts {
  const hasHours = Object.values(s.booking_hours ?? s.hours ?? {}).some((d) => d && d.closed !== true);
  return {
    hours: stable(s.hours), booking_hours: stable(s.booking_hours), holidays: s.holidays,
    feed_enabled: s.booking.feed_enabled, feed_ready: s.booking.enabled && s.timezone_valid && hasHours,
  };
}

export function diffScans(prev: ScanForDiff | null, next: ScanForDiff): AlertDraft[] {
  const out: AlertDraft[] = [];
  if (next.facts.feed_enabled && next.facts.feed_ready === false) out.push({ kind: 'feed_stale', detail: {} });
  if (next.site.ok === false && prev?.site.ok === true) out.push({ kind: 'site_unreachable', detail: { code: next.site.code ?? 'unknown' } });
  if (!prev) return out;
  if (prev.score !== null && next.score !== null && prev.score - next.score >= SCORE_DROP_THRESHOLD) {
    out.push({ kind: 'score_drop', detail: { from: prev.score, to: next.score } });
  }
  if (prev.facts.hours !== undefined && next.facts.hours !== undefined
    && (prev.facts.hours !== next.facts.hours || prev.facts.booking_hours !== next.facts.booking_hours || prev.facts.holidays !== next.facts.holidays)) {
    out.push({ kind: 'hours_changed', detail: {} });
  }
  if (prev.site.ok === true && prev.site.local_business === true && next.site.ok === true && next.site.local_business === false) {
    out.push({ kind: 'site_regression', detail: {} });
  }
  return out;
}
