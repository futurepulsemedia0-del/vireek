/**
 * Customer-success tasks — pure logic (no I/O).
 *
 * Turns the existing staff at-risk rows (buildStaffSuccessRows -> computeSuccessRisk) into candidates for the
 * staff-only `staff_cs_tasks` table (migration 20290304000000_staff_cs_tasks.sql). Risk is never recomputed here.
 */

import type { StaffSuccessRow } from '@/lib/successTools';

export const CS_TASK_MAX_BATCH = 200; // keep in sync with staff_sync_cs_tasks
const TITLE_MAX = 200;
const REASON_MAX = 300;
const REASONS_MAX = 3;
const ACTION_MAX = 300;
const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CsTaskRisk = 'high' | 'medium';
export type CsTaskStatus = 'open' | 'in_progress';

export interface CsTaskCandidate {
  account_id: string;
  risk_level: CsTaskRisk;
  risk_score: number | null;
  title: string;
  reasons: string[];
  suggested_action: string;
}

export interface CsTask {
  id: string;
  accountId: string;
  riskLevel: CsTaskRisk;
  riskScore: number | null;
  title: string;
  reasons: string[];
  suggestedAction: string | null;
  status: CsTaskStatus;
  dueAt: string;
  assigned: boolean;
  mine: boolean;
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** High first, then lowest blended score, then label. Only high/medium accounts with a valid id. Capped at the server limit. */
export function buildCsTaskCandidates(rows: StaffSuccessRow[]): CsTaskCandidate[] {
  return rows
    .filter((r) => (r.risk.level === 'high' || r.risk.level === 'medium') && UUID_RE.test(r.id))
    .sort(
      (a, b) =>
        (a.risk.level === 'high' ? 0 : 1) - (b.risk.level === 'high' ? 0 : 1) ||
        (a.risk.score ?? 101) - (b.risk.score ?? 101) ||
        a.label.localeCompare(b.label),
    )
    .slice(0, CS_TASK_MAX_BATCH)
    .map((r) => ({
      account_id: r.id,
      risk_level: r.risk.level as CsTaskRisk,
      risk_score: r.risk.score === null ? null : Math.min(100, Math.max(0, Math.round(r.risk.score))),
      title: clip(`${r.label || 'Account'} — ${r.risk.level} churn risk`, TITLE_MAX),
      reasons: r.risk.reasons.slice(0, REASONS_MAX).map((x) => clip(x.text, REASON_MAX)),
      suggested_action: clip(r.risk.action, ACTION_MAX),
    }));
}

export function parseCsTasks(raw: unknown): CsTask[] {
  const list = (raw as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(list)) return [];
  const out: CsTask[] = [];
  for (const x of list) {
    const o = (x ?? {}) as Record<string, unknown>;
    const level = o.risk_level === 'high' ? 'high' : o.risk_level === 'medium' ? 'medium' : null;
    const status = o.status === 'in_progress' ? 'in_progress' : o.status === 'open' ? 'open' : null;
    if (typeof o.id !== 'string' || typeof o.account_id !== 'string' || typeof o.title !== 'string' || typeof o.due_at !== 'string' || !level || !status) continue;
    out.push({
      id: o.id,
      accountId: o.account_id,
      riskLevel: level,
      riskScore: typeof o.risk_score === 'number' ? o.risk_score : null,
      title: o.title,
      reasons: Array.isArray(o.reasons) ? o.reasons.filter((r): r is string => typeof r === 'string') : [],
      suggestedAction: typeof o.suggested_action === 'string' ? o.suggested_action : null,
      status,
      dueAt: o.due_at,
      assigned: o.assigned === true,
      mine: o.mine === true,
    });
  }
  return out;
}

/** "Overdue by 2d" / "Due today" / "Due in 3d" — whole days, no locale APIs. */
export function dueLabel(dueAt: string, now: Date = new Date()): { text: string; overdue: boolean } {
  const t = Date.parse(dueAt);
  if (!Number.isFinite(t)) return { text: 'No due date', overdue: false };
  const diff = t - now.getTime();
  if (diff < 0) return { text: `Overdue by ${Math.max(1, Math.floor(-diff / DAY_MS))}d`, overdue: true };
  const days = Math.floor(diff / DAY_MS);
  return { text: days === 0 ? 'Due today' : `Due in ${days}d`, overdue: false };
}
