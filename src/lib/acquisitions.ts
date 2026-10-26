/**
 * Acquisition Integration Toolkit — pure logic for /dashboard/acquisitions.
 *
 * Framework-free and timezone-safe: calendar days are plain "YYYY-MM-DD" strings handled with UTC arithmetic,
 * and "today" is always passed in. The database is the authority (supabase/migrations/20271115000000_
 * acquisition_integration_toolkit.sql); this file mirrors its rules (check bands, plan-to-date, dependency
 * gating) so the UI can explain before a request is sent, and never trusts a row it has not normalized.
 */

export type AcquisitionStatus = 'planned' | 'integrating' | 'completed' | 'on_hold';
export type ScopeKind = 'linked_account' | 'imported' | 'external';
export type Phase = 'day_30' | 'day_60' | 'day_90';
export type WorkstreamStatus = 'not_started' | 'in_progress' | 'blocked' | 'done' | 'skipped';
export type WorkstreamKind =
  | 'license_insurance' | 'customer_comms' | 'phone_porting' | 'data_import' | 'tech_payroll_onboarding'
  | 'accounting_tax' | 'price_book' | 'brand_transition' | 'systems_cutover' | 'custom';
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type SynergyKind = 'cost_savings' | 'revenue_lift';
export type SynergyStatus = 'planned' | 'in_progress' | 'realized' | 'at_risk' | 'dropped';
export type ControlKey = 'customers_count' | 'jobs_count' | 'invoiced_cents' | 'paid_cents' | 'open_ar_cents';

export const STATUSES: readonly AcquisitionStatus[] = ['planned', 'integrating', 'completed', 'on_hold'];
export const SCOPES: readonly ScopeKind[] = ['linked_account', 'imported', 'external'];
export const PHASES: readonly Phase[] = ['day_30', 'day_60', 'day_90'];
export const WS_STATUSES: readonly WorkstreamStatus[] = ['not_started', 'in_progress', 'blocked', 'done', 'skipped'];
export const SYNERGY_STATUSES: readonly SynergyStatus[] = ['planned', 'in_progress', 'realized', 'at_risk', 'dropped'];
export const SYNERGY_CATEGORIES = ['procurement', 'insurance', 'software', 'facilities', 'headcount', 'fleet', 'pricing', 'cross_sell', 'retention', 'other'] as const;
export type SynergyCategory = (typeof SYNERGY_CATEGORIES)[number];

export const STATUS_LABELS: Record<AcquisitionStatus, string> = { planned: 'Planned', integrating: 'Integrating', completed: 'Completed', on_hold: 'On hold' };
export const SCOPE_LABELS: Record<ScopeKind, string> = { linked_account: 'Linked Vireek account', imported: 'Imported into this account', external: 'Not on Vireek yet' };
export const SCOPE_HELP: Record<ScopeKind, string> = {
  linked_account: 'The business runs on its own Vireek account linked through Franchise. Numbers are live.',
  imported: 'You imported its customers and jobs with the Import Wizard. Link those runs to see its numbers.',
  external: 'Track the plan and enter the seller’s baseline by hand. No live numbers.',
};
export const PHASE_LABELS: Record<Phase, string> = { day_30: 'Days 0–30', day_60: 'Days 31–60', day_90: 'Days 61–90' };
export const WS_STATUS_LABELS: Record<WorkstreamStatus, string> = { not_started: 'Not started', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', skipped: 'Skipped' };
export const KIND_LABELS: Record<WorkstreamKind, string> = {
  license_insurance: 'License & insurance', customer_comms: 'Customer communication', phone_porting: 'Phone porting', data_import: 'Data import & reconciliation',
  tech_payroll_onboarding: 'Technician & payroll', accounting_tax: 'Accounting & tax', price_book: 'Price book', brand_transition: 'Brand transition',
  systems_cutover: 'Systems cutover', custom: 'Custom',
};
export const SYNERGY_KIND_LABELS: Record<SynergyKind, string> = { cost_savings: 'Cost savings', revenue_lift: 'Revenue lift' };
export const SYNERGY_STATUS_LABELS: Record<SynergyStatus, string> = { planned: 'Planned', in_progress: 'In progress', realized: 'Realized', at_risk: 'At risk', dropped: 'Dropped' };
export const SYNERGY_CATEGORY_LABELS: Record<SynergyCategory, string> = {
  procurement: 'Procurement', insurance: 'Insurance', software: 'Software', facilities: 'Facilities', headcount: 'Headcount',
  fleet: 'Fleet', pricing: 'Pricing', cross_sell: 'Cross-sell', retention: 'Retention', other: 'Other',
};

export const CONTROL_KEYS: readonly ControlKey[] = ['customers_count', 'jobs_count', 'invoiced_cents', 'paid_cents', 'open_ar_cents'];
export const CONTROL_META: Record<ControlKey, { label: string; money: boolean; help: string }> = {
  customers_count: { label: 'Customers', money: false, help: 'Total customer records in the seller’s system.' },
  jobs_count: { label: 'Jobs', money: false, help: 'Total jobs / work orders exported.' },
  invoiced_cents: { label: 'Invoiced total', money: true, help: 'Sum of sent + paid invoices.' },
  paid_cents: { label: 'Paid total', money: true, help: 'Sum of paid invoices.' },
  open_ar_cents: { label: 'Open receivables', money: true, help: 'Sent but unpaid invoices.' },
};

export const TITLE_LIMIT = 120;
export const NOTE_LIMIT = 2000;
export const MAX_CENTS = 100_000_000_000;
export const WINDOW_DAYS = 90;
export const DUE_SOON_DAYS = 7;

// ---------------------------------------------------------------------------------------------- dates
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const toUtc = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export function addDays(iso: string, n: number): string {
  const t = new Date(toUtc(iso) + n * 86_400_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
/** Whole days from a to b (b − a). */
export function diffDays(a: string, b: string): number { return Math.round((toUtc(b) - toUtc(a)) / 86_400_000); }
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
/** Integration day: 0 on the close date, negative before it. */
export function dayNumber(closeDate: string, today: string): number { return diffDays(closeDate, today); }
export function currentPhase(day: number): Phase | 'post' | 'pre' {
  if (day < 0) return 'pre';
  if (day <= 30) return 'day_30';
  if (day <= 60) return 'day_60';
  if (day <= 90) return 'day_90';
  return 'post';
}
export function monthStart(iso: string): string { return `${iso.slice(0, 7)}-01`; }
export function monthsBetweenInclusive(startIso: string, asOfIso: string): number {
  const [sy, sm] = startIso.split('-').map(Number);
  const [ay, am] = asOfIso.split('-').map(Number);
  return Math.max(0, (ay - sy) * 12 + (am - sm) + 1);
}

// ---------------------------------------------------------------------------------------------- types
export interface Acquisition {
  id: string; name: string; legal_name: string | null; status: AcquisitionStatus; close_date: string; scope_kind: ScopeKind;
  franchise_location_id: string | null; brand_id: string | null; location_id: string | null; purchase_price_cents: number | null;
  currency: string; target_jobs_per_tech_day: number; notes: string | null;
}
export interface Workstream {
  id: string; acquisition_id: string; kind: WorkstreamKind; title: string; description: string | null; phase: Phase;
  owner_member_id: string | null; owner_label: string | null; due_date: string | null; status: WorkstreamStatus;
  sort_order: number; notes: string | null; completed_at: string | null;
}
export interface Dep { workstream_id: string; depends_on_id: string }
export interface SourceControl { id: string; acquisition_id: string; metric_key: ControlKey; source_value: number; tolerance_pct: number; source_label: string | null; as_of: string | null }
export interface DataCheck {
  id: string; run_id: string; check_key: string; label: string; status: CheckStatus; source_value: number | null; actual_value: number | null;
  diff: number | null; diff_pct: number | null; tolerance_pct: number | null; detail: string | null; checked_at: string;
}
export interface Synergy {
  id: string; acquisition_id: string; kind: SynergyKind; category: SynergyCategory; title: string; plan_annual_cents: number;
  start_date: string; status: SynergyStatus; notes: string | null;
}
export interface SynergyActual { id: string; synergy_id: string; period_month: string; actual_cents: number; note: string | null }

export const KPI_KEYS = ['revenue_cents', 'jobs_count', 'avg_ticket_cents', 'gross_margin_pct', 'utilization_pct', 'retention_pct', 'open_ar_cents'] as const;
export type KpiKey = (typeof KPI_KEYS)[number];
export type Kpis = Partial<Record<KpiKey | 'margin_coverage_pct' | 'technicians' | 'retention_at_risk' | 'retention_base', number | null>>;
export const KPI_META: Record<KpiKey, { label: string; unit: 'cents' | 'count' | 'pct'; higherIsBetter: boolean; comparable: boolean; help: string }> = {
  revenue_cents: { label: 'Revenue (90 days)', unit: 'cents', higherIsBetter: true, comparable: false, help: 'Paid invoices on jobs from the last 90 days.' },
  jobs_count: { label: 'Jobs (90 days)', unit: 'count', higherIsBetter: true, comparable: false, help: 'Jobs excluding cancelled and no-shows.' },
  avg_ticket_cents: { label: 'Average ticket', unit: 'cents', higherIsBetter: true, comparable: true, help: 'Revenue divided by paid jobs.' },
  gross_margin_pct: { label: 'Gross margin', unit: 'pct', higherIsBetter: true, comparable: true, help: 'Only jobs that have cost entries; see coverage.' },
  utilization_pct: { label: 'Utilization', unit: 'pct', higherIsBetter: true, comparable: true, help: 'Assigned jobs vs technicians × working days × target jobs per tech-day.' },
  retention_pct: { label: 'Customer retention', unit: 'pct', higherIsBetter: true, comparable: true, help: 'Customers served 91–180 days ago who were served again in the last 90.' },
  open_ar_cents: { label: 'Open receivables', unit: 'cents', higherIsBetter: false, comparable: false, help: 'Sent but unpaid invoices.' },
};
export interface Baseline { as_of: string; source: 'manual' | 'computed'; metrics: Kpis; note: string | null; captured_at: string | null }
export interface KpiReport { scope_kind: ScopeKind; close_date: string; has_live_data: boolean; parent: Kpis | null; now: Kpis | null; baseline: Baseline | null }
export interface PortfolioRow {
  id: string; name: string; status: AcquisitionStatus; close_date: string; scope_kind: ScopeKind; currency: string; purchase_price_cents: number | null;
  has_live_data: boolean; kpis: Kpis | null; baseline: Kpis | null; ws_total: number; ws_done: number; ws_overdue: number; ws_blocked: number;
  cost_plan_cents: number; cost_actual_cents: number; rev_plan_cents: number; rev_actual_cents: number;
}
export interface Portfolio { parent: Kpis | null; companies: PortfolioRow[] }

// ---------------------------------------------------------------------------------------------- normalizers
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback);
const KINDS = Object.keys(KIND_LABELS) as WorkstreamKind[];

export function normalizeAcquisition(row: unknown): Acquisition | null {
  if (!isObj(row)) return null;
  const id = str(row.id); const name = str(row.name);
  if (!id || !name || !isIsoDate(row.close_date)) return null;
  return {
    id, name, legal_name: str(row.legal_name), status: oneOf(row.status, STATUSES, 'integrating'), close_date: row.close_date,
    scope_kind: oneOf(row.scope_kind, SCOPES, 'external'), franchise_location_id: str(row.franchise_location_id), brand_id: str(row.brand_id),
    location_id: str(row.location_id), purchase_price_cents: num(row.purchase_price_cents), currency: str(row.currency) ?? 'USD',
    target_jobs_per_tech_day: num(row.target_jobs_per_tech_day) ?? 4, notes: str(row.notes),
  };
}
export function normalizeWorkstream(row: unknown): Workstream | null {
  if (!isObj(row)) return null;
  const id = str(row.id); const acq = str(row.acquisition_id); const title = str(row.title);
  if (!id || !acq || !title) return null;
  return {
    id, acquisition_id: acq, kind: oneOf(row.kind, KINDS, 'custom'), title, description: str(row.description), phase: oneOf(row.phase, PHASES, 'day_30'),
    owner_member_id: str(row.owner_member_id), owner_label: str(row.owner_label), due_date: isIsoDate(row.due_date) ? row.due_date : null,
    status: oneOf(row.status, WS_STATUSES, 'not_started'), sort_order: num(row.sort_order) ?? 0, notes: str(row.notes), completed_at: str(row.completed_at),
  };
}
export function normalizeDep(row: unknown): Dep | null {
  if (!isObj(row)) return null;
  const a = str(row.workstream_id); const b = str(row.depends_on_id);
  return a && b && a !== b ? { workstream_id: a, depends_on_id: b } : null;
}
export function normalizeControl(row: unknown): SourceControl | null {
  if (!isObj(row)) return null;
  const id = str(row.id); const acq = str(row.acquisition_id); const v = num(row.source_value);
  if (!id || !acq || v === null || !CONTROL_KEYS.includes(row.metric_key as ControlKey)) return null;
  return { id, acquisition_id: acq, metric_key: row.metric_key as ControlKey, source_value: v, tolerance_pct: num(row.tolerance_pct) ?? 0, source_label: str(row.source_label), as_of: isIsoDate(row.as_of) ? row.as_of : null };
}
export function normalizeCheck(row: unknown): DataCheck | null {
  if (!isObj(row)) return null;
  const id = str(row.id); const run = str(row.run_id); const key = str(row.check_key); const label = str(row.label); const at = str(row.checked_at);
  if (!id || !run || !key || !label || !at) return null;
  return { id, run_id: run, check_key: key, label, status: oneOf(row.status, ['pass', 'warn', 'fail', 'skip'] as const, 'skip'), source_value: num(row.source_value), actual_value: num(row.actual_value), diff: num(row.diff), diff_pct: num(row.diff_pct), tolerance_pct: num(row.tolerance_pct), detail: str(row.detail), checked_at: at };
}
export function normalizeSynergy(row: unknown): Synergy | null {
  if (!isObj(row)) return null;
  const id = str(row.id); const acq = str(row.acquisition_id); const title = str(row.title); const plan = num(row.plan_annual_cents);
  if (!id || !acq || !title || plan === null || !isIsoDate(row.start_date)) return null;
  return { id, acquisition_id: acq, kind: row.kind === 'revenue_lift' ? 'revenue_lift' : 'cost_savings', category: oneOf(row.category, SYNERGY_CATEGORIES, 'other'), title, plan_annual_cents: plan, start_date: row.start_date, status: oneOf(row.status, SYNERGY_STATUSES, 'planned'), notes: str(row.notes) };
}
export function normalizeActual(row: unknown): SynergyActual | null {
  if (!isObj(row)) return null;
  const id = str(row.id); const syn = str(row.synergy_id); const c = num(row.actual_cents);
  if (!id || !syn || c === null || !isIsoDate(row.period_month)) return null;
  return { id, synergy_id: syn, period_month: row.period_month, actual_cents: c, note: str(row.note) };
}
export function normalizeKpis(v: unknown): Kpis | null {
  if (!isObj(v)) return null;
  const out: Kpis = {};
  for (const k of [...KPI_KEYS, 'margin_coverage_pct', 'technicians', 'retention_at_risk', 'retention_base'] as const) out[k] = num(v[k]);
  return out;
}
export function normalizeReport(v: unknown): KpiReport | null {
  if (!isObj(v) || !isIsoDate(v.close_date)) return null;
  let baseline: Baseline | null = null;
  if (isObj(v.baseline) && isIsoDate(v.baseline.as_of)) {
    baseline = { as_of: v.baseline.as_of, source: v.baseline.source === 'computed' ? 'computed' : 'manual', metrics: normalizeKpis(v.baseline.metrics) ?? {}, note: str(v.baseline.note), captured_at: str(v.baseline.captured_at) };
  }
  return { scope_kind: oneOf(v.scope_kind, SCOPES, 'external'), close_date: v.close_date, has_live_data: v.has_live_data === true, parent: normalizeKpis(v.parent), now: normalizeKpis(v.now), baseline };
}
export function normalizePortfolio(v: unknown): Portfolio {
  if (!isObj(v)) return { parent: null, companies: [] };
  const list = Array.isArray(v.companies) ? v.companies : [];
  const companies: PortfolioRow[] = [];
  for (const r of list) {
    if (!isObj(r)) continue;
    const id = str(r.id); const name = str(r.name);
    if (!id || !name || !isIsoDate(r.close_date)) continue;
    companies.push({
      id, name, status: oneOf(r.status, STATUSES, 'integrating'), close_date: r.close_date, scope_kind: oneOf(r.scope_kind, SCOPES, 'external'), currency: str(r.currency) ?? 'USD',
      purchase_price_cents: num(r.purchase_price_cents), has_live_data: r.has_live_data === true, kpis: normalizeKpis(r.kpis), baseline: normalizeKpis(r.baseline),
      ws_total: num(r.ws_total) ?? 0, ws_done: num(r.ws_done) ?? 0, ws_overdue: num(r.ws_overdue) ?? 0, ws_blocked: num(r.ws_blocked) ?? 0,
      cost_plan_cents: num(r.cost_plan_cents) ?? 0, cost_actual_cents: num(r.cost_actual_cents) ?? 0, rev_plan_cents: num(r.rev_plan_cents) ?? 0, rev_actual_cents: num(r.rev_actual_cents) ?? 0,
    });
  }
  return { parent: normalizeKpis(v.parent), companies };
}
export function normalizeList<T>(rows: unknown, fn: (r: unknown) => T | null): T[] {
  if (!Array.isArray(rows)) return [];
  const out: T[] = [];
  for (const r of rows) { const n = fn(r); if (n) out.push(n); }
  return out;
}

// ---------------------------------------------------------------------------------------------- workstreams
export type DueState = 'closed' | 'overdue' | 'due_soon' | 'upcoming' | 'no_date';
export const isClosed = (s: WorkstreamStatus) => s === 'done' || s === 'skipped';

export function dueState(ws: Pick<Workstream, 'status' | 'due_date'>, today: string): DueState {
  if (isClosed(ws.status)) return 'closed';
  if (!ws.due_date) return 'no_date';
  const left = diffDays(today, ws.due_date);
  if (left < 0) return 'overdue';
  return left <= DUE_SOON_DAYS ? 'due_soon' : 'upcoming';
}
export function openDependencies(wsId: string, workstreams: Workstream[], deps: Dep[]): Workstream[] {
  const byId = new Map(workstreams.map((w) => [w.id, w]));
  const out: Workstream[] = [];
  for (const d of deps) {
    if (d.workstream_id !== wsId) continue;
    const up = byId.get(d.depends_on_id);
    if (up && !isClosed(up.status)) out.push(up);
  }
  return out;
}
/** Mirrors acq_workstream_guard: starting or finishing needs every dependency done/skipped. */
export function canMoveTo(target: WorkstreamStatus, wsId: string, workstreams: Workstream[], deps: Dep[]): { ok: boolean; reason?: string } {
  if (target !== 'in_progress' && target !== 'done') return { ok: true };
  const open = openDependencies(wsId, workstreams, deps);
  if (open.length === 0) return { ok: true };
  return { ok: false, reason: `Waiting on: ${open.map((w) => w.title).join(', ')}` };
}
/** Mirrors the cycle check: would "child depends on parent" close a loop? */
export function wouldCreateCycle(childId: string, parentId: string, deps: Dep[]): boolean {
  if (childId === parentId) return true;
  const seen = new Set<string>();
  const stack = [parentId];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (cur === childId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const d of deps) if (d.workstream_id === cur) stack.push(d.depends_on_id);
  }
  return false;
}
export function groupByPhase(list: Workstream[]): Record<Phase, Workstream[]> {
  const out: Record<Phase, Workstream[]> = { day_30: [], day_60: [], day_90: [] };
  for (const w of [...list].sort((a, b) => a.sort_order - b.sort_order)) out[w.phase].push(w);
  return out;
}
export interface Progress { total: number; closed: number; pct: number; overdue: number; blocked: number; inProgress: number }
export function progress(list: Workstream[], today: string): Progress {
  const total = list.length;
  const closed = list.filter((w) => isClosed(w.status)).length;
  return {
    total, closed, pct: total === 0 ? 0 : Math.round((closed / total) * 100),
    overdue: list.filter((w) => dueState(w, today) === 'overdue').length,
    blocked: list.filter((w) => w.status === 'blocked').length,
    inProgress: list.filter((w) => w.status === 'in_progress').length,
  };
}
/** Workstreams that can be worked on right now (open, nothing in front of them), most urgent first. */
export function readyToStart(list: Workstream[], deps: Dep[]): Workstream[] {
  return list
    .filter((w) => (w.status === 'not_started' || w.status === 'blocked') && openDependencies(w.id, list, deps).length === 0)
    .sort((a, b) => (a.due_date ?? '9999-12-31').localeCompare(b.due_date ?? '9999-12-31') || a.sort_order - b.sort_order);
}

// ---------------------------------------------------------------------------------------------- data checks (mirror acq_run_data_checks)
export function evaluateControl(source: number, actual: number, tolerancePct: number): { status: CheckStatus; diff: number; diffPct: number } {
  const diff = actual - source;
  const diffPct = source > 0 ? (Math.abs(diff) * 100) / source : diff === 0 ? 0 : 100;
  const status: CheckStatus = diffPct <= tolerancePct ? 'pass' : diffPct <= Math.max(tolerancePct * 2, 1) ? 'warn' : 'fail';
  return { status, diff, diffPct: Math.round(diffPct * 100) / 100 };
}
export function latestRun(checks: DataCheck[]): DataCheck[] {
  if (checks.length === 0) return [];
  let best = checks[0];
  for (const c of checks) if (c.checked_at > best.checked_at) best = c;
  return checks.filter((c) => c.run_id === best.run_id);
}
export function checkSummary(checks: DataCheck[]): { pass: number; warn: number; fail: number; skip: number; verdict: 'clean' | 'review' | 'blocked' | 'none' } {
  const s = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) s[c.status] += 1;
  const verdict = checks.length === 0 ? 'none' : s.fail > 0 ? 'blocked' : s.warn > 0 || s.skip > 0 ? 'review' : 'clean';
  return { ...s, verdict };
}

// ---------------------------------------------------------------------------------------------- KPIs
export interface KpiDelta { diff: number; label: string; tone: 'good' | 'bad' | 'neutral' }
/** Rate-style KPIs only: percentage-point gap for pct KPIs, relative % for the average ticket. */
export function kpiDelta(key: KpiKey, acquired: number | null | undefined, parent: number | null | undefined): KpiDelta | null {
  const meta = KPI_META[key];
  if (!meta.comparable || acquired == null || parent == null) return null;
  let diff: number; let label: string;
  if (meta.unit === 'pct') { diff = Math.round((acquired - parent) * 10) / 10; label = `${diff > 0 ? '+' : ''}${diff} pts`; }
  else { if (parent === 0) return null; diff = Math.round(((acquired - parent) / parent) * 1000) / 10; label = `${diff > 0 ? '+' : ''}${diff}%`; }
  const tone = diff === 0 ? 'neutral' : (diff > 0) === meta.higherIsBetter ? 'good' : 'bad';
  return { diff, label, tone };
}
export type Risk = 'high' | 'medium' | 'low' | 'unknown';
/** Retention risk from the retention rate (and how it compares with the parent when known). */
export function retentionRisk(retentionPct: number | null | undefined, parentPct?: number | null): Risk {
  if (retentionPct == null) return 'unknown';
  if (retentionPct < 50) return 'high';
  if (retentionPct < 65 || (parentPct != null && retentionPct < parentPct - 15)) return 'medium';
  return 'low';
}
export type Health = 'on_track' | 'watch' | 'at_risk' | 'not_started';
export function integrationHealth(row: Pick<PortfolioRow, 'ws_total' | 'ws_done' | 'ws_overdue' | 'ws_blocked' | 'status'>): Health {
  if (row.status === 'completed') return 'on_track';
  if (row.ws_total === 0) return 'not_started';
  if (row.ws_overdue >= 2 || row.ws_blocked >= 2) return 'at_risk';
  return row.ws_overdue > 0 || row.ws_blocked > 0 ? 'watch' : 'on_track';
}
export function portfolioTotals(rows: PortfolioRow[]) {
  let revenue = 0; let atRisk = 0; let costPlan = 0; let costActual = 0; let revPlan = 0; let revActual = 0;
  let mNum = 0; let mDen = 0; let uSum = 0; let uN = 0;
  for (const r of rows) {
    const k = r.kpis;
    costPlan += r.cost_plan_cents; costActual += r.cost_actual_cents; revPlan += r.rev_plan_cents; revActual += r.rev_actual_cents;
    if (!k) continue;
    const rev = k.revenue_cents ?? 0;
    revenue += rev; atRisk += k.retention_at_risk ?? 0;
    if (k.gross_margin_pct != null && rev > 0) { mNum += k.gross_margin_pct * rev; mDen += rev; }
    if (k.utilization_pct != null) { uSum += k.utilization_pct; uN += 1; }
  }
  return {
    companies: rows.length, active: rows.filter((r) => r.status === 'integrating' || r.status === 'planned').length, revenue,
    margin: mDen > 0 ? Math.round((mNum / mDen) * 10) / 10 : null, utilization: uN > 0 ? Math.round((uSum / uN) * 10) / 10 : null,
    retentionAtRisk: atRisk, costPlan, costActual, revPlan, revActual,
  };
}

// ---------------------------------------------------------------------------------------------- synergies (mirror acq_portfolio)
export function planToDate(planAnnualCents: number, startDate: string, asOf: string): number {
  return Math.round((planAnnualCents / 12) * monthsBetweenInclusive(startDate, asOf));
}
export interface SynergyLine { synergy: Synergy; planToDate: number; actual: number; variance: number; pct: number | null }
export function synergyLine(s: Synergy, actuals: SynergyActual[], asOf: string): SynergyLine {
  const actual = actuals.filter((a) => a.synergy_id === s.id).reduce((t, a) => t + a.actual_cents, 0);
  const plan = planToDate(s.plan_annual_cents, s.start_date, asOf);
  return { synergy: s, planToDate: plan, actual, variance: actual - plan, pct: plan > 0 ? Math.round((actual / plan) * 1000) / 10 : null };
}
export function synergyRollup(list: Synergy[], actuals: SynergyActual[], asOf: string) {
  const live = list.filter((s) => s.status !== 'dropped').map((s) => synergyLine(s, actuals, asOf));
  const sum = (kind: SynergyKind) => {
    const rows = live.filter((l) => l.synergy.kind === kind);
    const plan = rows.reduce((t, l) => t + l.planToDate, 0); const actual = rows.reduce((t, l) => t + l.actual, 0);
    return { plan, actual, variance: actual - plan, pct: plan > 0 ? Math.round((actual / plan) * 1000) / 10 : null, annual: rows.reduce((t, l) => t + l.synergy.plan_annual_cents, 0) };
  };
  return { cost: sum('cost_savings'), revenue: sum('revenue_lift'), lines: live };
}

// ---------------------------------------------------------------------------------------------- money & formatting
export function parseMoneyToCents(input: string): number | null {
  const t = input.replace(/[,\s$]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}
export function formatCents(cents: number | null | undefined, currency = 'USD'): string {
  if (cents == null) return '—';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100); }
  catch { return `${Math.round(cents / 100)}`; }
}
export function formatKpi(key: KpiKey, v: number | null | undefined, currency = 'USD'): string {
  if (v == null) return '—';
  const u = KPI_META[key].unit;
  return u === 'cents' ? formatCents(v, currency) : u === 'pct' ? `${v.toFixed(1)}%` : Math.round(v).toLocaleString('en-US');
}
export const formatPct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`);

// ---------------------------------------------------------------------------------------------- validation
export interface NewAcquisitionDraft {
  name: string; legal_name: string; close_date: string; scope_kind: ScopeKind; franchise_location_id: string; brand_id: string;
  location_id: string; purchase_price: string; currency: string; notes: string;
}
export const EMPTY_DRAFT = (today: string): NewAcquisitionDraft => ({ name: '', legal_name: '', close_date: today, scope_kind: 'imported', franchise_location_id: '', brand_id: '', location_id: '', purchase_price: '', currency: 'USD', notes: '' });
export type Errors<T> = Partial<Record<keyof T, string>>;

export function validateNewAcquisition(d: NewAcquisitionDraft, today: string): Errors<NewAcquisitionDraft> {
  const e: Errors<NewAcquisitionDraft> = {};
  const name = d.name.trim();
  if (name.length < 1) e.name = 'Enter the business name.'; else if (name.length > TITLE_LIMIT) e.name = `Keep it under ${TITLE_LIMIT} characters.`;
  if (d.legal_name.length > 160) e.legal_name = 'Keep it under 160 characters.';
  if (!isIsoDate(d.close_date)) e.close_date = 'Pick the closing date.';
  else if (diffDays(today, d.close_date) > 730 || diffDays(d.close_date, today) > 3650) e.close_date = 'The closing date must be within the last 10 years or the next 2.';
  if (d.scope_kind === 'linked_account' && !d.franchise_location_id) e.franchise_location_id = 'Choose the linked account.';
  if (d.purchase_price.trim() !== '') {
    const c = parseMoneyToCents(d.purchase_price);
    if (c === null || c < 0 || c > MAX_CENTS) e.purchase_price = 'Enter a valid amount, e.g. 1250000.';
  }
  if (!/^[A-Za-z]{3}$/.test(d.currency.trim())) e.currency = 'Use a 3-letter currency code.';
  if (d.notes.length > NOTE_LIMIT) e.notes = `Keep notes under ${NOTE_LIMIT} characters.`;
  return e;
}
export interface SynergyDraft { kind: SynergyKind; category: SynergyCategory; title: string; plan_annual: string; start_date: string; status: SynergyStatus; notes: string }
export function validateSynergy(d: SynergyDraft): Errors<SynergyDraft> {
  const e: Errors<SynergyDraft> = {};
  if (d.title.trim().length < 1) e.title = 'Give the synergy a name.'; else if (d.title.trim().length > TITLE_LIMIT) e.title = `Keep it under ${TITLE_LIMIT} characters.`;
  const c = parseMoneyToCents(d.plan_annual);
  if (c === null || c < 0 || c > MAX_CENTS) e.plan_annual = 'Enter the planned annual amount.';
  if (!isIsoDate(d.start_date)) e.start_date = 'Pick the month it starts.';
  return e;
}
export function validateActual(month: string, amount: string): { month?: string; amount?: string } {
  const e: { month?: string; amount?: string } = {};
  if (!/^\d{4}-\d{2}$/.test(month) || !isIsoDate(`${month}-01`)) e.month = 'Pick a month.';
  const c = parseMoneyToCents(amount);
  if (c === null || Math.abs(c) > MAX_CENTS) e.amount = 'Enter the realized amount.';
  return e;
}
export interface ControlDraft { value: string; tolerance: string; label: string }
export function validateControl(key: ControlKey, d: ControlDraft): { value?: string; tolerance?: string; cents: number | null; count: number | null } {
  const e: { value?: string; tolerance?: string; cents: number | null; count: number | null } = { cents: null, count: null };
  const money = CONTROL_META[key].money;
  if (money) { const c = parseMoneyToCents(d.value); if (c === null || c < 0 || c > MAX_CENTS) e.value = 'Enter a valid amount.'; else e.cents = c; }
  else { const n = Number(d.value.replace(/,/g, '')); if (!/^\d+$/.test(d.value.replace(/,/g, '')) || !Number.isSafeInteger(n)) e.value = 'Enter a whole number.'; else e.count = n; }
  const t = d.tolerance.trim() === '' ? 0 : Number(d.tolerance);
  if (!Number.isFinite(t) || t < 0 || t > 50) e.tolerance = 'Tolerance must be 0–50%.';
  return e;
}
/** Manual baseline: only filled fields are sent; money fields are typed in dollars. */
export function buildBaselineMetrics(values: Partial<Record<KpiKey, string>>): { metrics: Partial<Record<KpiKey, number>>; errors: Partial<Record<KpiKey, string>> } {
  const metrics: Partial<Record<KpiKey, number>> = {}; const errors: Partial<Record<KpiKey, string>> = {};
  for (const k of KPI_KEYS) {
    const raw = (values[k] ?? '').trim();
    if (raw === '') continue;
    const unit = KPI_META[k].unit;
    if (unit === 'cents') { const c = parseMoneyToCents(raw); if (c === null || c < 0) errors[k] = 'Enter a valid amount.'; else metrics[k] = c; continue; }
    const n = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0) { errors[k] = 'Enter a valid number.'; continue; }
    if (unit === 'pct' && n > 100) { errors[k] = 'Must be 0–100.'; continue; }
    metrics[k] = n;
  }
  if (Object.keys(metrics).length === 0 && Object.keys(errors).length === 0) errors.revenue_cents = 'Fill in at least one number.';
  return { metrics, errors };
}
