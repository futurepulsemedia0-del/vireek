// Supabase data access for /dashboard/fuel-cards. Every function throws an Error
// with a user-presentable message; callers decide how to surface it. Reads are
// scoped by RLS; all writes go through SECURITY DEFINER RPCs (matching and
// anomaly detection run in the database).
import { supabase } from '@/lib/supabase';
import type { Technician } from '@/lib/vehicleManagement';
import type {
  AnomalyStatus, CardPayload, FuelAnomaly, FuelCard, FuelImportRecord, FuelSettings, FuelTransaction, ImportResult, ImportRow,
} from '@/lib/fuelCards';

const CARD_COLS = 'id, label, provider, card_last4, vehicle_id, technician_id, status, tank_capacity_gallons, notes';
const SETTINGS_COLS =
  'max_gallons_per_txn, max_txns_per_day, double_swipe_minutes, price_tolerance_pct, business_hours_start, business_hours_end, mpg_min, mpg_max, post_to_expenses, timezone';
const TXN_COLS =
  'id, import_id, transaction_at, card_last4, plate, merchant, city, state, product, gallons, unit_price, amount, odometer_miles, card_id, vehicle_id, technician_name, match_method';
const ANOMALY_COLS =
  'id, transaction_id, rule, severity, details, status, note, reviewed_at, created_at, transaction:fuel_transactions(transaction_at, merchant, city, state, amount, gallons, card_last4, vehicle_id, technician_name)';
const IMPORT_COLS = 'id, file_name, received_count, inserted_count, duplicate_count, rejected_count, matched_count, unmatched_count, flagged_count, created_at';

interface DbError { message?: string; code?: string }

function fail(error: DbError | null | undefined, fallback: string): never {
  if (error?.code === '42501') throw new Error("You don't have permission to do that.");
  if (error?.code === '23503') throw new Error('A linked record no longer exists. Refresh and try again.');
  // Messages we raise ourselves inside the RPCs are safe to show.
  if (error?.code === 'P0002' || error?.code === '22023') throw new Error(error.message || fallback);
  throw new Error(fallback);
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

export interface FuelVehicle {
  id: string;
  label: string;
  license_plate: string | null;
  status: string;
  fuel_type: string;
}

export interface FuelOverview {
  cards: FuelCard[];
  settings: FuelSettings | null;
  vehicles: FuelVehicle[];
  technicians: Technician[];
  transactions: FuelTransaction[];
  anomalies: FuelAnomaly[];
  imports: FuelImportRecord[];
}

const toTxn = (r: Record<string, unknown>): FuelTransaction => ({
  ...(r as unknown as FuelTransaction),
  gallons: num(r.gallons), amount: num(r.amount), unit_price: numOrNull(r.unit_price), odometer_miles: numOrNull(r.odometer_miles),
});

function toAnomaly(r: Record<string, unknown>): FuelAnomaly {
  const raw = r.transaction;
  const t = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null | undefined;
  return {
    ...(r as unknown as FuelAnomaly),
    details: (r.details ?? {}) as Record<string, unknown>,
    transaction: t ? ({ ...(t as unknown as FuelAnomaly['transaction']), amount: num(t.amount), gallons: num(t.gallons) } as FuelAnomaly['transaction']) : null,
  };
}

/** Everything the page needs in one round trip. `days` limits the transaction window. */
export async function fetchFuelOverview(days: number): Promise<FuelOverview> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const [c, s, v, t, tx, an, im] = await Promise.all([
    supabase.from('fuel_cards').select(CARD_COLS).order('label', { ascending: true }),
    supabase.from('fuel_card_settings').select(SETTINGS_COLS).maybeSingle(),
    supabase.from('vehicles').select('id, label, license_plate, status, fuel_type').order('label', { ascending: true }),
    supabase.rpc('vehicle_assignable_technicians'),
    supabase.from('fuel_transactions').select(TXN_COLS).gte('transaction_at', since).order('transaction_at', { ascending: false }).limit(1000),
    supabase.from('fuel_anomalies').select(ANOMALY_COLS).order('created_at', { ascending: false }).limit(1000),
    supabase.from('fuel_imports').select(IMPORT_COLS).order('created_at', { ascending: false }).limit(20),
  ]);
  if (c.error) fail(c.error, 'Could not load your fuel cards.');
  if (s.error) fail(s.error, 'Could not load fuel card settings.');
  if (v.error) fail(v.error, 'Could not load your vehicles.');
  if (t.error) fail(t.error, 'Could not load your technicians.');
  if (tx.error) fail(tx.error, 'Could not load fuel transactions.');
  if (an.error) fail(an.error, 'Could not load anomalies.');
  if (im.error) fail(im.error, 'Could not load import history.');

  const sr = s.data as Record<string, unknown> | null;
  return {
    cards: ((c.data ?? []) as Record<string, unknown>[]).map((r) => ({ ...(r as unknown as FuelCard), tank_capacity_gallons: numOrNull(r.tank_capacity_gallons) })),
    settings: sr
      ? {
        ...(sr as unknown as FuelSettings),
        max_gallons_per_txn: num(sr.max_gallons_per_txn), price_tolerance_pct: num(sr.price_tolerance_pct),
        mpg_min: num(sr.mpg_min), mpg_max: num(sr.mpg_max),
      }
      : null,
    vehicles: (v.data ?? []) as FuelVehicle[],
    technicians: (t.data ?? []) as Technician[],
    transactions: ((tx.data ?? []) as Record<string, unknown>[]).map(toTxn),
    anomalies: ((an.data ?? []) as Record<string, unknown>[]).map(toAnomaly),
    imports: (im.data ?? []) as FuelImportRecord[],
  };
}

export async function importTransactions(fileName: string, rows: ImportRow[], provider: string | null): Promise<ImportResult> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  const { data, error } = await supabase.rpc('import_fuel_transactions', {
    p_file_name: fileName, p_rows: rows, p_timezone: timezone, p_provider: provider,
  });
  if (error) fail(error, 'The import failed. Nothing was saved — please try again.');
  return data as ImportResult;
}

export async function saveCard(payload: CardPayload, id: string | null): Promise<void> {
  const { error } = await supabase.rpc('save_fuel_card', {
    p_id: id, p_label: payload.label, p_provider: payload.provider, p_last4: payload.last4,
    p_vehicle_id: payload.vehicle_id, p_technician_id: payload.technician_id, p_status: payload.status,
    p_tank_capacity: payload.tank_capacity, p_notes: payload.notes,
  });
  if (error) fail(error, id ? 'Could not update the card.' : 'Could not add the card.');
}

export async function deleteCard(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_fuel_card', { p_id: id });
  if (error) fail(error, 'Could not delete the card.');
}

export async function saveSettings(s: FuelSettings): Promise<void> {
  const { error } = await supabase.rpc('save_fuel_card_settings', {
    p_max_gallons: s.max_gallons_per_txn, p_max_txns_per_day: s.max_txns_per_day, p_double_swipe_minutes: s.double_swipe_minutes,
    p_price_tolerance_pct: s.price_tolerance_pct, p_hours_start: s.business_hours_start, p_hours_end: s.business_hours_end,
    p_mpg_min: s.mpg_min, p_mpg_max: s.mpg_max, p_post_to_expenses: s.post_to_expenses, p_timezone: s.timezone,
  });
  if (error) fail(error, 'Could not save the settings.');
}

export async function reviewAnomalies(ids: string[], status: AnomalyStatus, note: string | null): Promise<number> {
  const { data, error } = await supabase.rpc('review_fuel_anomalies', { p_ids: ids, p_status: status, p_note: note });
  if (error) fail(error, 'Could not update the anomalies.');
  return num(data);
}

export async function rescanTransactions(days: number): Promise<{ scanned: number; open_anomalies: number }> {
  const { data, error } = await supabase.rpc('rescan_fuel_transactions', { p_days: days });
  if (error) fail(error, 'Could not re-scan transactions.');
  return data as { scanned: number; open_anomalies: number };
}

export async function deleteImport(id: string): Promise<number> {
  const { data, error } = await supabase.rpc('delete_fuel_import', { p_id: id });
  if (error) fail(error, 'Could not undo the import.');
  return num(data);
}
