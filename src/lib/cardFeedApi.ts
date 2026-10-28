// Supabase data access for /dashboard/card-feed. Every function throws an Error with a
// user-presentable message. Reads are scoped by RLS (managers see all, a technician only
// their own purchases); every write is a SECURITY DEFINER RPC.
import { supabase } from '@/lib/supabase';
import type { Technician } from '@/lib/vehicleManagement';
import { bankRowsToCardRows } from '@/lib/cardFeed';
import type {
  BankAccountLite, CardFeedSettings, CardFlag, CardImportRecord, CardImportResult, CardImportRow, CardPayload, CardTransaction, CompanyCard,
} from '@/lib/cardFeed';

interface DbError { message?: string; code?: string }

function fail(error: DbError | null | undefined, fallback: string): never {
  if (error?.code === '42501') throw new Error("You don't have permission to do that.");
  if (error?.code === '23503') throw new Error('A linked record no longer exists. Refresh and try again.');
  // Messages raised by our own RPCs (and save_expense) are written for people.
  if (error?.code === 'P0002' || error?.code === '22023' || error?.code === 'P0001') throw new Error(error.message || fallback);
  throw new Error(fallback);
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

const CARD_COLS = 'id, label, kind, provider, card_last4, vehicle_id, technician_id, status, notes';
const SETTINGS_COLS = 'receipt_required_over_cents, receipt_due_days, bank_account_ids, last_bank_import_at, timezone';
const TXN_COLS =
  'id, import_id, source, transaction_at, provider, card_last4, plate, merchant, city, state, kind, product, gallons, amount_cents, card_id, vehicle_id, vehicle_label, technician_id, technician_name, match_method, assignment_locked, flags, receipt_status, receipt_due_at, expense_id, waived_reason, expense:expenses(id, status, amount_cents, review_note)';
const IMPORT_COLS = 'id, source, file_name, received_count, inserted_count, duplicate_count, rejected_count, matched_count, unmatched_count, created_at';

export interface CardVehicle { id: string; label: string; license_plate: string | null }

export interface CardFeedOverview {
  transactions: CardTransaction[];
  cards: CompanyCard[];
  settings: (CardFeedSettings & { timezone: string }) | null;
  imports: CardImportRecord[];
  vehicles: CardVehicle[];
  technicians: Technician[];
  bankAccounts: BankAccountLite[];
}

function toTxn(r: Record<string, unknown>): CardTransaction {
  const raw = r.expense;
  const e = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null | undefined;
  return {
    ...(r as unknown as CardTransaction),
    amount_cents: num(r.amount_cents),
    gallons: numOrNull(r.gallons),
    flags: ((r.flags ?? []) as string[]) as CardFlag[],
    expense: e ? { id: String(e.id), status: String(e.status), amount_cents: num(e.amount_cents), review_note: (e.review_note as string | null) ?? null } : null,
  };
}

/** Everything the page needs. Technicians (non-managers) only get their own purchases. */
export async function fetchCardFeed(days: number, isManager: boolean): Promise<CardFeedOverview> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const txReq = supabase.from('card_transactions').select(TXN_COLS).gte('transaction_at', since).order('transaction_at', { ascending: false }).limit(1000);
  if (!isManager) {
    const { data, error } = await txReq;
    if (error) fail(error, 'Could not load your card purchases.');
    return { transactions: ((data ?? []) as unknown as Record<string, unknown>[]).map(toTxn), cards: [], settings: null, imports: [], vehicles: [], technicians: [], bankAccounts: [] };
  }

  const [tx, c, s, im, v, t, ba] = await Promise.all([
    txReq,
    supabase.from('company_cards').select(CARD_COLS).order('label', { ascending: true }),
    supabase.from('card_feed_settings').select(SETTINGS_COLS).maybeSingle(),
    supabase.from('card_imports').select(IMPORT_COLS).order('created_at', { ascending: false }).limit(20),
    supabase.from('vehicles').select('id, label, license_plate').order('label', { ascending: true }),
    supabase.rpc('vehicle_assignable_technicians'),
    // The bank feed is optional: a missing table or no access just means "no bank accounts".
    supabase.from('bank_accounts').select('id, name, mask, account_type').eq('is_active', true).order('name', { ascending: true }),
  ]);
  if (tx.error) fail(tx.error, 'Could not load card purchases.');
  if (c.error) fail(c.error, 'Could not load your cards.');
  if (s.error) fail(s.error, 'Could not load card feed settings.');
  if (im.error) fail(im.error, 'Could not load import history.');
  if (v.error) fail(v.error, 'Could not load your vehicles.');
  if (t.error) fail(t.error, 'Could not load your technicians.');

  const sr = s.data as Record<string, unknown> | null;
  return {
    transactions: ((tx.data ?? []) as unknown as Record<string, unknown>[]).map(toTxn),
    cards: (c.data ?? []) as unknown as CompanyCard[],
    settings: sr
      ? {
        receipt_required_over_cents: num(sr.receipt_required_over_cents),
        receipt_due_days: num(sr.receipt_due_days),
        bank_account_ids: ((sr.bank_account_ids ?? []) as string[]),
        last_bank_import_at: (sr.last_bank_import_at as string | null) ?? null,
        timezone: String(sr.timezone ?? 'UTC'),
      }
      : null,
    imports: (im.data ?? []) as unknown as CardImportRecord[],
    vehicles: (v.data ?? []) as CardVehicle[],
    technicians: (t.data ?? []) as Technician[],
    bankAccounts: ba.error ? [] : ((ba.data ?? []) as BankAccountLite[]),
  };
}

export async function importCardRows(source: 'csv' | 'plaid', fileName: string, rows: CardImportRow[]): Promise<CardImportResult> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  const { data, error } = await supabase.rpc('import_card_transactions', { p_source: source, p_file_name: fileName, p_rows: rows, p_timezone: timezone });
  if (error) fail(error, 'The import failed. Nothing was saved — please try again.');
  return data as CardImportResult;
}

/** Pulls posted purchases for the chosen bank accounts from the existing Plaid feed and imports them. Safe to repeat: rows are de-duplicated by bank transaction id. */
export async function importFromBank(accounts: BankAccountLite[], accountIds: string[], days: number): Promise<{ result: CardImportResult | null; skipped: ReturnType<typeof bankRowsToCardRows>['skipped']; found: number }> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('bank_transactions')
    .select('*')
    .eq('pending', false)
    .lt('amount_cents', 0)
    .gte('posted_date', since)
    .order('posted_date', { ascending: false })
    .limit(3000);
  if (error) throw new Error('Could not read your bank feed. Check that your bank is connected.');
  const mapped = bankRowsToCardRows((data ?? []) as Record<string, unknown>[], accounts, accountIds);
  if (mapped.rows.length === 0) return { result: null, skipped: mapped.skipped, found: 0 };
  const rows = mapped.rows.slice(0, 5000);
  const result = await importCardRows('plaid', `Bank feed ${new Date().toISOString().slice(0, 10)}`, rows);
  return { result, skipped: mapped.skipped, found: rows.length };
}

export async function saveCard(payload: CardPayload, id: string | null): Promise<void> {
  const { error } = await supabase.rpc('save_company_card', {
    p_id: id, p_label: payload.label, p_kind: payload.kind, p_provider: payload.provider, p_last4: payload.last4,
    p_vehicle_id: payload.vehicle_id, p_technician_id: payload.technician_id, p_status: payload.status, p_notes: payload.notes,
  });
  if (error) fail(error, id ? 'Could not update the card.' : 'Could not add the card.');
}

export async function deleteCard(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_company_card', { p_id: id });
  if (error) fail(error, 'Could not delete the card.');
}

export async function syncFuelCards(): Promise<number> {
  const { data, error } = await supabase.rpc('cardfeed_sync_fuel_cards');
  if (error) fail(error, 'Could not copy your fuel cards.');
  return num(data);
}

export async function saveFeedSettings(s: { receipt_required_over_cents: number; receipt_due_days: number; bank_account_ids: string[] }, timezone: string): Promise<void> {
  const { error } = await supabase.rpc('save_card_feed_settings', {
    p_receipt_over_cents: s.receipt_required_over_cents, p_receipt_due_days: s.receipt_due_days, p_bank_account_ids: s.bank_account_ids, p_timezone: timezone,
  });
  if (error) fail(error, 'Could not save the settings.');
}

export async function assignPurchases(ids: string[], technicianId: string | null, vehicleId: string | null): Promise<number> {
  const { data, error } = await supabase.rpc('cardfeed_assign', { p_ids: ids, p_technician_id: technicianId, p_vehicle_id: vehicleId });
  if (error) fail(error, 'Could not assign the purchases.');
  return num(data);
}

export async function waiveReceipts(ids: string[], reason: string): Promise<number> {
  const { data, error } = await supabase.rpc('cardfeed_waive_receipt', { p_ids: ids, p_reason: reason });
  if (error) fail(error, 'Could not waive the receipts.');
  return num(data);
}

export async function deleteCardImport(id: string): Promise<number> {
  const { data, error } = await supabase.rpc('delete_card_import', { p_id: id });
  if (error) fail(error, 'Could not undo the import.');
  return num(data);
}

export interface SubmitReceiptInput {
  txnId: string;
  vendor: string;
  expenseDate: string;
  amountCents: number;
  taxCents: number;
  categoryId: string;
  notes: string;
  receipt: { path: string; mime: string; hash: string | null };
  ocr: { status: 'none' | 'done' | 'failed'; data: unknown };
}

/** Files the receipt as a company-card expense and links it to the purchase in one transaction. */
export async function submitReceipt(i: SubmitReceiptInput): Promise<string> {
  const { data, error } = await supabase.rpc('cardfeed_submit_receipt', {
    p_txn_id: i.txnId,
    p_data: {
      vendor_name: i.vendor.trim(), expense_date: i.expenseDate, amount_cents: i.amountCents, tax_cents: i.taxCents,
      category_id: i.categoryId, notes: i.notes.trim() || null, receipt_path: i.receipt.path, receipt_mime: i.receipt.mime,
      receipt_hash: i.receipt.hash, ocr_status: i.ocr.status, ocr_data: i.ocr.data,
    },
    p_allocations: [],
  });
  if (error) {
    // save_expense raises plain exceptions (P0001) with readable messages.
    throw new Error(error.code === 'P0001' || error.code === '22023' || error.code === 'P0002' ? error.message : "We couldn't save the receipt. Please try again.");
  }
  return String(data);
}
