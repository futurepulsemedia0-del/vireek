// Pure card-feed logic: types, matching (card -> vehicle -> technician), kind detection,
// Plaid/bank-row mapping, receipt rules and form validation. No React, no network —
// everything here is unit-tested in cardFeed.test.ts. Data access lives in cardFeedApi.ts.
// The database re-runs the SAME matching rules (public._cardfeed_match) so results cannot
// be forged from the browser; this file powers previews and is the executable spec.
import type { ColumnMapping, DateOrder, FuelProduct, ImportRow, NormalizeResult } from '@/lib/fuelCards';
import { normalizeImportRows } from '@/lib/fuelCards';
import type { FieldErrors, ParseResult } from '@/lib/vehicleManagement';

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

export const CARD_KINDS = ['expense', 'fuel'] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const CARD_SOURCES = ['csv', 'plaid'] as const;
export type CardSource = (typeof CARD_SOURCES)[number];
export const CARD_STATUSES = ['active', 'suspended', 'cancelled'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];
export const RECEIPT_STATUSES = ['required', 'not_required', 'attached', 'waived'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];
export type MatchMethod = 'card' | 'plate' | 'none';
export type CardFlag = 'unregistered_card' | 'ambiguous_card' | 'card_inactive' | 'no_driver' | 'possible_duplicate';

export const MAX_IMPORT_ROWS = 5000;
export const MAX_RECEIPT_DAYS = 60;
export const AMOUNT_TOLERANCE_PCT = 5;
export const AMOUNT_TOLERANCE_MIN_CENTS = 100;
export const DATE_TOLERANCE_DAYS = 10;

export const KIND_LABELS: Record<CardKind, string> = { expense: 'Expense card', fuel: 'Fuel card' };
export const FLAG_META: Record<CardFlag, { label: string; help: string }> = {
  unregistered_card: { label: 'Unregistered card', help: 'These last 4 digits are not in your card list. Add the card so purchases are matched automatically.' },
  ambiguous_card: { label: 'Ambiguous card', help: 'More than one card shares these last 4 digits. Add the provider to each card to tell them apart.' },
  card_inactive: { label: 'Inactive card', help: 'This card is suspended or cancelled but is still being used.' },
  no_driver: { label: 'No technician', help: 'No technician could be matched. Assign one so the right person is asked for the receipt.' },
  possible_duplicate: { label: 'Possible duplicate', help: 'A purchase with the same amount and date already exists from another import source.' },
};

export interface CompanyCard {
  id: string;
  label: string;
  kind: CardKind;
  provider: string;
  card_last4: string;
  vehicle_id: string | null;
  technician_id: string | null;
  status: CardStatus;
  notes: string | null;
}

export interface CardTransaction {
  id: string;
  import_id: string | null;
  source: CardSource;
  transaction_at: string;
  provider: string | null;
  card_last4: string | null;
  plate: string | null;
  merchant: string | null;
  city: string | null;
  state: string | null;
  kind: CardKind;
  product: string | null;
  gallons: number | null;
  amount_cents: number;
  card_id: string | null;
  vehicle_id: string | null;
  vehicle_label: string | null;
  technician_id: string | null;
  technician_name: string | null;
  match_method: MatchMethod;
  assignment_locked: boolean;
  flags: CardFlag[];
  receipt_status: ReceiptStatus;
  receipt_due_at: string | null;
  expense_id: string | null;
  waived_reason: string | null;
  expense: { id: string; status: string; amount_cents: number; review_note: string | null } | null;
}

export interface CardImportRecord {
  id: string;
  source: CardSource;
  file_name: string;
  received_count: number;
  inserted_count: number;
  duplicate_count: number;
  rejected_count: number;
  matched_count: number;
  unmatched_count: number;
  created_at: string;
}

export interface CardFeedSettings {
  receipt_required_over_cents: number;
  receipt_due_days: number;
  bank_account_ids: string[];
  last_bank_import_at: string | null;
}

export interface CardImportRow extends ImportRow {
  kind: CardKind;
  provider?: string | null;
}

export interface CardImportResult {
  import_id: string;
  received: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  matched: number;
  unmatched: number;
  errors: { line: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Matching  (mirrors public._cardfeed_match — keep both in sync)
// ---------------------------------------------------------------------------

export interface MatchRowInput {
  transaction_at: string;
  card_last4: string | null;
  plate: string | null;
  provider?: string | null;
  kind?: CardKind | null;
}
export interface MatchCard { id: string; provider: string; card_last4: string; kind: CardKind; status: CardStatus; vehicle_id: string | null; technician_id: string | null }
export interface MatchVehicle { id: string; license_plate: string | null; assigned_technician_id: string | null }
export interface MatchAssignment { vehicle_id: string; technician_id: string | null; assigned_at: string; unassigned_at: string | null }
export interface MatchContext { cards: MatchCard[]; vehicles: MatchVehicle[]; assignments: MatchAssignment[] }
export interface MatchResult {
  cardId: string | null;
  vehicleId: string | null;
  technicianId: string | null;
  method: MatchMethod;
  kind: CardKind;
  flags: CardFlag[];
}

export const normalizePlate = (raw: string | null | undefined): string => (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const last4Of = (raw: string | null | undefined): string | null => {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
};

export function matchCardTransaction(row: MatchRowInput, ctx: MatchContext): MatchResult {
  const at = Date.parse(row.transaction_at);
  const last4 = last4Of(row.card_last4);
  const plate = normalizePlate(row.plate);
  const provider = (row.provider ?? '').trim().toLowerCase();

  // 1) Card: last 4 digits, disambiguated by provider when several cards share them.
  let card: MatchCard | null = null;
  let ambiguous = false;
  if (last4) {
    const all = ctx.cards.filter((c) => c.card_last4 === last4);
    if (all.length === 1) card = all[0];
    else if (all.length > 1) {
      const byProvider = provider ? all.filter((c) => c.provider.trim().toLowerCase() === provider) : [];
      if (byProvider.length === 1) card = byProvider[0];
      else ambiguous = true;
    }
  }

  // 2) Vehicle: the card's vehicle, else a UNIQUE licence-plate hit.
  let plateVehicle: MatchVehicle | null = null;
  if (plate) {
    const hits = ctx.vehicles.filter((v) => normalizePlate(v.license_plate) === plate);
    if (hits.length === 1) plateVehicle = hits[0];
  }
  const vehicleId = card?.vehicle_id ?? plateVehicle?.id ?? null;

  // 3) Technician: the card's holder, else whoever had the vehicle at purchase time.
  let technicianId: string | null = card?.technician_id ?? null;
  if (!technicianId && vehicleId && Number.isFinite(at)) {
    const history = ctx.assignments.filter((a) => a.vehicle_id === vehicleId);
    const inForce = history
      .filter((a) => a.technician_id && Date.parse(a.assigned_at) <= at && (a.unassigned_at == null || at < Date.parse(a.unassigned_at)))
      .sort((a, b) => Date.parse(b.assigned_at) - Date.parse(a.assigned_at))[0];
    if (inForce) technicianId = inForce.technician_id;
    else if (history.length === 0) technicianId = ctx.vehicles.find((v) => v.id === vehicleId)?.assigned_technician_id ?? null;
  }

  const flags: CardFlag[] = [];
  if (last4 && !card && !ambiguous) flags.push('unregistered_card');
  if (ambiguous) flags.push('ambiguous_card');
  if (card && card.status !== 'active') flags.push('card_inactive');
  if (!technicianId) flags.push('no_driver');

  return {
    cardId: card?.id ?? null,
    vehicleId,
    technicianId,
    method: card ? 'card' : plateVehicle ? 'plate' : 'none',
    kind: card?.kind ?? row.kind ?? 'expense',
    flags,
  };
}

// ---------------------------------------------------------------------------
// Kind detection (fuel vs. other expense)
// ---------------------------------------------------------------------------

const FUEL_PRODUCTS: ReadonlySet<string> = new Set<FuelProduct>(['gasoline', 'diesel', 'def', 'electric', 'propane']);
const FUEL_MERCHANTS =
  /\b(shell|exxon|exxonmobil|mobil|chevron|texaco|bp|sunoco|valero|marathon|speedway|citgo|conoco|phillips 66|76|arco|murphy usa|murphy express|circle k|wawa|sheetz|pilot|flying j|love'?s|loves travel|ta travel|petro|casey'?s|quiktrip|racetrac|buc-?ee'?s|kwik trip|kum & go|gas|fuel|petroleum|ev ?charg\w*|chargepoint|electrify america|evgo)\b/i;

export function detectKind(input: { merchant?: string | null; product?: string | null; gallons?: number | null }): CardKind {
  if ((input.gallons ?? 0) > 0) return 'fuel';
  if (input.product && FUEL_PRODUCTS.has(input.product)) return 'fuel';
  if (input.merchant && FUEL_MERCHANTS.test(input.merchant)) return 'fuel';
  return 'expense';
}

/** CSV rows: reuse the proven fuel-card normaliser, then tag each row with its kind. */
export function normalizeCardCsv(table: string[][], mapping: ColumnMapping, order?: DateOrder): Omit<NormalizeResult, 'rows'> & { rows: CardImportRow[] } {
  const base = normalizeImportRows(table, mapping, order);
  return { ...base, rows: base.rows.map((r) => ({ ...r, kind: detectKind({ merchant: r.merchant, product: r.product, gallons: r.gallons }) })) };
}

// ---------------------------------------------------------------------------
// Bank (Plaid) feed -> import rows
// ---------------------------------------------------------------------------

export interface BankAccountLite { id: string; name: string; mask: string | null; account_type: string }
export interface BankMapResult {
  rows: CardImportRow[];
  skipped: { pending: number; credits: number; outsideAccounts: number; invalid: number };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const clip = (s: unknown, n: number): string | null => {
  const v = typeof s === 'string' ? s.trim() : '';
  return v ? v.slice(0, n) : null;
};

/**
 * Turns bank_transactions rows (either column naming used in this repo) into import rows.
 * Bank amounts are signed from the business's view: negative = money OUT = a purchase.
 * The card identity is the bank account's mask (last 4 of the card account).
 */
export function bankRowsToCardRows(bankRows: Record<string, unknown>[], accounts: BankAccountLite[], accountIds: readonly string[]): BankMapResult {
  const wanted = new Set(accountIds);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out: CardImportRow[] = [];
  const skipped = { pending: 0, credits: 0, outsideAccounts: 0, invalid: 0 };

  bankRows.forEach((r, i) => {
    const accountId = String(r.account_id ?? r.bank_account_id ?? '');
    if (!wanted.has(accountId)) { skipped.outsideAccounts += 1; return; }
    if (r.pending === true) { skipped.pending += 1; return; }
    const cents = Number(r.amount_cents);
    const date = typeof r.posted_date === 'string' ? r.posted_date.slice(0, 10) : '';
    const id = typeof r.id === 'string' ? r.id : '';
    if (!Number.isFinite(cents) || !ISO_DAY.test(date) || !id) { skipped.invalid += 1; return; }
    if (cents >= 0) { skipped.credits += 1; return; }

    const amount = Math.round(-cents) / 100;
    if (amount > 100_000) { skipped.invalid += 1; return; }
    const merchant = clip(r.merchant_name, 120) ?? clip(r.description, 120) ?? clip(r.name, 120);
    const acct = byId.get(accountId);
    out.push({
      line: i + 1,
      transaction_at: `${date}T12:00:00`,
      card_last4: last4Of(acct?.mask ?? null),
      plate: null,
      merchant,
      city: null,
      state: null,
      product: 'other',
      gallons: 0,
      unit_price: null,
      amount,
      odometer: null,
      external_id: id,
      kind: detectKind({ merchant }),
      provider: null,
    });
  });
  return { rows: out, skipped };
}

// ---------------------------------------------------------------------------
// Receipt rules  (mirror cardfeed_submit_receipt / _cardfeed_receipt_status)
// ---------------------------------------------------------------------------

export function receiptRequirement(amountCents: number, thresholdCents: number): 'required' | 'not_required' {
  return amountCents > Math.max(0, thresholdCents) ? 'required' : 'not_required';
}

export function receiptDueAt(transactionAtIso: string, days: number): string {
  const d = new Date(transactionAtIso);
  d.setUTCDate(d.getUTCDate() + Math.min(Math.max(Math.trunc(days) || 0, 1), MAX_RECEIPT_DAYS));
  return d.toISOString();
}

export const amountTolerance = (cardCents: number): number =>
  Math.max(AMOUNT_TOLERANCE_MIN_CENTS, Math.round((cardCents * AMOUNT_TOLERANCE_PCT) / 100));

/** A receipt total may differ from the card charge by a tip or rounding, but not by much. */
export const amountsCompatible = (receiptCents: number, cardCents: number): boolean =>
  Math.abs(receiptCents - cardCents) <= amountTolerance(cardCents);

export function dateCompatible(receiptDate: string, transactionAtIso: string): boolean {
  const a = Date.parse(`${receiptDate}T12:00:00Z`);
  const b = Date.parse(transactionAtIso);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= (DATE_TOLERANCE_DAYS + 1) * 86_400_000;
}

export type ReceiptState = 'not_required' | 'needs_receipt' | 'overdue' | 'in_review' | 'approved' | 'rejected' | 'waived';

export function receiptState(
  t: Pick<CardTransaction, 'receipt_status' | 'receipt_due_at' | 'expense'>,
  now: number = Date.now(),
): ReceiptState {
  if (t.receipt_status === 'not_required') return 'not_required';
  if (t.receipt_status === 'waived') return 'waived';
  if (t.receipt_status === 'attached' && t.expense) {
    if (t.expense.status === 'rejected') return 'rejected';
    if (t.expense.status === 'approved' || t.expense.status === 'reimbursed') return 'approved';
    if (t.expense.status === 'submitted') return 'in_review';
  }
  // 'required', or 'attached' whose expense is gone / still a draft: the receipt is still owed.
  return t.receipt_due_at && Date.parse(t.receipt_due_at) < now ? 'overdue' : 'needs_receipt';
}

export const RECEIPT_STATE_META: Record<ReceiptState, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  not_required: { label: 'No receipt needed', tone: 'neutral' },
  needs_receipt: { label: 'Receipt needed', tone: 'warning' },
  overdue: { label: 'Receipt overdue', tone: 'danger' },
  in_review: { label: 'In review', tone: 'info' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected — resubmit', tone: 'danger' },
  waived: { label: 'Waived', tone: 'neutral' },
};

export const isOpenReceipt = (s: ReceiptState): boolean => s === 'needs_receipt' || s === 'overdue' || s === 'rejected';

/** Category for the expense: OCR suggestion first, then a sensible default for fuel cards. */
export function pickCategoryId(
  kind: CardKind,
  suggestedName: string | null | undefined,
  categories: { id: string; name: string; active: boolean }[],
): string {
  const active = categories.filter((c) => c.active);
  const wanted = (suggestedName ?? '').trim().toLowerCase();
  const byOcr = wanted ? active.find((c) => c.name.toLowerCase() === wanted) : undefined;
  if (byOcr) return byOcr.id;
  if (kind === 'fuel') {
    const fuel = active.find((c) => /fuel/i.test(c.name));
    if (fuel) return fuel.id;
  }
  return '';
}

export interface CardFeedSummary { total: number; spendCents: number; needReceipt: number; overdue: number; unassigned: number; rejected: number; matchRate: number | null }

export function summarizeCardTxns(list: CardTransaction[], now: number = Date.now()): CardFeedSummary {
  let spend = 0; let need = 0; let overdue = 0; let unassigned = 0; let rejected = 0; let matched = 0;
  for (const t of list) {
    spend += t.amount_cents;
    if (t.technician_id) matched += 1; else unassigned += 1;
    const s = receiptState(t, now);
    if (s === 'overdue') { overdue += 1; need += 1; } else if (s === 'needs_receipt') need += 1; else if (s === 'rejected') { rejected += 1; need += 1; }
  }
  return { total: list.length, spendCents: spend, needReceipt: need, overdue, unassigned, rejected, matchRate: list.length ? Math.round((matched / list.length) * 100) : null };
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export interface CardFormValues { label: string; kind: CardKind; provider: string; last4: string; vehicle_id: string; technician_id: string; status: CardStatus; notes: string }
export interface CardPayload { label: string; kind: CardKind; provider: string; last4: string; vehicle_id: string | null; technician_id: string | null; status: CardStatus; notes: string | null }
export const EMPTY_CARD_FORM: CardFormValues = { label: '', kind: 'expense', provider: '', last4: '', vehicle_id: '', technician_id: '', status: 'active', notes: '' };

export function parseCardForm(f: CardFormValues): ParseResult<CardPayload> {
  const errors: FieldErrors = {};
  const label = f.label.trim();
  if (label.length < 1 || label.length > 80) errors.label = 'Give the card a name (up to 80 characters).';
  const last4 = f.last4.trim();
  if (!/^\d{4}$/.test(last4)) errors.last4 = 'Enter exactly the last 4 digits.';
  const provider = f.provider.trim();
  if (provider.length > 40) errors.provider = 'Provider must be 40 characters or fewer.';
  if (f.notes.length > 500) errors.notes = 'Notes must be 500 characters or fewer.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      label, kind: f.kind, provider: provider || 'other', last4, status: f.status,
      vehicle_id: f.vehicle_id || null, technician_id: f.technician_id || null, notes: f.notes.trim() || null,
    },
  };
}

export interface FeedSettingsForm { over: string; days: string }

export function parseFeedSettingsForm(f: FeedSettingsForm): ParseResult<{ receipt_required_over_cents: number; receipt_due_days: number }> {
  const errors: FieldErrors = {};
  const over = Number(f.over.trim() === '' ? '0' : f.over);
  if (!Number.isFinite(over) || over < 0 || over > 100_000) errors.over = 'Enter an amount from 0 to 100,000 (0 = every purchase).';
  const days = Number(f.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_RECEIPT_DAYS) errors.days = `Enter whole days from 1 to ${MAX_RECEIPT_DAYS}.`;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { receipt_required_over_cents: Math.round(over * 100), receipt_due_days: days } };
}
