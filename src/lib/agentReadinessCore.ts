// ============================================================
// Agent Readiness — client types and PURE helpers (no network, no Supabase import).
// The score, checks and fixes are computed server-side (supabase/functions/_shared/agent-readiness);
// this file only mirrors their JSON shape.
// ============================================================

export type SubscoreId = 'profile' | 'website' | 'phone' | 'reviews' | 'booking' | 'nap' | 'ai_visibility';
export const SUBSCORE_ORDER: readonly SubscoreId[] = ['profile', 'website', 'phone', 'reviews', 'booking', 'nap', 'ai_visibility'];
export type CheckStatus = 'pass' | 'partial' | 'fail' | 'not_measured';

export interface Evidence { k: string; p?: Record<string, string | number> }
export interface Check { ruleId: string; subscore: SubscoreId; status: CheckStatus; points: number; max: number; evidence: Evidence; fixKey?: string; sampled?: boolean }
export interface SubscoreResult { id: SubscoreId; score: number | null; measuredChecks: number; totalChecks: number }
export interface DiffRow { id: string; label: string; before: string; after: string }
export type FixKind = 'apply' | 'copy' | 'link' | 'task';
export interface Fix { key: string; kind: FixKind; ruleIds: string[]; impact: number; diff?: DiffRow[]; copyText?: string; href?: string; notes?: string[] }

export interface ScanSummary {
  id: string; created_at: string; source: 'manual' | 'weekly'; score: number | null; coverage: number;
  subscores: SubscoreResult[]; checks: Check[]; fixes: Fix[]; site: { ok?: boolean; code?: string; local_business?: boolean };
}
export interface FixAction { id: string; scan_id: string; fix_key: string; status: 'applied' | 'skipped' | 'undone'; changes: DiffRow[] }
export interface AlertRow { id: string; kind: 'score_drop' | 'hours_changed' | 'feed_stale' | 'site_regression' | 'site_unreachable'; detail: Record<string, string | number | boolean>; created_at: string; acknowledged_at: string | null }
export interface History { scans: { id: string; created_at: string; score: number | null; coverage: number; source: string }[]; weekly_calls: { week_start: string; calls: number }[] }

export interface PublicResult {
  ok: true; host: string; score: number | null; coverage: number; subscores: SubscoreResult[]; checks: Check[];
  topFixes: { ruleId: string; lost: number; evidence: Evidence }[];
}

export type ScoreTone = 'good' | 'ok' | 'poor';
export const scoreTone = (score: number | null): ScoreTone => (score === null ? 'poor' : score >= 80 ? 'good' : score >= 55 ? 'ok' : 'poor');
export const ringOffset = (score: number | null, circumference: number): number => circumference * (1 - Math.min(100, Math.max(0, score ?? 0)) / 100);
export const coveragePct = (coverage: number): number => Math.round(Math.min(1, Math.max(0, coverage)) * 100);
