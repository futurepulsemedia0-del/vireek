import { supabase } from '@/lib/supabase';
import type { ChartOfAccount } from '@/lib/accounting';

/**
 * Fixed assets — client library.
 *
 * Wraps supabase/migrations/20271206000000_fixed_assets.sql. Every write is a
 * SECURITY DEFINER RPC that re-checks permission, period locks and balancing
 * server-side; the validation here only gives instant, field-level feedback.
 * buildSchedule() mirrors _fa_build_schedule() exactly (integer math), so the
 * editor preview always matches what the ledger will receive.
 */

export type AssetCategory =
  | 'vehicle' | 'equipment' | 'tools' | 'computer' | 'furniture' | 'leasehold' | 'building' | 'software' | 'land' | 'other';
export type DepreciationMethod = 'straight_line' | 'declining_balance' | 'sum_of_years' | 'none';
export type AssetStatus = 'active' | 'fully_depreciated' | 'disposed';
export type LineStatus = 'scheduled' | 'posted' | 'cancelled';

export interface FixedAsset {
  id: string;
  asset_tag: string;
  name: string;
  category: AssetCategory;
  description: string | null;
  serial_number: string | null;
  location: string | null;
  vehicle_id: string | null;
  acquisition_date: string;
  in_service_date: string;
  cost_cents: number;
  salvage_cents: number;
  useful_life_months: number;
  method: DepreciationMethod;
  status: AssetStatus;
  asset_account_id: string;
  accumulated_account_id: string;
  expense_account_id: string;
  acquisition_entry_id: string | null;
  disposed_on: string | null;
  disposal_proceeds_cents: number | null;
  disposal_gain_loss_cents: number | null;
  notes: string | null;
  created_at: string;
  accumulated_cents: number;
  posted_months: number;
  scheduled_months: number;
  next_period_start: string | null;
  next_amount_cents: number | null;
}

export interface ScheduleLine {
  line_id: string;
  period_start: string;
  period_end: string;
  amount_cents: number;
  accumulated_cents: number;
  book_value_cents: number;
  status: LineStatus;
  journal_entry_id: string | null;
  entry_number: string | null;
  entry_status: string | null;
}

export interface PlannedLine {
  period_start: string;
  period_end: string;
  amount_cents: number;
  accumulated_cents: number;
  book_value_cents: number;
}

export interface RunPreviewRow {
  period_start: string;
  period_end: string;
  asset_count: number;
  total_cents: number;
  is_closed: boolean;
}

export interface ForecastRow {
  period_start: string;
  scheduled_cents: number;
  posted_cents: number;
}

export interface RunResult {
  posted_lines: number;
  posted_cents: number;
  entries: number;
  skipped_closed_periods: number;
}

export interface DefaultAccounts {
  asset_account_id: string;
  accumulated_account_id: string;
  expense_account_id: string;
}

export interface AssetEvent {
  id: string;
  actor_id: string | null;
  asset_id: string | null;
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface VehicleOption {
  id: string;
  label: string;
  license_plate: string | null;
}

export interface AssetDraft {
  name: string;
  category: AssetCategory;
  assetTag: string;
  description: string;
  serialNumber: string;
  location: string;
  vehicleId: string;
  acquisitionDate: string;
  inServiceDate: string;
  cost: string;
  salvage: string;
  lifeMonths: string;
  method: DepreciationMethod;
  assetAccountId: string;
  accumulatedAccountId: string;
  expenseAccountId: string;
  recordAcquisition: boolean;
  offsetAccountId: string;
  notes: string;
}

export type DraftField =
  | 'name' | 'assetTag' | 'description' | 'serialNumber' | 'location' | 'notes' | 'acquisitionDate' | 'inServiceDate'
  | 'cost' | 'salvage' | 'lifeMonths' | 'assetAccountId' | 'accumulatedAccountId' | 'expenseAccountId' | 'offsetAccountId';
export type DraftErrors = Partial<Record<DraftField, string>>;

// ---------------------------------------------------------------------------
// Static metadata
// ---------------------------------------------------------------------------

export const MAX_CENTS = 2147483647;

export const CATEGORIES: { id: AssetCategory; label: string; lifeMonths: number; method: DepreciationMethod }[] = [
  { id: 'vehicle', label: 'Vehicle', lifeMonths: 60, method: 'straight_line' },
  { id: 'equipment', label: 'Equipment', lifeMonths: 84, method: 'straight_line' },
  { id: 'tools', label: 'Tools', lifeMonths: 60, method: 'straight_line' },
  { id: 'computer', label: 'Computer / IT', lifeMonths: 36, method: 'straight_line' },
  { id: 'furniture', label: 'Furniture & fixtures', lifeMonths: 84, method: 'straight_line' },
  { id: 'leasehold', label: 'Leasehold improvements', lifeMonths: 120, method: 'straight_line' },
  { id: 'building', label: 'Building', lifeMonths: 468, method: 'straight_line' },
  { id: 'software', label: 'Software', lifeMonths: 36, method: 'straight_line' },
  { id: 'land', label: 'Land', lifeMonths: 0, method: 'none' },
  { id: 'other', label: 'Other', lifeMonths: 60, method: 'straight_line' },
];

export const METHODS: { id: DepreciationMethod; label: string; hint: string }[] = [
  { id: 'straight_line', label: 'Straight-line', hint: 'The same amount every month. The most common choice for books.' },
  { id: 'declining_balance', label: 'Double-declining balance', hint: 'Larger expense early, smaller later; switches to straight-line so it ends exactly at salvage.' },
  { id: 'sum_of_years', label: "Sum of the years' digits", hint: 'Front-loaded, with a steady step down each month.' },
  { id: 'none', label: 'Not depreciated', hint: 'For land and other assets that do not wear out.' },
];

export const STATUS_LABEL: Record<AssetStatus, string> = {
  active: 'Active',
  fully_depreciated: 'Fully depreciated',
  disposed: 'Disposed',
};

export function categoryMeta(id: AssetCategory) {
  return CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1];
}

export function methodLabel(id: DepreciationMethod): string {
  return METHODS.find((m) => m.id === id)?.label ?? id;
}

// ---------------------------------------------------------------------------
// Money & date helpers (no timezone drift: dates are plain 'YYYY-MM-DD' strings)
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');

export function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function monthStartOf(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** First day of the month n months after the month containing iso. */
export function addMonthsStart(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}-01`;
}

export function monthEndOf(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return `${y}-${pad2(m)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

/** '2027-03-15' -> 'Mar 2027' */
export function formatMonth(iso: string): string {
  const m = Number(iso.slice(5, 7));
  return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${iso.slice(0, 4)}` : iso;
}

/** '2027-03-15' -> 'Mar 15, 2027' */
export function formatDay(iso: string | null): string {
  if (!iso) return '—';
  const m = Number(iso.slice(5, 7));
  return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}` : iso;
}

/** Parses '12,500.50' / '$12500' into whole cents, or null when it is not a valid non-negative amount. */
export function parseCents(input: string): number | null {
  const s = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function formatLife(months: number): string {
  if (months <= 0) return '—';
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m} mo`;
  return m === 0 ? `${y} yr` : `${y} yr ${m} mo`;
}

// ---------------------------------------------------------------------------
// Depreciation schedule (mirror of _fa_build_schedule — keep the two in sync)
// ---------------------------------------------------------------------------

export interface ScheduleInput {
  costCents: number;
  salvageCents: number;
  lifeMonths: number;
  method: DepreciationMethod;
  inServiceDate: string;
}

const floorDiv = (a: number, b: number) => (a - (a % b)) / b;

export function buildSchedule(input: ScheduleInput): PlannedLine[] {
  const { costCents: cost, salvageCents: salvage, lifeMonths: life, method } = input;
  if (
    method === 'none' ||
    !Number.isInteger(cost) || cost <= 0 || cost > MAX_CENTS ||
    !Number.isInteger(salvage) || salvage < 0 || salvage > cost ||
    !Number.isInteger(life) || life < 1 || life > 600 ||
    !isIsoDate(input.inServiceDate)
  ) {
    return [];
  }

  const dep = cost - salvage;
  const total = (life * (life + 1)) / 2;
  const first = monthStartOf(input.inServiceDate);
  const out: PlannedLine[] = [];
  let bv = cost;
  let acc = 0;
  let prev = 0;

  for (let k = 1; k <= life; k += 1) {
    const rem = life - k + 1;
    let amt: number;
    if (method === 'straight_line') {
      const cum = floorDiv(dep * k, life);
      amt = cum - prev;
      prev = cum;
    } else if (method === 'sum_of_years') {
      const w = k * life - (k * (k - 1)) / 2;
      const cum = floorDiv(dep * w, total);
      amt = cum - prev;
      prev = cum;
    } else {
      const ddb = floorDiv(2 * bv + floorDiv(life, 2), life);
      const sl = floorDiv(bv - salvage + floorDiv(rem, 2), rem);
      amt = Math.min(Math.max(ddb, sl), bv - salvage);
    }
    acc += amt;
    bv = cost - acc;
    if (amt > 0) {
      const start = addMonthsStart(first, k - 1);
      out.push({ period_start: start, period_end: monthEndOf(start), amount_cents: amt, accumulated_cents: acc, book_value_cents: bv });
    }
  }
  return out;
}

export interface ScheduleSummary {
  months: number;
  firstAmount: number;
  lastAmount: number;
  firstYearTotal: number;
  endsOn: string | null;
  totalDepreciable: number;
}

export function summarizeSchedule(lines: PlannedLine[], costCents = 0, salvageCents = 0): ScheduleSummary {
  return {
    months: lines.length,
    firstAmount: lines[0]?.amount_cents ?? 0,
    lastAmount: lines[lines.length - 1]?.amount_cents ?? 0,
    firstYearTotal: lines.slice(0, 12).reduce((s, l) => s + l.amount_cents, 0),
    endsOn: lines.length ? lines[lines.length - 1].period_end : null,
    totalDepreciable: Math.max(costCents - salvageCents, 0),
  };
}

// ---------------------------------------------------------------------------
// Register helpers
// ---------------------------------------------------------------------------

export function bookValue(a: Pick<FixedAsset, 'status' | 'cost_cents' | 'accumulated_cents'>): number {
  return a.status === 'disposed' ? 0 : Math.max(a.cost_cents - a.accumulated_cents, 0);
}

export function summarizeAssets(assets: FixedAsset[]) {
  const live = assets.filter((a) => a.status !== 'disposed');
  const cost = live.reduce((s, a) => s + a.cost_cents, 0);
  const accumulated = live.reduce((s, a) => s + a.accumulated_cents, 0);
  return {
    count: live.length,
    disposed: assets.length - live.length,
    fullyDepreciated: assets.filter((a) => a.status === 'fully_depreciated').length,
    costCents: cost,
    accumulatedCents: accumulated,
    netBookValueCents: cost - accumulated,
  };
}

export function filterAssets(
  assets: FixedAsset[],
  opts: { query: string; status: AssetStatus | 'all'; category: AssetCategory | 'all' },
): FixedAsset[] {
  const q = opts.query.trim().toLowerCase();
  return assets.filter((a) => {
    if (opts.status !== 'all' && a.status !== opts.status) return false;
    if (opts.category !== 'all' && a.category !== opts.category) return false;
    if (!q) return true;
    return [a.name, a.asset_tag, a.serial_number ?? '', a.location ?? '', a.description ?? ''].some((v) => v.toLowerCase().includes(q));
  });
}

/** Why the financial terms can't be edited ('' when they can). */
export function termsLockReason(a: Pick<FixedAsset, 'posted_months' | 'acquisition_entry_id'>): string {
  if (a.posted_months > 0) {
    return 'Depreciation has been posted, so cost, dates, method, life and accounts are locked.';
  }
  return '';
}

/** Cost, acquisition date and asset account stay locked once an acquisition entry exists. */
export function costLockReason(a: Pick<FixedAsset, 'acquisition_entry_id'>): string {
  return a.acquisition_entry_id ? 'An acquisition entry was posted, so cost, acquisition date and asset account are locked.' : '';
}

export function canDeleteAsset(a: Pick<FixedAsset, 'status' | 'posted_months' | 'acquisition_entry_id'>): boolean {
  return a.status !== 'disposed' && a.posted_months === 0 && !a.acquisition_entry_id;
}

export function describeEvent(e: AssetEvent): string {
  const d = e.detail ?? {};
  const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
  const label = [str('tag'), str('name')].filter(Boolean).join(' · ');
  switch (e.action) {
    case 'created':
      return `Added ${label}`;
    case 'updated':
      return `Edited ${label}${d.terms_changed ? ' (schedule rebuilt)' : ''}`;
    case 'deleted':
      return `Deleted ${label}`;
    case 'disposed':
      return `Disposed ${label}`;
    case 'depreciation_posted': {
      const lines = Number(d.posted_lines ?? 0);
      const entries = Number(d.entries ?? 0);
      const skipped = Number(d.skipped_closed_periods ?? 0);
      const base = lines > 0 ? `Posted depreciation: ${lines} line${lines === 1 ? '' : 's'} in ${entries} entr${entries === 1 ? 'y' : 'ies'}` : 'Depreciation run posted nothing';
      return skipped > 0 ? `${base}; ${skipped} closed month${skipped === 1 ? '' : 's'} skipped` : base;
    }
    default:
      return e.action.replace(/_/g, ' ');
  }
}

// ---------------------------------------------------------------------------
// Draft helpers
// ---------------------------------------------------------------------------

export function emptyDraft(today: string, defaults?: Partial<DefaultAccounts>): AssetDraft {
  const cat = categoryMeta('equipment');
  return {
    name: '',
    category: cat.id,
    assetTag: '',
    description: '',
    serialNumber: '',
    location: '',
    vehicleId: '',
    acquisitionDate: today,
    inServiceDate: today,
    cost: '',
    salvage: '0.00',
    lifeMonths: String(cat.lifeMonths),
    method: cat.method,
    assetAccountId: defaults?.asset_account_id ?? '',
    accumulatedAccountId: defaults?.accumulated_account_id ?? '',
    expenseAccountId: defaults?.expense_account_id ?? '',
    recordAcquisition: false,
    offsetAccountId: '',
    notes: '',
  };
}

export function draftFromAsset(a: FixedAsset): AssetDraft {
  return {
    name: a.name,
    category: a.category,
    assetTag: a.asset_tag,
    description: a.description ?? '',
    serialNumber: a.serial_number ?? '',
    location: a.location ?? '',
    vehicleId: a.vehicle_id ?? '',
    acquisitionDate: a.acquisition_date,
    inServiceDate: a.in_service_date,
    cost: centsToInput(a.cost_cents),
    salvage: centsToInput(a.salvage_cents),
    lifeMonths: a.method === 'none' ? '' : String(a.useful_life_months),
    method: a.method,
    assetAccountId: a.asset_account_id,
    accumulatedAccountId: a.accumulated_account_id,
    expenseAccountId: a.expense_account_id,
    recordAcquisition: false,
    offsetAccountId: '',
    notes: a.notes ?? '',
  };
}

export function draftToSchedule(d: AssetDraft): PlannedLine[] {
  const cost = parseCents(d.cost);
  const salvage = parseCents(d.salvage);
  const life = Number(d.lifeMonths);
  if (cost === null || salvage === null || !Number.isInteger(life)) return [];
  return buildSchedule({ costCents: cost, salvageCents: salvage, lifeMonths: life, method: d.method, inServiceDate: d.inServiceDate });
}

export function validateAssetDraft(
  d: AssetDraft,
  ctx: { assets: Pick<FixedAsset, 'id' | 'asset_tag'>[]; editingId: string | null; accounts: Pick<ChartOfAccount, 'id' | 'type'>[] },
): DraftErrors {
  const e: DraftErrors = {};
  const name = d.name.trim();
  const tag = d.assetTag.trim();

  if (!name) e.name = 'Enter an asset name.';
  else if (name.length > 120) e.name = 'Keep the name under 120 characters.';

  if (tag.length > 40) e.assetTag = 'Keep the tag under 40 characters.';
  else if (tag && ctx.assets.some((a) => a.id !== ctx.editingId && a.asset_tag.toLowerCase() === tag.toLowerCase())) {
    e.assetTag = 'That tag is already in use.';
  }

  if (d.description.trim().length > 500) e.description = 'Keep the description under 500 characters.';
  if (d.serialNumber.trim().length > 80) e.serialNumber = 'Keep the serial number under 80 characters.';
  if (d.location.trim().length > 120) e.location = 'Keep the location under 120 characters.';
  if (d.notes.trim().length > 1000) e.notes = 'Keep the notes under 1,000 characters.';

  if (!isIsoDate(d.acquisitionDate)) e.acquisitionDate = 'Enter the acquisition date.';
  if (!isIsoDate(d.inServiceDate)) e.inServiceDate = 'Enter the in-service date.';
  else if (isIsoDate(d.acquisitionDate) && d.inServiceDate < d.acquisitionDate) {
    e.inServiceDate = 'Cannot be before the acquisition date.';
  }

  const cost = parseCents(d.cost);
  const salvage = parseCents(d.salvage);
  if (cost === null || cost <= 0) e.cost = 'Enter a cost greater than zero (for example 12500.00).';
  else if (cost > MAX_CENTS) e.cost = 'That amount is above the supported maximum of $21,474,836.47.';
  if (salvage === null) e.salvage = 'Enter a salvage value (use 0 for none).';
  else if (cost !== null && cost > 0 && salvage > cost) e.salvage = 'Salvage cannot exceed the cost.';

  if (d.method !== 'none') {
    const life = Number(d.lifeMonths);
    if (d.lifeMonths.trim() === '' || !Number.isInteger(life) || life < 1 || life > 600) {
      e.lifeMonths = 'Enter a whole number of months between 1 and 600.';
    }
  }

  const typeOf = (id: string) => ctx.accounts.find((a) => a.id === id)?.type;
  if (typeOf(d.assetAccountId) !== 'asset') e.assetAccountId = 'Choose an asset account.';
  if (typeOf(d.accumulatedAccountId) !== 'asset') e.accumulatedAccountId = 'Choose an accumulated depreciation account.';
  else if (d.accumulatedAccountId === d.assetAccountId) e.accumulatedAccountId = 'Must differ from the asset account.';
  if (typeOf(d.expenseAccountId) !== 'expense') e.expenseAccountId = 'Choose a depreciation expense account.';

  if (d.recordAcquisition && !ctx.editingId) {
    if (!typeOf(d.offsetAccountId)) e.offsetAccountId = 'Choose where the money came from.';
    else if (d.offsetAccountId === d.assetAccountId) e.offsetAccountId = 'Must differ from the asset account.';
  }
  return e;
}

export function validateDisposal(
  input: { date: string; proceeds: string; depositAccountId: string },
  asset: Pick<FixedAsset, 'in_service_date'>,
  today: string,
): Partial<Record<'date' | 'proceeds' | 'depositAccountId', string>> {
  const e: Partial<Record<'date' | 'proceeds' | 'depositAccountId', string>> = {};
  if (!isIsoDate(input.date)) e.date = 'Enter the disposal date.';
  else if (input.date < asset.in_service_date) e.date = 'Cannot be before the in-service date.';
  else if (input.date > today) e.date = 'Cannot be in the future.';
  const proceeds = input.proceeds.trim() === '' ? 0 : parseCents(input.proceeds);
  if (proceeds === null) e.proceeds = 'Enter the sale proceeds (use 0 if scrapped).';
  else if (proceeds > MAX_CENTS) e.proceeds = 'That amount is above the supported maximum.';
  else if (proceeds > 0 && !input.depositAccountId) e.depositAccountId = 'Choose the account the money went into.';
  return e;
}

/** Gain/loss preview for the disposal dialog: book value as of today's accumulated posted depreciation. */
export function disposalPreview(asset: Pick<FixedAsset, 'cost_cents' | 'accumulated_cents'>, proceedsCents: number) {
  const bookValueCents = Math.max(asset.cost_cents - asset.accumulated_cents, 0);
  return { bookValueCents, gainLossCents: proceedsCents - bookValueCents };
}

// ---------------------------------------------------------------------------
// API (all throw on failure)
// ---------------------------------------------------------------------------

const num = (v: unknown) => Number(v ?? 0);

export async function fetchAssets(): Promise<FixedAsset[]> {
  const { data, error } = await supabase.rpc('get_fixed_assets_overview');
  if (error) throw error;
  return ((data ?? []) as FixedAsset[]).map((a) => ({
    ...a,
    cost_cents: num(a.cost_cents),
    salvage_cents: num(a.salvage_cents),
    useful_life_months: num(a.useful_life_months),
    accumulated_cents: num(a.accumulated_cents),
    posted_months: num(a.posted_months),
    scheduled_months: num(a.scheduled_months),
    next_amount_cents: a.next_amount_cents === null ? null : num(a.next_amount_cents),
    disposal_proceeds_cents: a.disposal_proceeds_cents === null ? null : num(a.disposal_proceeds_cents),
    disposal_gain_loss_cents: a.disposal_gain_loss_cents === null ? null : num(a.disposal_gain_loss_cents),
  }));
}

export async function fetchSchedule(assetId: string): Promise<ScheduleLine[]> {
  const { data, error } = await supabase.rpc('get_fixed_asset_schedule', { p_asset_id: assetId });
  if (error) throw error;
  return ((data ?? []) as ScheduleLine[]).map((l) => ({
    ...l,
    amount_cents: num(l.amount_cents),
    accumulated_cents: num(l.accumulated_cents),
    book_value_cents: num(l.book_value_cents),
  }));
}

export async function fetchRunPreview(through: string): Promise<RunPreviewRow[]> {
  const { data, error } = await supabase.rpc('get_depreciation_run_preview', { p_through: through });
  if (error) throw error;
  return ((data ?? []) as RunPreviewRow[]).map((r) => ({ ...r, asset_count: num(r.asset_count), total_cents: num(r.total_cents) }));
}

export async function fetchForecast(fromIso: string, months = 12): Promise<ForecastRow[]> {
  const { data, error } = await supabase.rpc('get_depreciation_forecast', { p_from: fromIso, p_months: months });
  if (error) throw error;
  return ((data ?? []) as ForecastRow[]).map((r) => ({ ...r, scheduled_cents: num(r.scheduled_cents), posted_cents: num(r.posted_cents) }));
}

export async function ensureDefaultAccounts(): Promise<DefaultAccounts> {
  const { data, error } = await supabase.rpc('fixed_assets_ensure_accounts');
  if (error) throw error;
  return data as DefaultAccounts;
}

function commonParams(d: AssetDraft) {
  const cost = parseCents(d.cost) ?? 0;
  const salvage = parseCents(d.salvage) ?? 0;
  return {
    p_name: d.name.trim(),
    p_category: d.category,
    p_asset_tag: d.assetTag.trim() || null,
    p_description: d.description.trim() || null,
    p_serial_number: d.serialNumber.trim() || null,
    p_location: d.location.trim() || null,
    p_vehicle_id: d.category === 'vehicle' && d.vehicleId ? d.vehicleId : null,
    p_acquisition_date: d.acquisitionDate,
    p_in_service_date: d.inServiceDate,
    p_cost_cents: cost,
    p_salvage_cents: d.method === 'none' ? 0 : salvage,
    p_useful_life_months: d.method === 'none' ? 0 : Number(d.lifeMonths),
    p_method: d.method,
    p_asset_account_id: d.assetAccountId,
    p_accumulated_account_id: d.accumulatedAccountId,
    p_expense_account_id: d.expenseAccountId,
    p_notes: d.notes.trim() || null,
  };
}

export async function createAsset(d: AssetDraft): Promise<string> {
  const { data, error } = await supabase.rpc('create_fixed_asset', {
    ...commonParams(d),
    p_offset_account_id: d.recordAcquisition && d.offsetAccountId ? d.offsetAccountId : null,
  });
  if (error) throw error;
  return data as string;
}

export async function updateAsset(id: string, d: AssetDraft): Promise<void> {
  const { error } = await supabase.rpc('update_fixed_asset', { p_id: id, ...commonParams(d) });
  if (error) throw error;
}

export async function deleteAsset(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_fixed_asset', { p_id: id });
  if (error) throw error;
}

export async function disposeAsset(
  id: string,
  input: { date: string; proceeds: string; depositAccountId: string; reason: string },
): Promise<{ entry_id: string; accumulated_cents: number; book_value_cents: number; gain_loss_cents: number }> {
  const proceeds = input.proceeds.trim() === '' ? 0 : parseCents(input.proceeds) ?? 0;
  const { data, error } = await supabase.rpc('dispose_fixed_asset', {
    p_id: id,
    p_disposal_date: input.date,
    p_proceeds_cents: proceeds,
    p_deposit_account_id: proceeds > 0 ? input.depositAccountId : null,
    p_reason: input.reason.trim() || null,
  });
  if (error) throw error;
  return data as { entry_id: string; accumulated_cents: number; book_value_cents: number; gain_loss_cents: number };
}

export async function runDepreciation(through: string): Promise<RunResult> {
  const { data, error } = await supabase.rpc('post_depreciation_run', { p_through: through });
  if (error) throw error;
  const r = (data ?? {}) as Partial<RunResult>;
  return {
    posted_lines: num(r.posted_lines),
    posted_cents: num(r.posted_cents),
    entries: num(r.entries),
    skipped_closed_periods: num(r.skipped_closed_periods),
  };
}

/** accountOwnerId = owner's profile id, or a team member's account_owner_id. */
export async function fetchAssetEvents(accountOwnerId: string, limit = 50): Promise<AssetEvent[]> {
  const { data, error } = await supabase
    .from('fixed_asset_events')
    .select('id, actor_id, asset_id, action, detail, created_at')
    .eq('user_id', accountOwnerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as AssetEvent[];
}

/** Fleet vehicles for the optional link. Never throws: the link is a convenience, not a requirement. */
export async function fetchVehicleOptions(): Promise<VehicleOption[]> {
  try {
    const { data, error } = await supabase.from('vehicles').select('id, label, license_plate').order('label').limit(300);
    if (error) return [];
    return (data ?? []) as VehicleOption[];
  } catch {
    return [];
  }
}
