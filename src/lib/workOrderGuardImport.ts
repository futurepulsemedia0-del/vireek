// src/lib/workOrderGuardImport.ts
//
// Work-Order Guard import: portal CSV export or pasted forwarded email -> WorkOrder[].
// Reuses the data-import engine's CSV parser, money parser and timezone-aware date parser, so a bad
// date or amount becomes a ROW ERROR (the row is skipped and reported) — never a silently wrong value.
// No portal login, scraping or automation: the user supplies the file/text.

import { parseCsv } from '../../supabase/functions/_shared/data-import/csv';
import { cleanText, parseDateTime, parseMoney } from '../../supabase/functions/_shared/data-import/normalize';
import type { Outcome, ProposalStatus, WorkOrder } from '@/lib/workOrderGuard';

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_CHARS = 5_000_000;

export type FieldKey =
  | 'woNumber' | 'receivedAt' | 'priority' | 'location' | 'trade' | 'nte' | 'estimate'
  | 'acceptedAt' | 'declinedAt' | 'checkedInAt' | 'checkInDistance'
  | 'proposalStatus' | 'proposalAmount' | 'proposalApprovedAt' | 'completedAt'
  | 'invoiceNumber' | 'invoiceSubmittedAt' | 'invoiceCount'
  | 'invoiceLabor' | 'invoiceTechnicians' | 'invoiceMaterials' | 'invoiceTrip' | 'invoiceFreight'
  | 'invoiceTax' | 'invoiceMgmtFee' | 'invoiceTotal' | 'outcome' | 'outcomeReason';

export const REQUIRED_FIELDS: FieldKey[] = ['woNumber', 'receivedAt'];

export const FIELD_LABELS: Record<FieldKey, string> = {
  woNumber: 'Work order #', receivedAt: 'Received date/time', priority: 'Priority', location: 'Location / store', trade: 'Trade',
  nte: 'NTE amount', estimate: 'Current estimate', acceptedAt: 'Accepted at', declinedAt: 'Declined at', checkedInAt: 'Checked in at',
  checkInDistance: 'Check-in distance', proposalStatus: 'Proposal status', proposalAmount: 'Proposal amount',
  proposalApprovedAt: 'Proposal approved at', completedAt: 'Completed at', invoiceNumber: 'Invoice #',
  invoiceSubmittedAt: 'Invoice submitted at', invoiceCount: 'Invoices submitted', invoiceLabor: 'Invoice labor',
  invoiceTechnicians: 'Technicians', invoiceMaterials: 'Invoice materials', invoiceTrip: 'Invoice trip charge',
  invoiceFreight: 'Invoice freight', invoiceTax: 'Invoice sales tax', invoiceMgmtFee: 'Invoice management fee',
  invoiceTotal: 'Invoice total', outcome: 'Final status', outcomeReason: 'Status reason',
};

export const FIELD_KEYS = Object.keys(FIELD_LABELS) as FieldKey[];

/** Header aliases, compared after lower-casing and stripping every non-alphanumeric character. Order = priority. */
const ALIASES: Record<FieldKey, string[]> = {
  woNumber: ['wonumber', 'workordernumber', 'workorder', 'wo', 'woid', 'workorderid', 'trackingnumber', 'tracking', 'ticketnumber', 'ticket'],
  receivedAt: ['receivedat', 'received', 'receiveddate', 'datereceived', 'createddate', 'createdat', 'created', 'creationdate', 'dateissued', 'issueddate', 'dateopened', 'opened'],
  priority: ['priority', 'urgency'],
  location: ['location', 'locationname', 'store', 'storename', 'storenumber', 'site', 'sitename'],
  trade: ['trade', 'tradetype', 'category', 'servicetype'],
  nte: ['nte', 'nteamount', 'notetoexceed', 'nottoexceed', 'nteusd'],
  estimate: ['estimate', 'estimateamount', 'currentestimate', 'worktodate'],
  acceptedAt: ['acceptedat', 'accepted', 'accepteddate', 'acceptdate', 'acknowledgedat', 'acknowledged'],
  declinedAt: ['declinedat', 'declined', 'declineddate'],
  checkedInAt: ['checkedinat', 'checkedin', 'checkin', 'checkintime', 'checkindate', 'firstcheckin'],
  checkInDistance: ['checkindistance', 'checkindistancemiles', 'checkindistancemi', 'distancemiles', 'distancefromsite'],
  proposalStatus: ['proposalstatus', 'proposal', 'quotestatus'],
  proposalAmount: ['proposalamount', 'proposaltotal', 'quoteamount'],
  proposalApprovedAt: ['proposalapprovedat', 'proposalapproved', 'proposalapproveddate', 'quoteapproveddate'],
  completedAt: ['completedat', 'completed', 'completeddate', 'completiondate', 'workcompleted', 'checkedoutat', 'checkout'],
  invoiceNumber: ['invoicenumber', 'invoiceno', 'invoiceid', 'invoice'],
  invoiceSubmittedAt: ['invoicesubmittedat', 'invoicesubmitted', 'invoicesubmitteddate', 'invoicedate', 'submitteddate', 'invoiced'],
  invoiceCount: ['invoicecount', 'invoicessubmitted', 'numberofinvoices', 'invoices'],
  invoiceLabor: ['invoicelabor', 'labor', 'laboramount', 'laborcost'],
  invoiceTechnicians: ['invoicetechnicians', 'technicians', 'technicianscount', 'techcount', 'techs', 'numberoftechnicians'],
  invoiceMaterials: ['invoicematerials', 'materials', 'materialsamount', 'parts'],
  invoiceTrip: ['invoicetrip', 'trip', 'tripcharge', 'tripfee'],
  invoiceFreight: ['invoicefreight', 'freight', 'shipping'],
  invoiceTax: ['invoicetax', 'salestax', 'tax'],
  invoiceMgmtFee: ['invoicemanagementfee', 'invoicemgmtfee', 'managementfee', 'mgmtfee', 'adminfee'],
  invoiceTotal: ['invoicetotal', 'invoiceamount', 'totalamount', 'total', 'amount'],
  outcome: ['outcome', 'finalstatus', 'invoicestatus', 'status'],
  outcomeReason: ['outcomereason', 'rejectionreason', 'voidreason', 'statusreason', 'reason'],
};

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export type ColumnMapping = Partial<Record<FieldKey, string>>;

export interface RowError { row: number; field?: FieldKey; message: string }

export interface ImportResult {
  orders: WorkOrder[];
  errors: RowError[];
  headers: string[];
  mapping: ColumnMapping;
  /** Required fields no column could be mapped to. */
  missingRequired: FieldKey[];
  /** Data rows seen (excluding the header). */
  rowCount: number;
}

/** Best-effort header -> field mapping. Each header is used at most once. */
export function autoMapColumns(headers: string[], extra: Partial<Record<FieldKey, string[]>> = {}): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  for (const field of FIELD_KEYS) {
    for (const alias of [...ALIASES[field], ...(extra[field] ?? [])]) {
      const hit = headers.find((h) => !used.has(h) && key(h) === alias);
      if (hit) { mapping[field] = hit; used.add(hit); break; }
    }
  }
  return mapping;
}

// ------------------------------------------------------------------ value parsers

const OUTCOME_WORDS: Record<string, Outcome> = {
  open: 'open', new: 'open', inprogress: 'open', accepted: 'open', dispatched: 'open', scheduled: 'open', checkedin: 'open',
  completed: 'open', complete: 'open', onhold: 'open', invoiced: 'open', submitted: 'open', pending: 'open', '': 'open',
  approved: 'approved', invoiceapproved: 'approved',
  paid: 'paid', paymentsent: 'paid', invoicepaid: 'paid',
  rejected: 'rejected', invoicerejected: 'rejected', disputed: 'rejected',
  voided: 'voided', void: 'voided', invoicevoided: 'voided',
  expired: 'expired', ineligible: 'expired',
  cancelled: 'cancelled', canceled: 'cancelled',
};
const PROPOSAL_WORDS: Record<string, ProposalStatus> = {
  '': 'none', none: 'none', na: 'none', notrequired: 'none',
  pending: 'pending', submitted: 'pending', awaitingapproval: 'pending',
  approved: 'approved', accepted: 'approved',
  rejected: 'rejected', declined: 'rejected', denied: 'rejected',
};

type Cell<T> = { ok: true; value: T } | { ok: false; message: string };
const ok = <T,>(value: T): Cell<T> => ({ ok: true, value });
const bad = (message: string): Cell<never> => ({ ok: false, message });

function date(raw: string | undefined, tz: string, label: string): Cell<string | null> {
  const v = parseDateTime(raw, tz);
  return v === undefined ? bad(`${label}: "${cleanText(raw)}" is not a recognised date`) : ok(v);
}
function cents(raw: string | undefined, label: string): Cell<number | null> {
  const v = parseMoney(raw);
  if (v === undefined) return bad(`${label}: "${cleanText(raw)}" is not a valid amount`);
  if (v !== null && v < 0) return bad(`${label}: negative amounts are not allowed`);
  return ok(v === null ? null : Math.round(v * 100));
}
function whole(raw: string | undefined, label: string): Cell<number | null> {
  const t = cleanText(raw);
  if (!t) return ok(null);
  if (!/^\d{1,4}$/.test(t)) return bad(`${label}: "${t}" must be a whole number`);
  return ok(Number(t));
}
function miles(raw: string | undefined, label: string): Cell<number | null> {
  const t = cleanText(raw).toLowerCase();
  if (!t) return ok(null);
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(mi|miles?|ft|feet|m|km)?$/);
  if (!m) return bad(`${label}: "${t}" is not a distance`);
  const n = Number(m[1]);
  const unit = m[2] ?? 'mi';
  const factor = unit.startsWith('mi') ? 1 : unit === 'ft' || unit === 'feet' ? 1 / 5280 : unit === 'm' ? 1 / 1609.344 : 1 / 1.609344;
  return ok(Math.round(n * factor * 1000) / 1000);
}

/** Converts one raw record (canonical field -> cell text) into a WorkOrder, or the list of problems. */
export function recordToOrder(raw: Partial<Record<FieldKey, string>>, tz: string): { order?: WorkOrder; errors: { field?: FieldKey; message: string }[] } {
  const errors: { field?: FieldKey; message: string }[] = [];
  const take = <T,>(field: FieldKey, cell: Cell<T>, fallback: T): T => {
    if (cell.ok) return cell.value;
    errors.push({ field, message: cell.message });
    return fallback;
  };
  const woNumber = cleanText(raw.woNumber);
  if (!woNumber) errors.push({ field: 'woNumber', message: 'Work order # is empty' });
  else if (woNumber.length > 80) errors.push({ field: 'woNumber', message: 'Work order # is longer than 80 characters' });

  const receivedAt = take('receivedAt', date(raw.receivedAt, tz, FIELD_LABELS.receivedAt), null);
  if (receivedAt === null && !errors.some((e) => e.field === 'receivedAt')) errors.push({ field: 'receivedAt', message: 'Received date/time is empty' });

  const outcomeText = key(cleanText(raw.outcome));
  const outcome = OUTCOME_WORDS[outcomeText];
  if (outcome === undefined) errors.push({ field: 'outcome', message: `Final status: "${cleanText(raw.outcome)}" is not recognised (use open, approved, paid, rejected, voided, expired or cancelled)` });
  const proposal = PROPOSAL_WORDS[key(cleanText(raw.proposalStatus))];
  if (proposal === undefined) errors.push({ field: 'proposalStatus', message: `Proposal status: "${cleanText(raw.proposalStatus)}" is not recognised (use none, pending, approved or rejected)` });

  const invoiceNumber = cleanText(raw.invoiceNumber) || null;
  const count = take('invoiceCount', whole(raw.invoiceCount, FIELD_LABELS.invoiceCount), null);

  const order: WorkOrder = {
    woNumber,
    location: cleanText(raw.location) || null,
    trade: cleanText(raw.trade) || null,
    priority: cleanText(raw.priority).toLowerCase() || 'normal',
    nteCents: take('nte', cents(raw.nte, FIELD_LABELS.nte), null),
    estimateCents: take('estimate', cents(raw.estimate, FIELD_LABELS.estimate), null),
    receivedAt: receivedAt ?? '',
    acceptedAt: take('acceptedAt', date(raw.acceptedAt, tz, FIELD_LABELS.acceptedAt), null),
    declinedAt: take('declinedAt', date(raw.declinedAt, tz, FIELD_LABELS.declinedAt), null),
    checkedInAt: take('checkedInAt', date(raw.checkedInAt, tz, FIELD_LABELS.checkedInAt), null),
    checkInDistanceMiles: take('checkInDistance', miles(raw.checkInDistance, FIELD_LABELS.checkInDistance), null),
    proposalStatus: proposal ?? 'none',
    proposalAmountCents: take('proposalAmount', cents(raw.proposalAmount, FIELD_LABELS.proposalAmount), null),
    proposalApprovedAt: take('proposalApprovedAt', date(raw.proposalApprovedAt, tz, FIELD_LABELS.proposalApprovedAt), null),
    completedAt: take('completedAt', date(raw.completedAt, tz, FIELD_LABELS.completedAt), null),
    invoiceNumber,
    invoiceSubmittedAt: take('invoiceSubmittedAt', date(raw.invoiceSubmittedAt, tz, FIELD_LABELS.invoiceSubmittedAt), null),
    invoiceCount: count ?? (invoiceNumber ? 1 : 0),
    invoiceLaborCents: take('invoiceLabor', cents(raw.invoiceLabor, FIELD_LABELS.invoiceLabor), null),
    invoiceTechnicians: take('invoiceTechnicians', whole(raw.invoiceTechnicians, FIELD_LABELS.invoiceTechnicians), null),
    invoiceMaterialsCents: take('invoiceMaterials', cents(raw.invoiceMaterials, FIELD_LABELS.invoiceMaterials), null),
    invoiceTripCents: take('invoiceTrip', cents(raw.invoiceTrip, FIELD_LABELS.invoiceTrip), null),
    invoiceFreightCents: take('invoiceFreight', cents(raw.invoiceFreight, FIELD_LABELS.invoiceFreight), null),
    invoiceTaxCents: take('invoiceTax', cents(raw.invoiceTax, FIELD_LABELS.invoiceTax), null),
    invoiceMgmtFeeCents: take('invoiceMgmtFee', cents(raw.invoiceMgmtFee, FIELD_LABELS.invoiceMgmtFee), null),
    invoiceTotalCents: take('invoiceTotal', cents(raw.invoiceTotal, FIELD_LABELS.invoiceTotal), null),
    outcome: outcome ?? 'open',
    outcomeReason: cleanText(raw.outcomeReason).slice(0, 300) || null,
  };
  return errors.length > 0 ? { errors } : { order, errors };
}

// ------------------------------------------------------------------ CSV

export const stripBom = (text: string): string => text.replace(/^﻿/, '');

/** Parses a portal CSV export. `mapping` overrides the auto-detected columns. */
export function parseWorkOrderCsv(text: string, opts: { timezone: string; mapping?: ColumnMapping }): ImportResult {
  const empty = (missing: FieldKey[], message?: string): ImportResult => ({
    orders: [], errors: message ? [{ row: 0, message }] : [], headers: [], mapping: {}, missingRequired: missing, rowCount: 0,
  });
  if (text.length > MAX_IMPORT_CHARS) return empty([], `File is larger than ${Math.round(MAX_IMPORT_CHARS / 1_000_000)} MB — split it by month.`);
  const { headers, rows } = parseCsv(stripBom(text));
  if (headers.length === 0) return empty(REQUIRED_FIELDS, 'The file has no rows.');
  if (rows.length > MAX_IMPORT_ROWS) return { ...empty([], `The file has ${rows.length} rows; the limit is ${MAX_IMPORT_ROWS}. Split it by month.`), headers };

  const mapping: ColumnMapping = {};
  const auto = autoMapColumns(headers);
  for (const f of FIELD_KEYS) {
    const chosen = opts.mapping && f in opts.mapping ? opts.mapping[f] : auto[f];
    if (chosen && headers.includes(chosen)) mapping[f] = chosen;
  }
  const missingRequired = REQUIRED_FIELDS.filter((f) => !mapping[f]);
  if (missingRequired.length > 0) return { orders: [], errors: [], headers, mapping, missingRequired, rowCount: rows.length };

  const orders: WorkOrder[] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();
  rows.forEach((row, idx) => {
    const rowNo = idx + 2; // header is row 1
    const raw: Partial<Record<FieldKey, string>> = {};
    for (const f of FIELD_KEYS) { const h = mapping[f]; if (h) raw[f] = row[h]; }
    const res = recordToOrder(raw, opts.timezone);
    if (!res.order) { for (const e of res.errors) errors.push({ row: rowNo, ...e }); return; }
    const dupe = res.order.woNumber.toLowerCase();
    if (seen.has(dupe)) { errors.push({ row: rowNo, field: 'woNumber', message: `Duplicate work order # ${res.order.woNumber} in this file (first row kept)` }); return; }
    seen.add(dupe);
    orders.push(res.order);
  });
  return { orders, errors, headers, mapping, missingRequired: [], rowCount: rows.length };
}

// ------------------------------------------------------------------ forwarded email

const EMAIL_EXTRA_ALIASES: Partial<Record<FieldKey, string[]>> = {
  receivedAt: ['date', 'sent', 'datesent'],
  woNumber: ['wonum', 'workorderno'],
};

/** Pulls a single work order out of a pasted/forwarded portal notification ("Label: value" lines). */
export function parseForwardedEmail(text: string, opts: { timezone: string }): ImportResult {
  const lines = text.slice(0, MAX_IMPORT_CHARS).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').split(/\r?\n/);
  const record: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^[\s>*-]*([A-Za-z][A-Za-z0-9 #/()._-]{0,40}?)\s*[:=]\s*(\S.*?)\s*$/);
    if (m && !(m[1].toLowerCase() in record)) record[m[1].toLowerCase()] = m[2];
  }
  const headers = Object.keys(record);
  const mapping = autoMapColumns(headers, EMAIL_EXTRA_ALIASES);
  const raw: Partial<Record<FieldKey, string>> = {};
  for (const f of FIELD_KEYS) { const h = mapping[f]; if (h) raw[f] = record[h]; }
  if (!raw.woNumber) {
    const m = text.match(/\b(?:work\s*order|WO)\s*(?:#|no\.?|number)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9-]{3,})/i);
    if (m) raw.woNumber = m[1];
  }
  const res = recordToOrder(raw, opts.timezone);
  const missingRequired = REQUIRED_FIELDS.filter((f) => !cleanText(raw[f]));
  if (!res.order) return { orders: [], errors: res.errors.map((e) => ({ row: 1, ...e })), headers, mapping, missingRequired, rowCount: 1 };
  return { orders: [res.order], errors: [], headers, mapping, missingRequired: [], rowCount: 1 };
}

// ------------------------------------------------------------------ RPC payload

const ORDER_COLUMNS: [keyof WorkOrder, string][] = [
  ['woNumber', 'wo_number'], ['location', 'location'], ['trade', 'trade'], ['priority', 'priority'], ['nteCents', 'nte_cents'],
  ['estimateCents', 'estimate_cents'], ['receivedAt', 'received_at'], ['acceptedAt', 'accepted_at'], ['declinedAt', 'declined_at'],
  ['checkedInAt', 'checked_in_at'], ['checkInDistanceMiles', 'checkin_distance_miles'], ['proposalStatus', 'proposal_status'],
  ['proposalAmountCents', 'proposal_amount_cents'], ['proposalApprovedAt', 'proposal_approved_at'], ['completedAt', 'completed_at'],
  ['invoiceNumber', 'invoice_number'], ['invoiceSubmittedAt', 'invoice_submitted_at'], ['invoiceCount', 'invoice_count'],
  ['invoiceLaborCents', 'invoice_labor_cents'], ['invoiceTechnicians', 'invoice_technicians'], ['invoiceMaterialsCents', 'invoice_materials_cents'],
  ['invoiceTripCents', 'invoice_trip_cents'], ['invoiceFreightCents', 'invoice_freight_cents'], ['invoiceTaxCents', 'invoice_tax_cents'],
  ['invoiceMgmtFeeCents', 'invoice_mgmt_fee_cents'], ['invoiceTotalCents', 'invoice_total_cents'], ['outcome', 'outcome'], ['outcomeReason', 'outcome_reason'],
];

export function orderToRow(o: WorkOrder): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [k, col] of ORDER_COLUMNS) row[col] = o[k];
  return row;
}

export function rowToOrder(row: Record<string, unknown>): WorkOrder {
  const num = (v: unknown) => (v == null ? null : Number(v));
  const str = (v: unknown) => (v == null ? null : String(v));
  const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());
  return {
    id: String(row.id),
    woNumber: String(row.wo_number), location: str(row.location), trade: str(row.trade), priority: String(row.priority ?? 'normal'),
    nteCents: num(row.nte_cents), estimateCents: num(row.estimate_cents),
    receivedAt: new Date(String(row.received_at)).toISOString(), acceptedAt: iso(row.accepted_at), declinedAt: iso(row.declined_at),
    checkedInAt: iso(row.checked_in_at), checkInDistanceMiles: num(row.checkin_distance_miles),
    proposalStatus: (row.proposal_status as ProposalStatus) ?? 'none', proposalAmountCents: num(row.proposal_amount_cents),
    proposalApprovedAt: iso(row.proposal_approved_at), completedAt: iso(row.completed_at),
    invoiceNumber: str(row.invoice_number), invoiceSubmittedAt: iso(row.invoice_submitted_at), invoiceCount: Number(row.invoice_count ?? 0),
    invoiceLaborCents: num(row.invoice_labor_cents), invoiceTechnicians: num(row.invoice_technicians),
    invoiceMaterialsCents: num(row.invoice_materials_cents), invoiceTripCents: num(row.invoice_trip_cents),
    invoiceFreightCents: num(row.invoice_freight_cents), invoiceTaxCents: num(row.invoice_tax_cents),
    invoiceMgmtFeeCents: num(row.invoice_mgmt_fee_cents), invoiceTotalCents: num(row.invoice_total_cents),
    outcome: (row.outcome as Outcome) ?? 'open', outcomeReason: str(row.outcome_reason),
  };
}
