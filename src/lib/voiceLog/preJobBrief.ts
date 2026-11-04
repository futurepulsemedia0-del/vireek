// Pre-job brief (phase C): turns the existing get_job_brief payload into a prioritised list of
// short facts that is shown on screen and can be read aloud in about 60 seconds. Pure + typed;
// wording lives in i18n. It only restates data already in Vireek — it adds no advice.
import type { JobBrief } from '@/lib/technicianOS';

export type BriefKind = 'safety' | 'customer' | 'equipment' | 'previous' | 'claims' | 'diagnosis' | 'shortage' | 'preference';
export type WarrantyState = 'active' | 'expired' | 'unknown';
export interface BriefItem { id: string; kind: BriefKind; priority: number; params: Record<string, string | number> }

export const SPOKEN_WORDS_PER_MINUTE = 150;
export const BRIEF_SECONDS = 60;
export const BRIEF_MAX_WORDS = Math.floor((SPOKEN_WORDS_PER_MINUTE * BRIEF_SECONDS) / 60);

export function warrantyState(expiresAt: string | null | undefined, now = Date.now()): WarrantyState {
  if (!expiresAt) return 'unknown';
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return 'unknown';
  return t >= now ? 'active' : 'expired';
}

export function ageYears(installDate: string | null | undefined, now = Date.now()): number | null {
  if (!installDate) return null;
  const t = Date.parse(installDate);
  if (!Number.isFinite(t) || t > now) return null;
  return Math.floor((now - t) / (365.25 * 24 * 3600 * 1000));
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function buildBriefItems(b: JobBrief, now = Date.now()): BriefItem[] {
  if (b.error) return [];
  const items: BriefItem[] = [];
  const push = (kind: BriefKind, priority: number, params: BriefItem['params']) =>
    items.push({ id: `${kind}-${items.length}`, kind, priority, params });

  if (b.job.safety_flag) push('safety', 1, { note: clip(oneLine(b.job.safety_flag_note ?? ''), 160) });
  push('customer', 2, { name: b.customer?.name ?? b.job.customer_name, service: b.job.service_type ?? '' });

  for (const e of b.equipment.slice(0, 3)) {
    const label = oneLine([e.make, e.model, e.equipment_type].filter(Boolean).join(' '));
    const age = ageYears(e.install_date, now);
    push('equipment', 3, { label, age: age ?? '', warranty: warrantyState(e.warranty_expires_at, now) });
  }
  for (const n of b.previous_notes.slice(0, 2)) {
    const text = clip(oneLine(n.notes), 140);
    if (text) push('previous', 4, { date: n.date ? n.date.slice(0, 10) : '', text });
  }
  const openClaims = b.warranty_claims.filter((c) => !/^(closed|resolved|paid|denied|rejected)$/i.test(c.status));
  if (openClaims.length) push('claims', 5, { count: openClaims.length });
  if (b.likely_diagnosis) {
    push('diagnosis', 6, {
      severity: b.likely_diagnosis.severity,
      pct: b.likely_diagnosis.confidence === null ? '' : Math.round(Math.min(1, Math.max(0, b.likely_diagnosis.confidence)) * 100),
    });
  }
  const short = b.parts_check.filter((p) => p.shortage > 0);
  if (short.length) push('shortage', 7, { parts: short.slice(0, 4).map((p) => `${p.shortage} ${p.part_name}`).join(', ') });
  for (const p of b.customer_preferences.slice(0, 2)) push('preference', 8, { fact: clip(oneLine(p.fact), 100) });
  return items.sort((a, c) => a.priority - c.priority);
}

export const countWords = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** Keeps lines in priority order until the word budget is used; safety (priority 1) is always kept. */
export function fitSpoken(lines: { text: string; priority: number }[], maxWords = BRIEF_MAX_WORDS): string[] {
  const out: string[] = [];
  let used = 0;
  for (const l of [...lines].sort((a, b) => a.priority - b.priority)) {
    const w = countWords(l.text);
    if (l.priority > 1 && used + w > maxWords) continue; // skip, a shorter later line may still fit
    out.push(l.text);
    used += w;
  }
  return out;
}

export function estimateSeconds(lines: string[]): number {
  return Math.round((lines.reduce((n, l) => n + countWords(l), 0) / SPOKEN_WORDS_PER_MINUTE) * 60);
}
