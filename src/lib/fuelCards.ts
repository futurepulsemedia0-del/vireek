// Pure fuel-card logic: types, CSV parsing, column mapping, row normalisation,
// import preview, anomaly metadata and form validation. No React, no network —
// everything here is unit-tested in fuelCards.test.ts. Data access lives in
// fuelCardsApi.ts; matching and anomaly detection run in the database.
import type { FieldErrors, ParseResult } from '@/lib/vehicleManagement';

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

export const FUEL_PRODUCTS = ['gasoline', 'diesel', 'def', 'electric', 'propane', 'other', 'non_fuel'] as const;
export type FuelProduct = (typeof FUEL_PRODUCTS)[number];
export const CARD_STATUSES = ['active', 'suspended', 'cancelled'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];
export const ANOMALY_STATUSES = ['open', 'confirmed', 'dismissed'] as const;
export type AnomalyStatus = (typeof ANOMALY_STATUSES)[number];
export type AnomalySeverity = 'info' | 'warning' | 'critical';
export const ANOMALY_RULES = [
  'card_inactive', 'unregistered_card', 'no_vehicle', 'vehicle_unavailable', 'over_capacity',
  'fuel_type_mismatch', 'non_fuel_purchase', 'double_swipe', 'daily_limit', 'price_outlier',
  'after_hours', 'odometer_regression', 'mpg_outlier',
] as const;
export type AnomalyRule = (typeof ANOMALY_RULES)[number];

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const PROVIDER_SUGGESTIONS = ['WEX', 'Fleetcor', 'Comdata', 'Voyager', 'Shell', 'BP', 'Other'] as const;

export interface FuelCard {
  id: string;
  label: string;
  provider: string;
  card_last4: string;
  vehicle_id: string | null;
  technician_id: string | null;
  status: CardStatus;
  tank_capacity_gallons: number | null;
  notes: string | null;
}

export interface FuelSettings {
  max_gallons_per_txn: number;
  max_txns_per_day: number;
  double_swipe_minutes: number;
  price_tolerance_pct: number;
  business_hours_start: number;
  business_hours_end: number;
  mpg_min: number;
  mpg_max: number;
  post_to_expenses: boolean;
  timezone: string;
}

export interface FuelTransaction {
  id: string;
  import_id: string | null;
  transaction_at: string;
  card_last4: string | null;
  plate: string | null;
  merchant: string | null;
  city: string | null;
  state: string | null;
  product: FuelProduct;
  gallons: number;
  unit_price: number | null;
  amount: number;
  odometer_miles: number | null;
  card_id: string | null;
  vehicle_id: string | null;
  technician_name: string | null;
  match_method: 'card' | 'plate' | 'none';
}

export interface FuelAnomaly {
  id: string;
  transaction_id: string;
  rule: AnomalyRule;
  severity: AnomalySeverity;
  details: Record<string, unknown>;
  status: AnomalyStatus;
  note: string | null;
  reviewed_at: string | null;
  created_at: string;
  transaction: Pick<
    FuelTransaction,
    'transaction_at' | 'merchant' | 'city' | 'state' | 'amount' | 'gallons' | 'card_last4' | 'vehicle_id' | 'technician_name'
  > | null;
}

export interface FuelImportRecord {
  id: string;
  file_name: string;
  received_count: number;
  inserted_count: number;
  duplicate_count: number;
  rejected_count: number;
  matched_count: number;
  unmatched_count: number;
  flagged_count: number;
  created_at: string;
}

export interface ImportRow {
  line: number;
  transaction_at: string;
  card_last4: string | null;
  plate: string | null;
  merchant: string | null;
  city: string | null;
  state: string | null;
  product: FuelProduct;
  gallons: number;
  unit_price: number | null;
  amount: number;
  odometer: number | null;
  external_id: string | null;
}

export interface ImportResult {
  import_id: string;
  received: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  matched: number;
  unmatched: number;
  flagged: number;
  errors: { line: string; reason: string }[];
}

export interface RowIssue { line: number; reason: string }

export const humanize = (key: string): string => {
  const s = key.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export const formatGallons = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '—' : `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })} gal`;

export const maskCard = (last4: string | null): string => (last4 ? `•••• ${last4}` : '—');

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180: quotes, escaped quotes, CRLF, BOM, ; , or tab)
// ---------------------------------------------------------------------------

export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  let inQuotes = false;
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  const best = (Object.keys(counts) as string[]).sort((a, b) => counts[b] - counts[a])[0];
  return counts[best] > 0 ? best : ',';
}

export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const endCell = () => { row.push(cell); cell = ''; };
  const endRow = () => { endCell(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) endCell();
    else if (ch === '\n') endRow();
    else if (ch === '\r') { if (text[i + 1] === '\n') i += 1; endRow(); }
    else cell += ch;
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

export const FIELD_KEYS = [
  'timestamp', 'date', 'time', 'card', 'plate', 'merchant', 'city', 'state',
  'product', 'gallons', 'unit_price', 'amount', 'odometer', 'external_id',
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];
export type ColumnMapping = Record<FieldKey, number | null>;

export const FIELD_LABELS: Record<FieldKey, string> = {
  timestamp: 'Date & time (one column)', date: 'Date', time: 'Time', card: 'Card number / last 4',
  plate: 'License plate', merchant: 'Merchant / station', city: 'City', state: 'State',
  product: 'Product / fuel type', gallons: 'Gallons', unit_price: 'Price per gallon',
  amount: 'Total amount', odometer: 'Odometer', external_id: 'Transaction ID',
};

const ALIASES: Record<FieldKey, string[]> = {
  timestamp: ['transactiondatetime', 'datetime', 'timestamp', 'transactiontimestamp', 'purchasedatetime'],
  date: ['transactiondate', 'date', 'transdate', 'purchasedate', 'txndate', 'saledate'],
  time: ['transactiontime', 'time', 'transtime', 'purchasetime', 'txntime'],
  card: ['cardnumber', 'card', 'cardno', 'cardlast4', 'last4', 'accountnumber', 'cardnum', 'maskedcard', 'pan'],
  plate: ['licenseplate', 'plate', 'licenceplate', 'platenumber', 'tag', 'vehiclelicense'],
  merchant: ['merchantname', 'merchant', 'station', 'sitename', 'location', 'locationname', 'vendor', 'stationname'],
  city: ['merchantcity', 'city', 'sitecity', 'locationcity'],
  state: ['merchantstate', 'state', 'sitestate', 'st', 'province'],
  product: ['productdescription', 'product', 'productname', 'fueltype', 'fuelproduct', 'item', 'itemdescription', 'productcode', 'fuel'],
  gallons: ['gallons', 'quantity', 'qty', 'volume', 'fuelquantity', 'units', 'gal'],
  unit_price: ['unitprice', 'pricepergallon', 'ppg', 'fuelprice', 'pricepergal', 'price', 'unitcost'],
  amount: ['totalamount', 'amount', 'total', 'transactionamount', 'grossamount', 'totalcost', 'cost', 'netamount'],
  odometer: ['odometer', 'odometerreading', 'odo', 'mileage', 'vehicleodometer'],
  external_id: ['transactionid', 'transactionnumber', 'txnid', 'referencenumber', 'reference', 'invoicenumber', 'authcode', 'id'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function detectMapping(headers: string[]): ColumnMapping {
  const normalized = headers.map(norm);
  const used = new Set<number>();
  const mapping = Object.fromEntries(FIELD_KEYS.map((k) => [k, null])) as ColumnMapping;
  // Exact alias hits first (in alias priority order), so "Date" never steals "Transaction Date".
  for (const key of FIELD_KEYS) {
    for (const alias of ALIASES[key]) {
      const idx = normalized.findIndex((h, i) => h === alias && !used.has(i));
      if (idx !== -1) { mapping[key] = idx; used.add(idx); break; }
    }
  }
  return mapping;
}

export function mappingIssues(m: ColumnMapping): string[] {
  const issues: string[] = [];
  if (m.timestamp == null && m.date == null) issues.push('Choose the date column.');
  if (m.card == null && m.plate == null) issues.push('Choose the card number or license plate column.');
  if (m.amount == null && !(m.gallons != null && m.unit_price != null)) issues.push('Choose the total amount column.');
  return issues;
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

export function parseNumber(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const original = raw.trim();
  if (!original) return null;
  const negative = /^\(.*\)$/.test(original) || /^-/.test(original) || /-$/.test(original);
  let s = original.replace(/[^0-9.,]/g, '');
  if (!/[0-9]/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot !== -1 && /^\d{1,3}(\.\d{3}){2,}$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function normalizeProduct(raw: string | null | undefined): FuelProduct {
  const s = (raw ?? '').toLowerCase().trim();
  if (!s) return 'other';
  if (/diesel|\bdsl\b|\bdyed\b|\bb20\b|biodiesel/.test(s)) return 'diesel';
  if (/\bdef\b|exhaust fluid/.test(s)) return 'def';
  if (/electric|\bev\b|kwh|charging/.test(s)) return 'electric';
  if (/propane|\blpg\b|\bcng\b/.test(s)) return 'propane';
  if (/unlead|\bunl\b|regular|premium|midgrade|\bmid\b|super|\be85\b|\be10\b|gasoline|\bgas\b|petrol|ethanol|\b(87|89|91|93)\b/.test(s)) return 'gasoline';
  if (/wash|\boil\b|lube|store|food|snack|drink|merch|tire|battery|wiper|repair|maint|parts|service|\bfee\b|\batm\b|cash|toll|parking|lodging|meal|coffee|grocer/.test(s)) return 'non_fuel';
  return 'other';
}

export type DateOrder = 'mdy' | 'dmy';

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** Day-first vs month-first, from the data: a first part > 12 means day-first; a second part > 12 means month-first. */
export function detectDateOrder(samples: string[]): DateOrder {
  for (const s of samples) {
    const m = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/.exec(s);
    if (!m) continue;
    if (Number(m[1]) > 12) return 'dmy';
    if (Number(m[2]) > 12) return 'mdy';
  }
  return 'mdy';
}

function parseTimePart(raw: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([ap]m)?$/i.exec(raw.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] ? Number(m[3]) : 0;
  const mer = m[4]?.toLowerCase();
  if (mer) { if (h < 1 || h > 12) return null; if (mer === 'pm' && h < 12) h += 12; if (mer === 'am' && h === 12) h = 0; }
  if (h > 23 || min > 59 || sec > 59) return null;
  return `${p2(h)}:${p2(min)}:${p2(sec)}`;
}

/** Returns "YYYY-MM-DDTHH:MM:SS" (account-local, no offset), or the value unchanged when it carries its own offset. */
export function parseDateTime(dateRaw: string, timeRaw: string | null, order: DateOrder): { value: string; hasTime: boolean } | null {
  let datePart = dateRaw.trim();
  let timePart = timeRaw?.trim() ?? '';
  if (!datePart) return null;

  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/.test(datePart)) {
    return Number.isNaN(Date.parse(datePart)) ? null : { value: datePart.replace(' ', 'T'), hasTime: true };
  }
  const combined = /^(\S+)[T\s]+(\d{1,2}:\d{2}.*)$/.exec(datePart);
  if (combined) { datePart = combined[1]; timePart = timePart || combined[2]; }

  let y: number; let mo: number; let d: number;
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(datePart);
  const other = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(datePart);
  if (iso) { y = Number(iso[1]); mo = Number(iso[2]); d = Number(iso[3]); }
  else if (other) {
    const a = Number(other[1]); const b = Number(other[2]);
    y = Number(other[3]); if (other[3].length === 2) y += 2000;
    if (order === 'mdy') { mo = a; d = b; } else { mo = b; d = a; }
  } else return null;
  if (!validYmd(y, mo, d)) return null;

  const time = timePart ? parseTimePart(timePart) : '12:00:00';
  if (!time) return null;
  return { value: `${y}-${p2(mo)}-${p2(d)}T${time}`, hasTime: Boolean(timePart) };
}

// ---------------------------------------------------------------------------
// Row normalisation
// ---------------------------------------------------------------------------

const clip = (s: string | undefined, max: number): string | null => {
  const t = (s ?? '').trim();
  return t ? t.slice(0, max) : null;
};
const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

export interface NormalizeResult {
  rows: ImportRow[];
  rejected: RowIssue[];
  dateOrder: DateOrder;
  hasTimeColumn: boolean;
}

/** `table` = data rows WITHOUT the header row. Lines are numbered as in the file (header = line 1). */
export function normalizeImportRows(table: string[][], mapping: ColumnMapping, forcedOrder?: DateOrder): NormalizeResult {
  const cell = (row: string[], key: FieldKey): string | undefined => {
    const idx = mapping[key];
    return idx == null ? undefined : row[idx];
  };
  const dateKey: FieldKey = mapping.timestamp != null ? 'timestamp' : 'date';
  const dateOrder = forcedOrder ?? detectDateOrder(table.slice(0, 200).map((r) => cell(r, dateKey) ?? ''));
  const rows: ImportRow[] = [];
  const rejected: RowIssue[] = [];
  const reject = (line: number, reason: string) => { rejected.push({ line, reason }); };

  table.forEach((r, i) => {
    const line = i + 2;
    const when = parseDateTime(cell(r, dateKey) ?? '', mapping.timestamp != null ? null : cell(r, 'time') ?? null, dateOrder);
    if (!when) return reject(line, 'Invalid or missing date/time');

    const digits = (cell(r, 'card') ?? '').replace(/\D/g, '');
    const last4 = digits.length >= 4 ? digits.slice(-4) : null;
    const plate = (cell(r, 'plate') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
    if (!last4 && !plate) return reject(line, 'Missing card number or plate');

    const gallonsRaw = parseNumber(cell(r, 'gallons'));
    const priceRaw = parseNumber(cell(r, 'unit_price'));
    let amount = parseNumber(cell(r, 'amount'));
    const gallons = gallonsRaw ?? 0;
    if (amount == null && gallons > 0 && priceRaw != null && priceRaw > 0) amount = round(gallons * priceRaw, 2);
    if (amount == null) return reject(line, 'Invalid or missing amount');
    if (amount < 0) return reject(line, 'Credit or refund row skipped');
    if (amount === 0) return reject(line, 'Zero-amount row skipped');
    if (amount > 100_000) return reject(line, 'Amount is unrealistically large');
    if (gallons < 0) return reject(line, 'Gallons cannot be negative');
    if (gallons > 1000) return reject(line, 'Gallons are unrealistically large');

    let unitPrice = priceRaw != null && priceRaw > 0 ? priceRaw : null;
    if (unitPrice == null && gallons > 0) unitPrice = round(amount / gallons, 4);

    const productCell = cell(r, 'product');
    const product: FuelProduct = mapping.product != null && (productCell ?? '').trim() !== ''
      ? normalizeProduct(productCell)
      : gallons > 0 ? 'other' : 'non_fuel';

    const odo = parseNumber(cell(r, 'odometer'));
    rows.push({
      line,
      transaction_at: when.value,
      card_last4: last4,
      plate,
      merchant: clip(cell(r, 'merchant'), 120),
      city: clip(cell(r, 'city'), 80),
      state: clip(cell(r, 'state'), 20),
      product,
      gallons: round(gallons, 3),
      unit_price: unitPrice,
      amount: round(amount, 2),
      odometer: odo != null && odo >= 0 && odo <= 2_000_000 ? odo : null,
      external_id: clip(cell(r, 'external_id'), 80),
    });
  });
  return { rows, rejected, dateOrder, hasTimeColumn: mapping.timestamp != null || mapping.time != null };
}

// ---------------------------------------------------------------------------
// Import preview
// ---------------------------------------------------------------------------

export interface ImportPreview {
  count: number;
  totalAmount: number;
  totalGallons: number;
  from: string | null;
  to: string | null;
  unknownCards: string[];
  knownCards: number;
}

export function previewImport(rows: ImportRow[], cards: Pick<FuelCard, 'card_last4'>[]): ImportPreview {
  const known = new Set(cards.map((c) => c.card_last4));
  const unknown = new Set<string>();
  let totalAmount = 0; let totalGallons = 0;
  let from: string | null = null; let to: string | null = null;
  const seen = new Set<string>();
  for (const r of rows) {
    totalAmount += r.amount; totalGallons += r.gallons;
    if (r.card_last4) { seen.add(r.card_last4); if (!known.has(r.card_last4)) unknown.add(r.card_last4); }
    if (from == null || r.transaction_at < from) from = r.transaction_at;
    if (to == null || r.transaction_at > to) to = r.transaction_at;
  }
  return {
    count: rows.length,
    totalAmount: round(totalAmount, 2),
    totalGallons: round(totalGallons, 1),
    from: from?.slice(0, 10) ?? null,
    to: to?.slice(0, 10) ?? null,
    unknownCards: [...unknown].sort(),
    knownCards: seen.size - unknown.size,
  };
}

export const IMPORT_TEMPLATE_CSV =
  'Transaction Date,Transaction Time,Card Number,Merchant,City,State,Product,Gallons,Price Per Gallon,Total Amount,Odometer,Transaction ID\n' +
  '10/08/2026,07:42,XXXXXXXXXXXX1234,Shell #4411,Austin,TX,Diesel,18.4,3.899,71.74,52310,TX-100231\n';

// ---------------------------------------------------------------------------
// Anomalies
// ---------------------------------------------------------------------------

export const ANOMALY_META: Record<AnomalyRule, { label: string; help: string }> = {
  card_inactive: { label: 'Card not active', help: 'Used a card that is suspended or cancelled.' },
  unregistered_card: { label: 'Unknown card', help: 'The card is not registered. Add it under Cards.' },
  no_vehicle: { label: 'No vehicle linked', help: 'The card has no vehicle. Link one under Cards.' },
  vehicle_unavailable: { label: 'Vehicle unavailable', help: 'Purchase on a vehicle that is in the shop or retired.' },
  over_capacity: { label: 'Over tank capacity', help: 'More fuel than the tank can hold.' },
  fuel_type_mismatch: { label: 'Wrong fuel type', help: 'Fuel does not match the vehicle’s fuel type.' },
  non_fuel_purchase: { label: 'Non-fuel purchase', help: 'Store, wash or other non-fuel item on a fuel card.' },
  double_swipe: { label: 'Repeat purchase', help: 'Another purchase on the same card moments earlier.' },
  daily_limit: { label: 'Too many purchases', help: 'More purchases in one day than your limit.' },
  price_outlier: { label: 'High price', help: 'Price per gallon well above your recent average.' },
  after_hours: { label: 'After hours', help: 'Purchase outside your business hours.' },
  odometer_regression: { label: 'Odometer went backwards', help: 'Odometer is lower than at the previous fill-up.' },
  mpg_outlier: { label: 'Unusual MPG', help: 'Miles per gallon since the last fill-up is implausible.' },
};

export const SEVERITY_RANK: Record<AnomalySeverity, number> = { critical: 0, warning: 1, info: 2 };

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

export function describeAnomaly(a: Pick<FuelAnomaly, 'rule' | 'details'>, money: (x: number) => string): string {
  const d = a.details ?? {};
  switch (a.rule) {
    case 'card_inactive': return `Card is ${s(d.card_status) || 'inactive'}.`;
    case 'unregistered_card': return `Card ${maskCard(s(d.card_last4) || null)} is not registered.`;
    case 'no_vehicle': return `Card ${maskCard(s(d.card_last4) || null)} has no vehicle linked.`;
    case 'vehicle_unavailable': return `Vehicle is ${humanize(s(d.vehicle_status) || 'unavailable').toLowerCase()}.`;
    case 'over_capacity': return `${formatGallons(n(d.gallons))} bought; limit is ${formatGallons(n(d.limit))}.`;
    case 'fuel_type_mismatch': return `${humanize(s(d.product))} bought for a ${s(d.vehicle_fuel)} vehicle.`;
    case 'non_fuel_purchase': return `Non-fuel purchase of ${money(n(d.amount) ?? 0)}.`;
    case 'double_swipe': return `Another purchase on this card within ${n(d.minutes) ?? '?'} minutes.`;
    case 'daily_limit': return `Purchase ${n(d.count) ?? '?'} of the day; limit is ${n(d.limit) ?? '?'}.`;
    case 'price_outlier': return `${money(n(d.unit_price) ?? 0)}/gal vs ${money(n(d.median) ?? 0)}/gal recent median.`;
    case 'after_hours': return `Bought at ${String(n(d.hour) ?? 0).padStart(2, '0')}:00, outside business hours.`;
    case 'odometer_regression': return `Odometer ${n(d.odometer)?.toLocaleString() ?? '?'} mi is below ${n(d.previous)?.toLocaleString() ?? '?'} mi last time.`;
    case 'mpg_outlier': return `${n(d.mpg) ?? '?'} MPG over ${n(d.miles)?.toLocaleString() ?? '?'} mi since the last fill-up.`;
    default: return '';
  }
}

export function sortAnomalies(list: FuelAnomaly[]): FuelAnomaly[] {
  return [...list].sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || (b.transaction?.transaction_at ?? '').localeCompare(a.transaction?.transaction_at ?? ''));
}

export function summarizeAnomalies(list: FuelAnomaly[]) {
  const open = list.filter((a) => a.status === 'open');
  return {
    open: open.length,
    critical: open.filter((a) => a.severity === 'critical').length,
    warning: open.filter((a) => a.severity === 'warning').length,
    confirmed: list.filter((a) => a.status === 'confirmed').length,
  };
}

export function summarizeTransactions(list: FuelTransaction[]) {
  const spend = list.reduce((t, x) => t + x.amount, 0);
  const gallons = list.reduce((t, x) => t + x.gallons, 0);
  const matched = list.filter((x) => x.vehicle_id).length;
  return {
    count: list.length,
    spend: round(spend, 2),
    gallons: round(gallons, 1),
    avgPrice: gallons > 0 ? round(spend / gallons, 3) : null,
    matchRate: list.length ? Math.round((matched / list.length) * 100) : null,
  };
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export interface CardFormValues {
  label: string; provider: string; last4: string; vehicle_id: string; technician_id: string;
  status: CardStatus; tank_capacity: string; notes: string;
}
export interface CardPayload {
  label: string; provider: string; last4: string; vehicle_id: string | null; technician_id: string | null;
  status: CardStatus; tank_capacity: number | null; notes: string | null;
}

export const EMPTY_CARD_FORM: CardFormValues = {
  label: '', provider: '', last4: '', vehicle_id: '', technician_id: '', status: 'active', tank_capacity: '', notes: '',
};

export function parseCardForm(f: CardFormValues): ParseResult<CardPayload> {
  const errors: FieldErrors = {};
  const label = f.label.trim();
  if (!label) errors.label = 'Give the card a name, e.g. "Truck 1 fuel card".';
  else if (label.length > 80) errors.label = 'Name must be 80 characters or fewer.';
  const last4 = f.last4.trim();
  if (!/^\d{4}$/.test(last4)) errors.last4 = 'Enter exactly the last 4 digits.';
  const provider = f.provider.trim() || 'other';
  if (provider.length > 40) errors.provider = 'Provider must be 40 characters or fewer.';
  let tank: number | null = null;
  if (f.tank_capacity.trim() !== '') {
    tank = Number(f.tank_capacity);
    if (!Number.isFinite(tank) || tank <= 0 || tank > 500) errors.tank_capacity = 'Enter a capacity between 1 and 500 gallons.';
  }
  if (f.notes.length > 500) errors.notes = 'Notes must be 500 characters or fewer.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      label, provider, last4, vehicle_id: f.vehicle_id || null, technician_id: f.technician_id || null,
      status: f.status, tank_capacity: tank, notes: f.notes.trim() || null,
    },
  };
}

export type SettingsFormValues = Record<
  'max_gallons' | 'max_txns' | 'swipe_minutes' | 'price_pct' | 'hours_start' | 'hours_end' | 'mpg_min' | 'mpg_max' | 'timezone', string
> & { post_to_expenses: boolean };

export const DEFAULT_SETTINGS: FuelSettings = {
  max_gallons_per_txn: 40, max_txns_per_day: 3, double_swipe_minutes: 120, price_tolerance_pct: 25,
  business_hours_start: 5, business_hours_end: 22, mpg_min: 4, mpg_max: 45, post_to_expenses: true, timezone: 'UTC',
};

export const settingsToForm = (s0: FuelSettings): SettingsFormValues => ({
  max_gallons: String(s0.max_gallons_per_txn), max_txns: String(s0.max_txns_per_day),
  swipe_minutes: String(s0.double_swipe_minutes), price_pct: String(s0.price_tolerance_pct),
  hours_start: String(s0.business_hours_start), hours_end: String(s0.business_hours_end),
  mpg_min: String(s0.mpg_min), mpg_max: String(s0.mpg_max), timezone: s0.timezone, post_to_expenses: s0.post_to_expenses,
});

export function parseSettingsForm(f: SettingsFormValues): ParseResult<FuelSettings> {
  const errors: FieldErrors = {};
  const num = (raw: string, key: string, label: string, min: number, max: number, integer = false): number => {
    const v = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
      errors[key] = `${label} must be ${integer ? 'a whole number ' : ''}between ${min} and ${max}.`;
      return min;
    }
    return v;
  };
  const value: FuelSettings = {
    max_gallons_per_txn: num(f.max_gallons, 'max_gallons', 'Max gallons', 1, 500),
    max_txns_per_day: num(f.max_txns, 'max_txns', 'Purchases per day', 1, 20, true),
    double_swipe_minutes: num(f.swipe_minutes, 'swipe_minutes', 'Repeat window', 5, 1440, true),
    price_tolerance_pct: num(f.price_pct, 'price_pct', 'Price tolerance', 5, 200),
    business_hours_start: num(f.hours_start, 'hours_start', 'Opening hour', 0, 23, true),
    business_hours_end: num(f.hours_end, 'hours_end', 'Closing hour', 1, 24, true),
    mpg_min: num(f.mpg_min, 'mpg_min', 'Minimum MPG', 0.5, 100),
    mpg_max: num(f.mpg_max, 'mpg_max', 'Maximum MPG', 1, 200),
    post_to_expenses: f.post_to_expenses,
    timezone: f.timezone.trim(),
  };
  if (!errors.hours_end && !errors.hours_start && value.business_hours_start >= value.business_hours_end) errors.hours_end = 'Closing hour must be after the opening hour.';
  if (!errors.mpg_max && !errors.mpg_min && value.mpg_min >= value.mpg_max) errors.mpg_max = 'Maximum MPG must be above the minimum.';
  if (!value.timezone) errors.timezone = 'Enter a time zone, e.g. America/Chicago.';
  else {
    try { new Intl.DateTimeFormat('en-US', { timeZone: value.timezone }); } catch { errors.timezone = 'That time zone is not recognised.'; }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}
