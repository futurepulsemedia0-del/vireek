/**
 * AI Coaching Reports — client library.
 *
 * Does NOT run any new AI analysis. Call Intelligence
 * (_shared/ai-core/callIntelligence.ts, wired via
 * 20260917000000_call_intelligence.sql and
 * 20260922000000_call_intelligence_2_upsell_objection.sql) already scores
 * every call and writes `call_score`, `coaching_tip`, `objections_raised`,
 * `objections_resolved` and `upsell_opportunities` onto each row in
 * `calls`. This module only aggregates what's already there into a digest,
 * and optionally saves that digest as a named snapshot in
 * `coaching_reports` so it survives past the current date-range view.
 */

import { supabase, Call } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export interface CountedItem {
  text: string;
  count: number;
}

export interface ObjectionItem extends CountedItem {
  resolvedCount: number;
}

export interface ScoreDay {
  date: string;
  avgScore: number | null;
  count: number;
}

export interface LowScoringCall {
  id: string;
  callerName: string | null;
  callerPhone: string | null;
  callDatetime: string;
  score: number;
  coachingTip: string | null;
}

export interface CoachingMetrics {
  callsAnalyzed: number;
  avgCallScore: number | null;
  prevAvgCallScore: number | null;
  bookingRate: number | null;
  objectionResolutionRate: number | null;
  scoreByDay: ScoreDay[];
  topObjections: ObjectionItem[];
  topMissedUpsells: CountedItem[];
  recurringThemes: CountedItem[];
  lowestScoringCalls: LowScoringCall[];
}

export interface CoachingReport {
  id: string;
  user_id: string;
  period_start: string;
  period_end: string;
  calls_analyzed: number;
  avg_call_score: number | null;
  booking_rate: number | null;
  objection_resolution_rate: number | null;
  top_objections: ObjectionItem[];
  top_missed_upsells: CountedItem[];
  recurring_themes: CountedItem[];
  created_at: string;
}

// ============================================================
// AGGREGATION (pure — no network)
// ============================================================

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function tallyText(values: string[]): CountedItem[] {
  const counts = new Map<string, { display: string; count: number }>();
  for (const raw of values) {
    if (!raw || !raw.trim()) continue;
    const key = normalize(raw);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { display: raw.trim(), count: 1 });
  }
  return Array.from(counts.values())
    .map((v) => ({ text: v.display, count: v.count }))
    .sort((a, b) => b.count - a.count);
}

export function computeCoachingMetrics(
  callsInRange: Call[],
  prevRangeCalls: Call[],
): CoachingMetrics {
  const scored = callsInRange.filter((c) => c.call_score !== null && c.call_score !== undefined);

  const avgCallScore = scored.length > 0
    ? Math.round((scored.reduce((s, c) => s + (c.call_score ?? 0), 0) / scored.length) * 10) / 10
    : null;

  const prevScored = prevRangeCalls.filter((c) => c.call_score !== null && c.call_score !== undefined);
  const prevAvgCallScore = prevScored.length > 0
    ? Math.round((prevScored.reduce((s, c) => s + (c.call_score ?? 0), 0) / prevScored.length) * 10) / 10
    : null;

  const bookableOutcomes = callsInRange.filter(
    (c) => c.booking_outcome === 'booked' || c.booking_outcome === 'not_booked',
  );
  const bookingRate = bookableOutcomes.length > 0
    ? Math.round((bookableOutcomes.filter((c) => c.booking_outcome === 'booked').length / bookableOutcomes.length) * 1000) / 10
    : null;

  const callsWithObjections = callsInRange.filter((c) => c.objections_resolved !== null && c.objections_resolved !== undefined);
  const objectionResolutionRate = callsWithObjections.length > 0
    ? Math.round((callsWithObjections.filter((c) => c.objections_resolved === true).length / callsWithObjections.length) * 1000) / 10
    : null;

  // Score by day
  const dayMap = new Map<string, { total: number; count: number }>();
  for (const c of scored) {
    const day = new Date(c.call_datetime).toISOString().slice(0, 10);
    const entry = dayMap.get(day) ?? { total: 0, count: 0 };
    entry.total += c.call_score ?? 0;
    entry.count += 1;
    dayMap.set(day, entry);
  }
  const scoreByDay: ScoreDay[] = Array.from(dayMap.entries())
    .map(([date, v]) => ({ date, avgScore: Math.round((v.total / v.count) * 10) / 10, count: v.count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // Objections — resolvedCount tracked per normalized objection text, using
  // the call-level objections_resolved flag (objections aren't individually
  // flagged as resolved, so every objection on a resolved call counts as
  // resolved for that call).
  const objectionCounts = new Map<string, { display: string; count: number; resolvedCount: number }>();
  for (const c of callsInRange) {
    for (const raw of c.objections_raised ?? []) {
      if (!raw.trim()) continue;
      const key = normalize(raw);
      const existing = objectionCounts.get(key) ?? { display: raw.trim(), count: 0, resolvedCount: 0 };
      existing.count += 1;
      if (c.objections_resolved === true) existing.resolvedCount += 1;
      objectionCounts.set(key, existing);
    }
  }
  const topObjections: ObjectionItem[] = Array.from(objectionCounts.values())
    .map((v) => ({ text: v.display, count: v.count, resolvedCount: v.resolvedCount }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // Missed upsells — every entry in upsell_opportunities is, by definition
  // (see callIntelligence.ts), something detected but NOT offered/booked.
  const allUpsells = callsInRange.flatMap((c) => c.upsell_opportunities ?? []);
  const topMissedUpsells = tallyText(allUpsells).slice(0, 8);

  // Recurring coaching themes — exact-match grouping of coaching_tip text.
  // Deliberately not fuzzy/NLP grouping: an exact-match count is honest
  // about what it's counting, where a similarity heuristic would invite
  // second-guessing why two different tips were or weren't merged.
  const allTips = callsInRange.map((c) => c.coaching_tip).filter((t): t is string => Boolean(t && t.trim()));
  const recurringThemes = tallyText(allTips).slice(0, 8);

  // Lowest-scoring calls — the concrete drill-down for a coaching session.
  const lowestScoringCalls: LowScoringCall[] = [...scored]
    .sort((a, b) => (a.call_score ?? 0) - (b.call_score ?? 0))
    .slice(0, 5)
    .map((c) => ({
      id: c.id,
      callerName: c.caller_name,
      callerPhone: c.caller_phone,
      callDatetime: c.call_datetime,
      score: c.call_score ?? 0,
      coachingTip: c.coaching_tip,
    }));

  return {
    callsAnalyzed: scored.length,
    avgCallScore,
    prevAvgCallScore,
    bookingRate,
    objectionResolutionRate,
    scoreByDay,
    topObjections,
    topMissedUpsells,
    recurringThemes,
    lowestScoringCalls,
  };
}

// ============================================================
// PERSISTENCE
// ============================================================

export async function saveCoachingReport(
  metrics: CoachingMetrics,
  periodStart: Date,
  periodEnd: Date,
  userId: string,
): Promise<CoachingReport> {
  const payload = {
    user_id: userId,
    period_start: periodStart.toISOString().slice(0, 10),
    period_end: periodEnd.toISOString().slice(0, 10),
    calls_analyzed: metrics.callsAnalyzed,
    avg_call_score: metrics.avgCallScore,
    booking_rate: metrics.bookingRate,
    objection_resolution_rate: metrics.objectionResolutionRate,
    top_objections: metrics.topObjections,
    top_missed_upsells: metrics.topMissedUpsells,
    recurring_themes: metrics.recurringThemes,
  };
  const { data, error } = await supabase.from('coaching_reports').insert(payload).select().single();
  if (error) throw error;
  return data as CoachingReport;
}

export async function fetchCoachingReports(): Promise<CoachingReport[]> {
  const { data, error } = await supabase
    .from('coaching_reports')
    .select('*')
    .order('period_start', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data as CoachingReport[]) ?? [];
}

export async function deleteCoachingReport(id: string): Promise<void> {
  const { error } = await supabase.from('coaching_reports').delete().eq('id', id);
  if (error) throw error;
}
