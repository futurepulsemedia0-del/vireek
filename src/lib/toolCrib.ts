import { supabase } from './supabase';
import type { CsvColumn } from './csvExport';

// ============================================================
// TYPES — mirror 20271201000000_tool_crib.sql
// ============================================================

export type ToolStatus = 'available' | 'checked_out' | 'maintenance' | 'lost' | 'retired';
export type LoanStatus = 'out' | 'returned' | 'lost';
export type ToolCondition = 'good' | 'worn' | 'damaged';
export type CribEventType =
  | 'created'
  | 'updated'
  | 'checked_out'
  | 'checked_in'
  | 'extended'
  | 'marked_lost'
  | 'recovered'
  | 'status_changed'
  | 'overdue_alert'
  | 'lost_alert';
export type StatusTone = 'neutral' | 'good' | 'warn' | 'bad';
/** Derived on the client from due_at + the account's lost threshold. */
export type LoanState = 'on_time' | 'due_soon' | 'overdue' | 'suspected_lost' | 'lost' | 'returned';

export interface CribTool {
  id: string;
  /** Account OWNER's id (team members share the owner's crib). */
  user_id: string;
  tool_number: string;
  name: string;
  category: string | null;
  serial_number: string | null;
  barcode: string | null;
  purchase_cost_cents: number | null;
  default_loan_hours: number | null;
  status: ToolStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CribLoan {
  id: string;
  user_id: string;
  tool_id: string;
  tool_name: string;
  tool_number: string;
  technician_id: string | null;
  technician_name: string;
  vehicle_id: string | null;
  vehicle_label: string | null;
  status: LoanStatus;
  checked_out_at: string;
  due_at: string;
  out_condition: 'good' | 'worn';
  out_note: string | null;
  extended_count: number;
  returned_at: string | null;
  return_condition: ToolCondition | null;
  return_note: string | null;
  lost_at: string | null;
  lost_note: string | null;
  overdue_alerted_at: string | null;
  lost_alerted_at: string | null;
}

export interface CribEvent {
  id: string;
  tool_id: string;
  loan_id: string | null;
  event_type: CribEventType;
  actor_name: string | null;
  note: string | null;
  created_at: string;
}

export interface CribTechnician {
  id: string;
  name: string;
  role: string;
}

export interface CribVehicle {
  id: string;
  label: string;
  plate: string | null;
  assigned_technician_id: string | null;
}
export interface CribSettings {
  default_loan_hours: number;
  lost_after_hours: number;
  alerts_enabled: boolean;
}

export interface CribOptions {
  technicians: CribTechnician[];
  vehicles: CribVehicle[];
  /** The caller's own team_members.id; null for the account owner. */
  self_member_id: string | null;
  /** Technician without can_manage_team: may only act on their own loans. */
  self_only: boolean;
  can_manage: boolean;
  settings: CribSettings;
}

export interface ToolInput {
  id: string | null;
  tool_number: string;
  name: string;
  category: string;
  serial_number: string;
  barcode: string;
  /** Whole dollars as typed ("49.99"); converted to cents on save. */
  cost: string;
  loan_hours: string;
  notes: string;
}

export const DEFAULT_SETTINGS: CribSettings = {
  default_loan_hours: 24,
  lost_after_hours: 72,
  alerts_enabled: true,
};

export const DUE_SOON_HOURS = 2;
const HOUR_MS = 3_600_000;

// ============================================================
// LABELS
// ============================================================

export const TOOL_STATUS_LABELS: Record<ToolStatus, string> = {
  available: 'Available',
  checked_out: 'Checked out',
  maintenance: 'Maintenance',
  lost: 'Lost',
  retired: 'Retired',
};

export const LOAN_STATE_LABELS: Record<LoanState, string> = {
  on_time: 'On time',
  due_soon: 'Due soon',
  overdue: 'Overdue',
  suspected_lost: 'Possibly lost',
  lost: 'Lost',
  returned: 'Returned',
};

export const CONDITION_LABELS: Record<ToolCondition, string> = {
  good: 'Good',
  worn: 'Worn',
  damaged: 'Damaged',
};

export const EVENT_LABELS: Record<CribEventType, string> = {
  created: 'Added to the crib',
  updated: 'Details edited',
  checked_out: 'Checked out',
  checked_in: 'Checked in',
  extended: 'Loan extended',
  marked_lost: 'Marked lost',
  recovered: 'Recovered',
  status_changed: 'Status changed',
  overdue_alert: 'Overdue alert sent',
  lost_alert: 'Possibly-lost alert sent',
};

export function toolStatusTone(status: ToolStatus): StatusTone {
  switch (status) {
    case 'available':
      return 'good';
    case 'maintenance':
      return 'warn';
    case 'lost':
      return 'bad';
    default:
      return 'neutral';
  }
}

export function loanStateTone(state: LoanState): StatusTone {
  switch (state) {
    case 'returned':
      return 'good';
    case 'due_soon':
      return 'warn';
    case 'overdue':
    case 'suspected_lost':
    case 'lost':
      return 'bad';
    default:
      return 'neutral';
  }
}

// ============================================================
// PURE HELPERS (unit-tested in toolCrib.test.ts)
// ============================================================

/** Derives how urgent a loan is. `lostAfterHours` counts from the due time. */
export function loanState(
  loan: Pick<CribLoan, 'status' | 'due_at'>,
  nowMs: number,
  lostAfterHours: number,
  dueSoonHours = DUE_SOON_HOURS,
): LoanState {
  if (loan.status === 'returned') return 'returned';
  if (loan.status === 'lost') return 'lost';
  const due = Date.parse(loan.due_at);
  if (Number.isNaN(due)) return 'on_time';
  if (nowMs > due + lostAfterHours * HOUR_MS) return 'suspected_lost';
  if (nowMs > due) return 'overdue';
  if (due - nowMs <= dueSoonHours * HOUR_MS) return 'due_soon';
  return 'on_time';
}

/** "2d 3h", "5h 10m", "45m", "under 1m". Always non-negative. */
export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  if (totalMin < 1) return 'under 1m';
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export function dueLabel(loan: Pick<CribLoan, 'status' | 'due_at'>, nowMs: number): string {
  if (loan.status === 'returned') return 'Returned';
  if (loan.status === 'lost') return 'Marked lost';
  const due = Date.parse(loan.due_at);
  if (Number.isNaN(due)) return '—';
  const delta = due - nowMs;
  return delta >= 0 ? `Due in ${formatDuration(delta)}` : `Overdue by ${formatDuration(-delta)}`;
}

export interface CribSummary {
  /** Everything except retired tools. */
  total: number;
  available: number;
  out: number;
  dueSoon: number;
  overdue: number;
  suspectedLost: number;
  lost: number;
  maintenance: number;
}

export function summarizeCrib(tools: CribTool[], loans: CribLoan[], nowMs: number, lostAfterHours: number): CribSummary {
  const s: CribSummary = { total: 0, available: 0, out: 0, dueSoon: 0, overdue: 0, suspectedLost: 0, lost: 0, maintenance: 0 };
  for (const t of tools) {
    if (t.status === 'retired') continue;
    s.total += 1;
    if (t.status === 'available') s.available += 1;
    else if (t.status === 'checked_out') s.out += 1;
    else if (t.status === 'maintenance') s.maintenance += 1;
    else if (t.status === 'lost') s.lost += 1;
  }
  for (const l of loans) {
    if (l.status !== 'out') continue;
    const st = loanState(l, nowMs, lostAfterHours);
    if (st === 'due_soon') s.dueSoon += 1;
    else if (st === 'overdue') s.overdue += 1;
    else if (st === 'suspected_lost') s.suspectedLost += 1;
  }
  return s;
}

/** Open loans that need action, most overdue first. */
export function alertLoans(loans: CribLoan[], nowMs: number, lostAfterHours: number): CribLoan[] {
  return loans
    .filter((l) => {
      if (l.status !== 'out') return false;
      const st = loanState(l, nowMs, lostAfterHours);
      return st === 'overdue' || st === 'suspected_lost';
    })
    .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
}

export type ToolFilter = 'all' | ToolStatus;

/** Free-text + status filter. The text matches name, tag, category, serial and barcode. */
export function filterTools(tools: CribTool[], query: string, status: ToolFilter): CribTool[] {
  const q = query.trim().toLowerCase();
  return tools.filter((t) => {
    if (status === 'all' ? t.status === 'retired' : t.status !== status) return false;
    if (!q) return true;
    return [t.name, t.tool_number, t.category, t.serial_number, t.barcode].some((v) => (v ?? '').toLowerCase().includes(q));
  });
}

/** Strips CR/LF/tab/GS/other control chars that HID scanners append, trims, caps length. */
export function normalizeScanCode(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128);
}

/** Resolves a scanned/typed code to a tool: exact barcode first, then tag number (case-insensitive). */
export function findToolByCode(tools: CribTool[], rawCode: string): CribTool | null {
  const code = normalizeScanCode(rawCode).toLowerCase();
  if (!code) return null;
  return (
    tools.find((t) => (t.barcode ?? '').toLowerCase() === code) ??
    tools.find((t) => t.tool_number.toLowerCase() === code) ??
    null
  );
}

export interface TechnicianGroup {
  key: string;
  name: string;
  loans: CribLoan[];
  /** Overdue + possibly-lost loans in this group. */
  late: number;
}

/** Open loans grouped per technician; people with late tools first, then by name. */
export function groupLoansByTechnician(loans: CribLoan[], nowMs: number, lostAfterHours: number): TechnicianGroup[] {
  const map = new Map<string, TechnicianGroup>();
  for (const l of loans) {
    if (l.status !== 'out') continue;
    const key = l.technician_id ?? `name:${l.technician_name}`;
    let g = map.get(key);
    if (!g) {
      g = { key, name: l.technician_name, loans: [], late: 0 };
      map.set(key, g);
    }
    g.loans.push(l);
    const st = loanState(l, nowMs, lostAfterHours);
    if (st === 'overdue' || st === 'suspected_lost') g.late += 1;
  }
  const groups = [...map.values()];
  for (const g of groups) g.loans.sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
  return groups.sort((a, b) => (b.late > 0 ? 1 : 0) - (a.late > 0 ? 1 : 0) || a.name.localeCompare(b.name));
}

export type ParseResult = { ok: true; value: number } | { ok: false; error: string };

/** Whole-number input within [min, max]. */
export function parseWholeNumber(raw: string, min: number, max: number, label: string): ParseResult {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return { ok: false, error: `${label} must be a whole number` };
  const n = Number(t);
  if (n < min || n > max) return { ok: false, error: `${label} must be between ${min} and ${max}` };
  return { ok: true, value: n };
}

/** "49.99" -> 4999 cents. Blank -> null (optional). */
export function parseDollarsToCents(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const t = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!t) return { ok: true, value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return { ok: false, error: 'Enter a cost like 49.99' };
  const cents = Math.round(Number(t) * 100);
  if (cents > 100_000_000) return { ok: false, error: 'Cost must be 1,000,000 or less' };
  return { ok: true, value: cents };
}

export function formatCostCents(cents: number | null): string {
  if (cents === null) return '—';
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export function emptyToolInput(): ToolInput {
  return { id: null, tool_number: '', name: '', category: '', serial_number: '', barcode: '', cost: '', loan_hours: '', notes: '' };
}

export function toolToInput(t: CribTool): ToolInput {
  return {
    id: t.id,
    tool_number: t.tool_number,
    name: t.name,
    category: t.category ?? '',
    serial_number: t.serial_number ?? '',
    barcode: t.barcode ?? '',
    cost: t.purchase_cost_cents === null ? '' : (t.purchase_cost_cents / 100).toFixed(2),
    loan_hours: t.default_loan_hours === null ? '' : String(t.default_loan_hours),
    notes: t.notes ?? '',
  };
}

// ============================================================
// CSV
// ============================================================

export interface ToolCsvRow {
  tool: CribTool;
  loan: CribLoan | null;
}

/** The vehicle assigned to this team member, if any (used to pre-select the truck at check-out). */
export function defaultVehicleFor(vehicles: CribVehicle[], techId: string | null | undefined): string {
  if (!techId) return '';
  return vehicles.find((v) => v.assigned_technician_id === techId)?.id ?? '';
}
export function buildToolCsvRows(tools: CribTool[], loans: CribLoan[]): ToolCsvRow[] {
  const open = new Map<string, CribLoan>();
  for (const l of loans) if (l.status === 'out') open.set(l.tool_id, l);
  return tools.map((tool) => ({ tool, loan: open.get(tool.id) ?? null }));
}

export function buildToolCsvColumns(showCosts: boolean): CsvColumn<ToolCsvRow>[] {
  const cols: CsvColumn<ToolCsvRow>[] = [
    { header: 'Tag', accessor: (r) => r.tool.tool_number },
    { header: 'Tool', accessor: (r) => r.tool.name },
    { header: 'Category', accessor: (r) => r.tool.category },
    { header: 'Serial', accessor: (r) => r.tool.serial_number },
    { header: 'Barcode', accessor: (r) => r.tool.barcode },
    { header: 'Status', accessor: (r) => TOOL_STATUS_LABELS[r.tool.status] },
    { header: 'Held by', accessor: (r) => r.loan?.technician_name ?? '' },
    { header: 'Vehicle', accessor: (r) => r.loan?.vehicle_label ?? '' },
    { header: 'Due', accessor: (r) => r.loan?.due_at ?? '' },
  ];
  if (showCosts) cols.push({ header: 'Purchase cost', accessor: (r) => (r.tool.purchase_cost_cents === null ? null : (r.tool.purchase_cost_cents / 100).toFixed(2)) });
  return cols;
}

// ============================================================
// ERRORS
// ============================================================

interface DbErrorLike {
  code?: string;
  message?: string;
}

export function cribErrorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const e = err as DbErrorLike | null;
  if (!e) return fallback;
  if (e.code === '42501') return e.message && !/not authorised/i.test(e.message) ? e.message : "You don't have permission to do that.";
  // P0001 = our own validation messages, P0002 not found, P0004 wrong state: all written for humans.
  if (e.message && (e.code === 'P0001' || e.code === 'P0002' || e.code === 'P0004')) return e.message;
  if (e.message && /Failed to fetch|NetworkError|network/i.test(e.message)) return "You're offline — check your connection and try again.";
  return fallback;
}

// ============================================================
// QUERIES
// ============================================================

export async function getCribOptions(): Promise<CribOptions> {
  const { data, error } = await supabase.rpc('tool_crib_options');
  if (error) throw error;
  const d = (data ?? {}) as Partial<CribOptions>;
  return {
    technicians: d.technicians ?? [],
    self_member_id: d.self_member_id ?? null,
    self_only: d.self_only ?? false,
    can_manage: d.can_manage ?? false,
    settings: { ...DEFAULT_SETTINGS, ...(d.settings ?? {}) },
  };
}

/** `accountOwnerId` is applied as an explicit filter on top of RLS (defence in depth). */
export async function listCribTools(accountOwnerId: string): Promise<CribTool[]> {
  const { data, error } = await supabase
    .from('tool_crib_items')
    .select('*')
    .eq('user_id', accountOwnerId)
    .order('name', { ascending: true })
    .limit(1000);
  if (error) throw error;
  return (data ?? []) as CribTool[];
}

/** Open and lost loans (what still needs a decision), earliest due first. */
export async function listOpenCribLoans(accountOwnerId: string): Promise<CribLoan[]> {
  const { data, error } = await supabase
    .from('tool_crib_loans')
    .select('*')
    .eq('user_id', accountOwnerId)
    .in('status', ['out', 'lost'])
    .order('due_at', { ascending: true })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as CribLoan[];
}

export async function listToolEvents(accountOwnerId: string, toolId: string): Promise<CribEvent[]> {
  const { data, error } = await supabase
    .from('tool_crib_events')
    .select('id, tool_id, loan_id, event_type, actor_name, note, created_at')
    .eq('user_id', accountOwnerId)
    .eq('tool_id', toolId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as CribEvent[];
}

// ============================================================
// MUTATIONS — every write is an RPC; the server re-checks permissions
// ============================================================

/** A client-side validation failure shaped like our P0001 RPC errors, so cribErrorMessage shows it. */
function validationError(message: string): Error {
  return Object.assign(new Error(message), { code: 'P0001' });
}

export async function saveCribTool(input: ToolInput): Promise<string> {
  const cost = parseDollarsToCents(input.cost);
  if (!cost.ok) throw validationError(cost.error);
  let loanHours: number | null = null;
  if (input.loan_hours.trim()) {
    const h = parseWholeNumber(input.loan_hours, 1, 720, 'Loan length');
    if (!h.ok) throw validationError(h.error);
    loanHours = h.value;
  }
  const { data, error } = await supabase.rpc('save_crib_tool', {
    p_tool_id: input.id,
    p_tool_number: input.tool_number,
    p_name: input.name,
    p_category: input.category,
    p_serial: input.serial_number,
    p_barcode: input.barcode,
    p_cost_cents: cost.value,
    p_loan_hours: loanHours,
    p_notes: input.notes,
  });
  if (error) throw error;
  return data as string;
}

export async function checkOutCribTool(params: {
  toolId: string;
  technicianId: string;
  loanHours: number | null;
  condition: 'good' | 'worn';
  note: string;
  vehicleId?: string | null;
}): Promise<{ loan_id: string; tool_name: string; technician_name: string; vehicle_label: string | null; due_at: string }> {
  const { data, error } = await supabase.rpc('check_out_crib_tool', {
    p_tool_id: params.toolId,
    p_technician_id: params.technicianId,
    p_loan_hours: params.loanHours,
    p_condition: params.condition,
    p_note: params.note,
    p_vehicle_id: params.vehicleId ?? null,
  });
  if (error) throw error;
  return data as { loan_id: string; tool_name: string; technician_name: string; vehicle_label: string | null; due_at: string };
}
export async function checkInCribTool(params: {
  loanId: string;
  condition: ToolCondition;
  note: string;
}): Promise<{ was_late: boolean; tool_status: ToolStatus }> {
  const { data, error } = await supabase.rpc('check_in_crib_tool', {
    p_loan_id: params.loanId,
    p_condition: params.condition,
    p_note: params.note,
  });
  if (error) throw error;
  return data as { was_late: boolean; tool_status: ToolStatus };
}

export async function extendCribLoan(loanId: string, extraHours: number, note: string): Promise<string> {
  const { data, error } = await supabase.rpc('extend_crib_loan', {
    p_loan_id: loanId,
    p_extra_hours: extraHours,
    p_note: note,
  });
  if (error) throw error;
  return data as string;
}

export async function markCribToolLost(toolId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('mark_crib_tool_lost', { p_tool_id: toolId, p_note: note });
  if (error) throw error;
}

export async function recoverCribTool(toolId: string, condition: ToolCondition, note: string): Promise<void> {
  const { error } = await supabase.rpc('recover_crib_tool', { p_tool_id: toolId, p_condition: condition, p_note: note });
  if (error) throw error;
}

export async function setCribToolStatus(toolId: string, status: 'available' | 'maintenance' | 'retired', note: string): Promise<void> {
  const { error } = await supabase.rpc('set_crib_tool_status', { p_tool_id: toolId, p_status: status, p_note: note });
  if (error) throw error;
}

export async function saveCribSettings(settings: CribSettings): Promise<void> {
  const { error } = await supabase.rpc('save_crib_settings', {
    p_default_loan_hours: settings.default_loan_hours,
    p_lost_after_hours: settings.lost_after_hours,
    p_alerts_enabled: settings.alerts_enabled,
  });
  if (error) throw error;
}

/** Idempotent server-side alert pass (overdue / possibly lost → notification bell). */
export async function scanCribAlerts(): Promise<{ overdue: number; suspected_lost: number }> {
  const { data, error } = await supabase.rpc('scan_crib_tool_alerts');
  if (error) throw error;
  const d = (data ?? {}) as { overdue?: number; suspected_lost?: number };
  return { overdue: d.overdue ?? 0, suspected_lost: d.suspected_lost ?? 0 };
}
