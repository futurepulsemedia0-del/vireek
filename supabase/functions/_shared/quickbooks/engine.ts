// supabase/functions/_shared/quickbooks/engine.ts
//
// Vireek <-> QuickBooks Online sync engine: pure and deterministic. NO network, NO database,
// NO Deno/DOM APIs (only WebCrypto, which exists in Deno, browsers and Node 20+). It is imported
// by the edge functions, by the React client (settings catalog for the mapping UI) and by the
// unit tests, so it never touches anything outside this file except the CRM engine's generic
// helpers (three-way merge, value normalisation, AES-GCM token encryption).
//
//   OAuth      : signed state, authorize / token / refresh request shapes, host allow-lists
//   Settings   : per-entity enable / direction / conflict rule / per-field direction + defaults
//   Adapters   : QuickBooks record <-> canonical values, invoice + payment parsing and payloads
//   Requests   : query / write / void request builders and fault classification
//   Merge      : field-level THREE-WAY merge (shared with CRM Sync) with explicit conflict rules
//
// Integrity rules:
//   1. Nothing from the client ever becomes a table, column, URL path or query fragment. Every
//      interpolated value is either a fixed constant, validated against a strict pattern, or
//      escaped with `qboLiteral`.
//   2. Bearer tokens and the client secret are only sent to the allow-listed Intuit hosts.
//   3. Money is integer cents on the Vireek side and is converted at the edge only.
//   4. A conflict exists only when BOTH sides changed the same field since the last sync.
//   5. Anything that cannot be represented faithfully (discounts, bundles, multi-currency) is
//      reported as "unsupported" with a reason, never guessed.

import {
  b64url,
  b64urlDecode,
  coerceValue,
  decryptSecret,
  encryptSecret,
  normalizeValue,
  threeWayMerge,
  type Canon,
  type CanonValue,
  type MergeField,
  type MergeResult,
  type VireekFieldType,
} from '../crm/engine.ts';

export { decryptSecret, encryptSecret, normalizeValue, coerceValue };
export type { Canon, CanonValue, MergeResult };

// ============================================================
// TYPES + META
// ============================================================

export const QBO_ENTITIES = ['account', 'customer', 'item', 'invoice', 'payment'] as const;
export type QboEntity = (typeof QBO_ENTITIES)[number];
export type QboEnvironment = 'production' | 'sandbox';
export type QboDirection = 'both' | 'to_qbo' | 'from_qbo';
export type FieldDirection = QboDirection | 'off';
export type QboConflictRule = 'newest_wins' | 'vireek_wins' | 'qbo_wins' | 'manual';

export const QBO_DIRECTIONS: QboDirection[] = ['both', 'to_qbo', 'from_qbo'];
export const QBO_CONFLICT_RULES: QboConflictRule[] = ['newest_wins', 'vireek_wins', 'qbo_wins', 'manual'];

export const ENTITY_META: Record<
  QboEntity,
  { label: string; vireekLabel: string; qboLabel: string; table: string; qboObject: string; hasActive: boolean; hint: string }
> = {
  account: { label: 'Accounts', vireekLabel: 'Chart of accounts', qboLabel: 'Chart of accounts', table: 'chart_of_accounts', qboObject: 'Account', hasActive: true, hint: 'Your chart of accounts. QuickBooks is normally the source of truth.' },
  customer: { label: 'Customers', vireekLabel: 'Customers', qboLabel: 'Customers', table: 'customers', qboObject: 'Customer', hasActive: true, hint: 'Names, email, phone, billing address and notes.' },
  item: { label: 'Items', vireekLabel: 'Price book', qboLabel: 'Products & services', table: 'price_book_items', qboObject: 'Item', hasActive: true, hint: 'Services and their prices (service and non-inventory items).' },
  invoice: { label: 'Invoices', vireekLabel: 'AR invoices', qboLabel: 'Invoices', table: 'ar_invoices', qboObject: 'Invoice', hasActive: false, hint: 'Invoices, line items, tax, due dates and voids.' },
  payment: { label: 'Payments', vireekLabel: 'AR payments', qboLabel: 'Payments', table: 'ar_payments', qboObject: 'Payment', hasActive: false, hint: 'Customer payments applied to invoices. Payments are never edited, only created.' },
};

export const DIRECTION_META: Record<QboDirection, { label: string }> = {
  both: { label: 'Two-way' },
  to_qbo: { label: 'Vireek → QuickBooks' },
  from_qbo: { label: 'QuickBooks → Vireek' },
};

export const CONFLICT_RULE_META: Record<QboConflictRule, { label: string; hint: string }> = {
  newest_wins: { label: 'Newest change wins', hint: 'When both sides edited the same field, keep the most recent edit.' },
  vireek_wins: { label: 'Vireek wins', hint: 'Vireek is the source of truth for conflicting fields.' },
  qbo_wins: { label: 'QuickBooks wins', hint: 'QuickBooks is the source of truth for conflicting fields.' },
  manual: { label: 'Review manually', hint: 'Leave both values untouched and ask me to choose.' },
};

export interface VireekField {
  key: string;
  label: string;
  type: VireekFieldType;
  required?: boolean;
}

export const VIREEK_FIELDS: Record<QboEntity, VireekField[]> = {
  account: [
    { key: 'code', label: 'Account number', type: 'text', required: true },
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'active', label: 'Active / inactive', type: 'text' },
  ],
  customer: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'phone', label: 'Phone', type: 'phone' },
    { key: 'address', label: 'Billing address', type: 'text' },
    { key: 'notes', label: 'Notes', type: 'text' },
  ],
  item: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'description', label: 'Description', type: 'text' },
    { key: 'price', label: 'Price', type: 'number' },
    { key: 'active', label: 'Active / inactive', type: 'text' },
  ],
  invoice: [
    { key: 'due_date', label: 'Due date', type: 'date' },
    { key: 'amounts', label: 'Line items, tax and total', type: 'text' },
    { key: 'voided', label: 'Void status', type: 'text' },
  ],
  payment: [],
};

export const QBO_QUERY_PAGE = 100;
export const PULL_OVERLAP_MS = 2 * 60 * 1000;
export const PAGE_CAP_PER_RUN = 1500;
export const QBO_MINOR_VERSION = 75;

// ============================================================
// SETTINGS
// ============================================================

export interface EntitySettings {
  enabled: boolean;
  direction: QboDirection;
  conflict: QboConflictRule;
  fields: Record<string, FieldDirection>;
}
export interface QboDefaults {
  /** QuickBooks account id used as the income account for items Vireek creates. */
  incomeAccountId: string | null;
  /** QuickBooks account id payments are deposited to when the Vireek account is not linked. */
  depositAccountId: string | null;
  /** QuickBooks item id used for invoice lines that match no synced item. */
  fallbackItemId: string | null;
  /** QuickBooks tax code applied to taxable lines (e.g. "TAX"). Optional. */
  taxCodeId: string | null;
  /** Send the Vireek invoice number as the QuickBooks DocNumber. */
  sendDocNumber: boolean;
  /** Who an invoice is billed to in QuickBooks. Used by the reconciliation audit only; it never changes what sync sends. */
  billToRule: BillToRule;
}
export const BILL_TO_RULES = ['invoice_customer', 'owner', 'tenant'] as const;
export type BillToRule = (typeof BILL_TO_RULES)[number];
export interface QboSettings {
  version: 1;
  entities: Record<QboEntity, EntitySettings>;
  defaults: QboDefaults;
}

const allFields = (entity: QboEntity): Record<string, FieldDirection> =>
  Object.fromEntries(VIREEK_FIELDS[entity].map((f) => [f.key, 'both' as FieldDirection]));

export function defaultSettings(): QboSettings {
  const mk = (direction: QboDirection, conflict: QboConflictRule, entity: QboEntity): EntitySettings => ({
    enabled: true,
    direction,
    conflict,
    fields: allFields(entity),
  });
  return {
    version: 1,
    entities: {
      // QuickBooks owns the chart of accounts; Vireek only reads it by default.
      account: mk('from_qbo', 'qbo_wins', 'account'),
      customer: mk('both', 'newest_wins', 'customer'),
      item: mk('both', 'newest_wins', 'item'),
      // Money documents never auto-resolve a disagreement.
      invoice: mk('both', 'manual', 'invoice'),
      payment: mk('both', 'manual', 'payment'),
    },
    defaults: { incomeAccountId: null, depositAccountId: null, fallbackItemId: null, taxCodeId: null, sendDocNumber: true, billToRule: 'invoice_customer' },
  };
}

export const QBO_ID = /^[A-Za-z0-9_-]{1,40}$/;

export type SettingsResult = { ok: true; settings: QboSettings } | { ok: false; error: string };

export function validateSettings(input: unknown): SettingsResult {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Settings must be an object.' };
  const src = input as Record<string, unknown>;
  const base = defaultSettings();
  const out: QboSettings = { version: 1, entities: {} as QboSettings['entities'], defaults: { ...base.defaults } };

  const srcEntities = (src.entities ?? {}) as Record<string, unknown>;
  if (typeof srcEntities !== 'object') return { ok: false, error: 'entities must be an object.' };
  for (const entity of QBO_ENTITIES) {
    const raw = srcEntities[entity] as Record<string, unknown> | undefined;
    const d = base.entities[entity];
    if (raw === undefined) {
      out.entities[entity] = d;
      continue;
    }
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: `${ENTITY_META[entity].label}: invalid settings.` };
    const enabled = raw.enabled === undefined ? d.enabled : raw.enabled;
    const direction = raw.direction === undefined ? d.direction : raw.direction;
    const conflict = raw.conflict === undefined ? d.conflict : raw.conflict;
    if (typeof enabled !== 'boolean') return { ok: false, error: `${ENTITY_META[entity].label}: "enabled" must be true or false.` };
    if (!QBO_DIRECTIONS.includes(direction as QboDirection)) return { ok: false, error: `${ENTITY_META[entity].label}: unknown sync direction.` };
    if (!QBO_CONFLICT_RULES.includes(conflict as QboConflictRule)) return { ok: false, error: `${ENTITY_META[entity].label}: unknown conflict rule.` };
    const fields: Record<string, FieldDirection> = { ...d.fields };
    const rawFields = (raw.fields ?? {}) as Record<string, unknown>;
    if (typeof rawFields !== 'object' || rawFields === null) return { ok: false, error: `${ENTITY_META[entity].label}: invalid fields.` };
    for (const [key, dir] of Object.entries(rawFields)) {
      if (!VIREEK_FIELDS[entity].some((f) => f.key === key)) return { ok: false, error: `${ENTITY_META[entity].label}: unknown field "${key}".` };
      if (dir !== 'off' && !QBO_DIRECTIONS.includes(dir as QboDirection)) return { ok: false, error: `${ENTITY_META[entity].label}: invalid direction for "${key}".` };
      fields[key] = dir as FieldDirection;
    }
    // A required field can never be switched off: a record without it would be invalid.
    for (const f of VIREEK_FIELDS[entity]) {
      if (f.required && fields[f.key] === 'off') return { ok: false, error: `${ENTITY_META[entity].label}: "${f.label}" is required and cannot be turned off.` };
    }
    out.entities[entity] = { enabled, direction: direction as QboDirection, conflict: conflict as QboConflictRule, fields };
  }

  const dflt = (src.defaults ?? {}) as Record<string, unknown>;
  if (typeof dflt !== 'object' || dflt === null) return { ok: false, error: 'defaults must be an object.' };
  for (const key of ['incomeAccountId', 'depositAccountId', 'fallbackItemId', 'taxCodeId'] as const) {
    const v = dflt[key];
    if (v === undefined) continue;
    if (v === null || v === '') out.defaults[key] = null;
    else if (typeof v === 'string' && QBO_ID.test(v)) out.defaults[key] = v;
    else return { ok: false, error: `Invalid value for ${key}.` };
  }
  if (dflt.sendDocNumber !== undefined) {
    if (typeof dflt.sendDocNumber !== 'boolean') return { ok: false, error: 'sendDocNumber must be true or false.' };
    out.defaults.sendDocNumber = dflt.sendDocNumber;
  }
if (dflt.billToRule !== undefined) {
  if (!BILL_TO_RULES.includes(dflt.billToRule as BillToRule)) return { ok: false, error: 'billToRule must be invoice_customer, owner or tenant.' };
  out.defaults.billToRule = dflt.billToRule as BillToRule;
}
  return { ok: true, settings: out };
}

/** The direction a field really syncs in, after the entity-level direction is applied. */
export function effectiveDirection(entityDir: QboDirection, fieldDir: FieldDirection): FieldDirection {
  if (fieldDir === 'off') return 'off';
  if (entityDir === 'both') return fieldDir;
  if (fieldDir === 'both') return entityDir;
  return fieldDir === entityDir ? fieldDir : 'off';
}
export const canCreateInQbo = (es: EntitySettings) => es.enabled && es.direction !== 'from_qbo';
export const canCreateInVireek = (es: EntitySettings) => es.enabled && es.direction !== 'to_qbo';

// ============================================================
// MERGE (thin wrapper over the shared three-way merge)
// ============================================================

const toCrmDir = (d: FieldDirection): 'both' | 'to_crm' | 'from_crm' => (d === 'to_qbo' ? 'to_crm' : d === 'from_qbo' ? 'from_crm' : 'both');

export function mergeFieldsFor(entity: QboEntity, es: EntitySettings): MergeField[] {
  const out: MergeField[] = [];
  for (const f of VIREEK_FIELDS[entity]) {
    const dir = effectiveDirection(es.direction, es.fields[f.key] ?? 'both');
    if (dir === 'off') continue;
    out.push({ key: f.key, type: f.type, direction: toCrmDir(dir), required: f.required });
  }
  return out;
}

export function mergeEntity(input: {
  entity: QboEntity;
  settings: EntitySettings;
  base: Canon | null;
  vireek: Canon;
  qbo: Canon;
  vireekTs: number | null;
  qboTs: number | null;
  ruleOverride?: 'vireek_wins' | 'qbo_wins';
}): MergeResult {
  const rule = input.ruleOverride ?? input.settings.conflict;
  return threeWayMerge({
    fields: mergeFieldsFor(input.entity, input.settings),
    base: input.base,
    vireek: input.vireek,
    crm: input.qbo,
    rule: rule === 'qbo_wins' ? 'crm_wins' : rule,
    vireekTs: input.vireekTs,
    crmTs: input.qboTs,
  });
}

// ============================================================
// SMALL HELPERS
// ============================================================

export type RawRecord = Record<string, unknown>;

export const toCents = (dollars: unknown): number => {
  const n = typeof dollars === 'number' ? dollars : Number(dollars);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
export const fromCents = (cents: number): number => Math.round(cents) / 100;

export function parseTimestamp(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const obj = (v: unknown): RawRecord => (v && typeof v === 'object' ? (v as RawRecord) : {});
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** QuickBooks string literal for the query language (backslash-escapes quote and backslash). */
export function qboLiteral(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** QuickBooks forbids ":" in item / account names (it means "sub-item") and caps them at 100 chars. */
export const qboName = (s: string): string => s.replace(/:/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100);

export const qboTimestamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');

export function recordMeta(raw: RawRecord): { id: string; syncToken: string; modifiedAt: number | null } {
  const meta = obj(raw.MetaData);
  return { id: String(raw.Id ?? ''), syncToken: String(raw.SyncToken ?? '0'), modifiedAt: parseTimestamp(meta.LastUpdatedTime) };
}

// ============================================================
// ACCOUNTS
// ============================================================

export type VireekAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export const normalBalanceFor = (t: VireekAccountType): 'debit' | 'credit' => (t === 'asset' || t === 'expense' ? 'debit' : 'credit');

export function accountTypeFromClassification(classification: unknown): VireekAccountType | null {
  switch (String(classification ?? '').toLowerCase()) {
    case 'asset': return 'asset';
    case 'liability': return 'liability';
    case 'equity': return 'equity';
    case 'revenue': return 'revenue';
    case 'expense': return 'expense';
    default: return null;
  }
}

/** QuickBooks AccountType to create for a Vireek account. Used only when Vireek creates the account. */
export function suggestQboAccountType(type: VireekAccountType, code: string | null): string {
  const c = code ?? '';
  switch (type) {
    case 'asset': return c === '1000' ? 'Bank' : c === '1100' ? 'Accounts Receivable' : c === '1500' ? 'Fixed Asset' : 'Other Current Asset';
    case 'liability': return c === '2000' ? 'Accounts Payable' : c === '2200' ? 'Credit Card' : 'Other Current Liability';
    case 'equity': return 'Equity';
    case 'revenue': return c === '4900' ? 'Other Income' : 'Income';
    case 'expense': return c.startsWith('5') ? 'Cost of Goods Sold' : 'Expense';
  }
}

/** Vireek chart_of_accounts.code for an account that has no number in QuickBooks. */
export const generatedAccountCode = (qboId: string): string => `QB${qboId}`.slice(0, 20);

// ============================================================
// QBO RECORD <-> CANONICAL (simple entities)
// ============================================================

export function composeAddress(a: unknown): string | null {
  const x = obj(a);
  const parts = [str(x.Line1), str(x.Line2), str(x.City), [str(x.CountrySubDivisionCode), str(x.PostalCode)].filter(Boolean).join(' ') || null].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export function qboToCanon(entity: 'account' | 'customer' | 'item', raw: RawRecord): Canon {
  switch (entity) {
    case 'customer':
      return {
        name: str(raw.DisplayName) ?? str(raw.FullyQualifiedName),
        email: str(obj(raw.PrimaryEmailAddr).Address),
        phone: str(obj(raw.PrimaryPhone).FreeFormNumber) ?? str(obj(raw.Mobile).FreeFormNumber),
        address: composeAddress(raw.BillAddr),
        notes: str(raw.Notes),
      };
    case 'item':
      return {
        name: str(raw.Name),
        description: str(raw.Description),
        price: num(raw.UnitPrice),
        active: raw.Active === false ? 'inactive' : 'active',
      };
    case 'account':
      return {
        code: str(raw.AcctNum),
        name: str(raw.Name),
        active: raw.Active === false ? 'inactive' : 'active',
      };
  }
}

export interface PayloadCtx {
  defaults: QboDefaults;
  /** Only for accounts being created in QuickBooks. */
  accountType?: string | null;
}

/** Fields (in `values`) to write to QuickBooks. For creates pass every mapped field. */
export function canonToQbo(entity: 'account' | 'customer' | 'item', values: Canon, ctx: PayloadCtx, create: boolean): RawRecord {
  const p: RawRecord = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(values, k);
  switch (entity) {
    case 'customer':
      if (has('name') && values.name) p.DisplayName = String(values.name).slice(0, 500);
      if (has('email')) p.PrimaryEmailAddr = { Address: values.email ? String(values.email) : '' };
      if (has('phone')) p.PrimaryPhone = { FreeFormNumber: values.phone ? String(values.phone) : '' };
      if (has('address') && values.address) p.BillAddr = { Line1: String(values.address).slice(0, 500) };
      if (has('notes')) p.Notes = values.notes ? String(values.notes).slice(0, 2000) : '';
      return p;
    case 'item':
      if (has('name') && values.name) p.Name = qboName(String(values.name));
      if (has('description')) p.Description = values.description ? String(values.description).slice(0, 4000) : '';
      if (has('price') && values.price !== null) p.UnitPrice = Number(values.price);
      if (has('active')) p.Active = values.active !== 'inactive';
      if (create) {
        p.Type = 'Service';
        if (ctx.defaults.incomeAccountId) p.IncomeAccountRef = { value: ctx.defaults.incomeAccountId };
      }
      return p;
    case 'account':
      if (has('name') && values.name) p.Name = qboName(String(values.name));
      if (has('code') && values.code) p.AcctNum = String(values.code).slice(0, 20);
      if (has('active')) p.Active = values.active !== 'inactive';
      if (create && ctx.accountType) p.AccountType = ctx.accountType;
      return p;
  }
}

/** Item Type values Vireek can represent as a price book entry. */
export const isSyncableItem = (raw: RawRecord): boolean => raw.Type === 'Service' || raw.Type === 'NonInventory';
/** Income account of a pulled item, remembered so inbound invoice lines get the right revenue account. */
export const itemIncomeRef = (raw: RawRecord): string | null => str(obj(raw.IncomeAccountRef).value);

// ============================================================
// INVOICES
// ============================================================

export interface InvoiceLine {
  description: string;
  qty: number;
  unitPriceCents: number;
  amountCents: number;
  itemId: string | null;
}
export interface QboInvoiceDoc {
  id: string;
  syncToken: string;
  docNumber: string | null;
  customerId: string | null;
  txnDate: string | null;
  dueDate: string | null;
  lines: InvoiceLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  balanceCents: number;
  voided: boolean;
  modifiedAt: number | null;
}
export type InvoiceParse = { ok: true; doc: QboInvoiceDoc } | { ok: false; reason: string };

const isVoidNote = (raw: RawRecord) => /^voided/i.test(String(raw.PrivateNote ?? '').trim());
const dateOnly = (v: unknown): string | null => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? ''));
  return m ? m[1] : null;
};

export function parseQboInvoice(raw: RawRecord): InvoiceParse {
  const m = recordMeta(raw);
  if (!m.id) return { ok: false, reason: 'Invoice has no id.' };
  if (raw.CurrencyRef && obj(raw.CurrencyRef).value && String(obj(raw.CurrencyRef).value) !== 'USD' && raw.CurrencyRef) {
    // Multi-currency is not representable in Vireek's single-currency ledger.
    return { ok: false, reason: `Currency ${String(obj(raw.CurrencyRef).value)} is not supported (Vireek ledgers are single-currency).` };
  }
  const base = {
    id: m.id,
    syncToken: m.syncToken,
    docNumber: str(raw.DocNumber),
    customerId: str(obj(raw.CustomerRef).value),
    txnDate: dateOnly(raw.TxnDate),
    dueDate: dateOnly(raw.DueDate),
    modifiedAt: m.modifiedAt,
  };
  const voided = isVoidNote(raw);
  const lines: InvoiceLine[] = [];
  for (const l of Array.isArray(raw.Line) ? (raw.Line as RawRecord[]) : []) {
    const type = String(l.DetailType ?? '');
    if (type === 'SubTotalLineDetail' || type === 'DescriptionOnly') continue;
    if (type !== 'SalesItemLineDetail') {
      if (voided) continue;
      return { ok: false, reason: `Line type "${type || 'unknown'}" (discounts, bundles) is not supported.` };
    }
    const d = obj(l.SalesItemLineDetail);
    const amountCents = toCents(l.Amount);
    const qty = num(d.Qty) ?? 1;
    const unitPriceCents = d.UnitPrice !== undefined && num(d.UnitPrice) !== null ? toCents(d.UnitPrice) : qty ? Math.round(amountCents / qty) : amountCents;
    lines.push({
      description: (str(l.Description) ?? str(obj(d.ItemRef).name) ?? 'Item').slice(0, 1000),
      qty,
      unitPriceCents,
      amountCents,
      itemId: str(obj(d.ItemRef).value),
    });
  }
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const taxCents = toCents(obj(raw.TxnTaxDetail).TotalTax ?? 0);
  const totalCents = toCents(raw.TotalAmt);
  if (voided) return { ok: true, doc: { ...base, lines: [], subtotalCents: 0, taxCents: 0, totalCents: 0, balanceCents: 0, voided: true } };
  if (lines.length === 0) return { ok: false, reason: 'Invoice has no sales lines.' };
  if (lines.some((l) => l.amountCents < 0)) return { ok: false, reason: 'Negative lines (discounts) are not supported.' };
  if (subtotalCents + taxCents !== totalCents) return { ok: false, reason: 'Totals do not add up (header discount, rounding or tax setup on the QuickBooks side).' };
  return { ok: true, doc: { ...base, lines, subtotalCents, taxCents, totalCents, balanceCents: toCents(raw.Balance ?? 0), voided: false } };
}

const normText = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Canonical signature of an invoice's money. Equal signatures mean "same itemisation and total". */
export function invoiceAmountSig(i: { lines: Pick<InvoiceLine, 'description' | 'qty' | 'amountCents'>[]; taxCents: number; totalCents: number }): string {
  const lines = i.lines.map((l) => `${normText(l.description)}~${Math.round(l.qty * 10000) / 10000}~${l.amountCents}`).join(';');
  return `${i.totalCents}|${i.taxCents}|${lines}`;
}

export interface VireekInvoiceInput {
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  taxCents: number;
  lines: InvoiceLine[];
}

/** Resolve an invoice line's QuickBooks item: exact name match against synced items, else the fallback. */
export function resolveLineItems(
  lines: InvoiceLine[],
  itemByName: Map<string, string>,
  fallbackItemId: string | null,
): { ok: true; lines: InvoiceLine[] } | { ok: false; reason: string } {
  const out: InvoiceLine[] = [];
  for (const l of lines) {
    const id = itemByName.get(normText(l.description)) ?? fallbackItemId;
    if (!id) return { ok: false, reason: 'No QuickBooks item for the line "' + l.description.slice(0, 60) + '". Choose a fallback item under Mapping → Defaults.' };
    out.push({ ...l, itemId: id });
  }
  return { ok: true, lines: out };
}

export function buildQboInvoicePayload(
  inv: VireekInvoiceInput,
  customerId: string,
  ctx: { defaults: QboDefaults },
  existing?: { id: string; syncToken: string },
): RawRecord {
  const p: RawRecord = {
    CustomerRef: { value: customerId },
    TxnDate: inv.issueDate,
    DueDate: inv.dueDate,
    Line: inv.lines.map((l) => {
      const exact = Math.abs(l.qty * l.unitPriceCents - l.amountCents) < 0.5;
      return {
        DetailType: 'SalesItemLineDetail',
        Amount: fromCents(l.amountCents),
        Description: l.description,
        SalesItemLineDetail: {
          ItemRef: { value: l.itemId },
          Qty: exact ? l.qty : 1,
          UnitPrice: exact ? fromCents(l.unitPriceCents) : fromCents(l.amountCents),
          ...(inv.taxCents > 0 && ctx.defaults.taxCodeId ? { TaxCodeRef: { value: ctx.defaults.taxCodeId } } : {}),
        },
      };
    }),
  };
  if (inv.taxCents > 0) p.TxnTaxDetail = { TotalTax: fromCents(inv.taxCents) };
  if (ctx.defaults.sendDocNumber && !existing) p.DocNumber = inv.invoiceNumber.slice(0, 21);
  if (existing) {
    p.Id = existing.id;
    p.SyncToken = existing.syncToken;
    p.sparse = true;
  }
  return p;
}

// ============================================================
// PAYMENTS
// ============================================================

export interface QboPaymentDoc {
  id: string;
  customerId: string | null;
  totalCents: number;
  txnDate: string | null;
  depositAccountId: string | null;
  methodName: string | null;
  applications: { invoiceId: string; amountCents: number }[];
  voided: boolean;
  modifiedAt: number | null;
}

export function parseQboPayment(raw: RawRecord): QboPaymentDoc | null {
  const m = recordMeta(raw);
  if (!m.id) return null;
  const apps: { invoiceId: string; amountCents: number }[] = [];
  for (const l of Array.isArray(raw.Line) ? (raw.Line as RawRecord[]) : []) {
    const linked = Array.isArray(l.LinkedTxn) ? (l.LinkedTxn as RawRecord[]) : [];
    const inv = linked.find((t) => t.TxnType === 'Invoice');
    if (!inv || !str(inv.TxnId)) continue;
    const amountCents = toCents(l.Amount);
    if (amountCents > 0) apps.push({ invoiceId: String(inv.TxnId), amountCents });
  }
  return {
    id: m.id,
    customerId: str(obj(raw.CustomerRef).value),
    totalCents: toCents(raw.TotalAmt),
    txnDate: dateOnly(raw.TxnDate),
    depositAccountId: str(obj(raw.DepositToAccountRef).value),
    methodName: str(obj(raw.PaymentMethodRef).name),
    applications: apps,
    voided: isVoidNote(raw),
    modifiedAt: m.modifiedAt,
  };
}

export type VireekPaymentMethod = 'card' | 'ach' | 'check' | 'cash' | 'other';
export function paymentMethodFromName(name: string | null): VireekPaymentMethod {
  const n = (name ?? '').toLowerCase();
  if (!n) return 'other';
  if (/check|cheque/.test(n)) return 'check';
  if (/cash/.test(n)) return 'cash';
  if (/ach|bank|echeck|e-check|transfer/.test(n)) return 'ach';
  if (/visa|master|amex|american express|discover|card|credit|debit/.test(n)) return 'card';
  return 'other';
}

export function buildQboPaymentPayload(input: {
  customerId: string;
  invoiceId: string;
  amountCents: number;
  date: string;
  depositAccountId: string | null;
  note: string;
}): RawRecord {
  return {
    CustomerRef: { value: input.customerId },
    TotalAmt: fromCents(input.amountCents),
    TxnDate: input.date,
    PrivateNote: input.note.slice(0, 4000),
    ...(input.depositAccountId ? { DepositToAccountRef: { value: input.depositAccountId } } : {}),
    Line: [{ Amount: fromCents(input.amountCents), LinkedTxn: [{ TxnId: input.invoiceId, TxnType: 'Invoice' }] }],
  };
}

/** Stable key for one payment-to-invoice application (a QuickBooks payment can pay several invoices). */
export const paymentLinkKey = (paymentId: string, invoiceId: string) => `${paymentId}:${invoiceId}`;

// ============================================================
// REQUEST BUILDERS + RESPONSE PARSERS
// ============================================================

export interface HttpReq {
  method: 'GET' | 'POST';
  url: string;
  body?: unknown;
}

const API_BASES: Record<QboEnvironment, string> = {
  production: 'https://quickbooks.api.intuit.com',
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
};
export const apiBaseFor = (env: QboEnvironment): string => API_BASES[env];
export const isAllowedApiBase = (url: string): boolean => Object.values(API_BASES).includes(url.replace(/\/+$/, ''));
export const isValidRealmId = (s: unknown): s is string => typeof s === 'string' && /^\d{6,20}$/.test(s);
export const isValidQboId = (s: unknown): s is string => typeof s === 'string' && /^\d{1,20}$/.test(s);

const company = (base: string, realm: string) => `${base.replace(/\/+$/, '')}/v3/company/${realm}`;

export function buildQueryRequest(c: { base: string; realm: string; entity: QboEntity; since: string | null; pos: number; pageSize: number }): HttpReq {
  const meta = ENTITY_META[c.entity];
  const where: string[] = [];
  if (c.since) where.push(`Metadata.LastUpdatedTime >= '${c.since}'`);
  if (meta.hasActive) where.push('Active IN (true, false)');
  const q = `select * from ${meta.qboObject}${where.length ? ` where ${where.join(' and ')}` : ''} order by Metadata.LastUpdatedTime startposition ${Math.max(1, Math.floor(c.pos))} maxresults ${Math.min(1000, Math.max(1, Math.floor(c.pageSize)))}`;
  return { method: 'GET', url: `${company(c.base, c.realm)}/query?minorversion=${QBO_MINOR_VERSION}&query=${encodeURIComponent(q)}` };
}
/** Read-only audit query: every QuickBooks invoice on/after `fromDate` (YYYY-MM-DD, validated), stable order. */
export function buildInvoiceAuditQuery(c: { base: string; realm: string; fromDate: string; pos: number; pageSize: number }): HttpReq {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.fromDate)) throw new Error('Invalid audit start date.');
  const q = `select * from Invoice where TxnDate >= '${c.fromDate}' order by Id startposition ${Math.max(1, Math.floor(c.pos))} maxresults ${Math.min(1000, Math.max(1, Math.floor(c.pageSize)))}`;
  return { method: 'GET', url: `${company(c.base, c.realm)}/query?minorversion=${QBO_MINOR_VERSION}&query=${encodeURIComponent(q)}` };
}
/** Find an existing record by an exact value (used to link instead of creating a duplicate). */
export function buildFindRequest(c: { base: string; realm: string; entity: 'customer' | 'item' | 'account' | 'invoice'; field: string; value: string }): HttpReq {
  const meta = ENTITY_META[c.entity];
  const allowed = ['DisplayName', 'Name', 'AcctNum', 'DocNumber'];
  if (!allowed.includes(c.field)) throw new Error('Unsupported lookup field.');
  const active = meta.hasActive ? ' and Active IN (true, false)' : '';
  const q = `select * from ${meta.qboObject} where ${c.field} = ${qboLiteral(c.value)}${active} maxresults 5`;
  return { method: 'GET', url: `${company(c.base, c.realm)}/query?minorversion=${QBO_MINOR_VERSION}&query=${encodeURIComponent(q)}` };
}

export function buildGetRequest(c: { base: string; realm: string; entity: QboEntity; id: string }): HttpReq {
  if (!isValidQboId(c.id)) throw new Error('Invalid QuickBooks id.');
  return { method: 'GET', url: `${company(c.base, c.realm)}/${ENTITY_META[c.entity].qboObject.toLowerCase()}/${c.id}?minorversion=${QBO_MINOR_VERSION}` };
}

/** POST create (no Id) or sparse update (Id + SyncToken + sparse:true). `requestId` makes creates idempotent. */
export function buildWriteRequest(c: { base: string; realm: string; entity: QboEntity; payload: RawRecord; requestId?: string }): HttpReq {
  const rid = c.requestId && /^[A-Za-z0-9_-]{1,50}$/.test(c.requestId) ? `&requestid=${c.requestId}` : '';
  return { method: 'POST', url: `${company(c.base, c.realm)}/${ENTITY_META[c.entity].qboObject.toLowerCase()}?minorversion=${QBO_MINOR_VERSION}${rid}`, body: c.payload };
}

export function buildVoidRequest(c: { base: string; realm: string; id: string; syncToken: string }): HttpReq {
  if (!isValidQboId(c.id)) throw new Error('Invalid QuickBooks id.');
  return { method: 'POST', url: `${company(c.base, c.realm)}/invoice?operation=void&minorversion=${QBO_MINOR_VERSION}`, body: { Id: c.id, SyncToken: c.syncToken } };
}

export interface QboFault {
  code: string;
  message: string;
  detail: string;
}
export type FaultKind = 'ok' | 'stale' | 'duplicate' | 'validation' | 'auth' | 'throttle' | 'notfound' | 'error';

export function parseFault(json: unknown): QboFault | null {
  const f = obj(obj(json).Fault);
  const e = Array.isArray(f.Error) ? (f.Error as RawRecord[])[0] : undefined;
  if (!e) return null;
  return { code: String(e.code ?? ''), message: String(e.Message ?? '').slice(0, 300), detail: String(e.Detail ?? '').slice(0, 500) };
}

export function classifyResponse(status: number, json: unknown): { kind: FaultKind; fault: QboFault | null } {
  const fault = parseFault(json);
  if (status >= 200 && status < 300 && !fault) return { kind: 'ok', fault: null };
  if (status === 401 || fault?.code === '3200' || fault?.code === '120') return { kind: 'auth', fault };
  if (status === 429 || fault?.code === '429') return { kind: 'throttle', fault };
  if (fault?.code === '5010') return { kind: 'stale', fault };
  if (fault?.code === '6240') return { kind: 'duplicate', fault };
  if (status === 404 || fault?.code === '610') return { kind: 'notfound', fault };
  if (status === 400 || fault) return { kind: 'validation', fault };
  return { kind: 'error', fault };
}

export interface QueryPage {
  records: RawRecord[];
  /** True when a full page came back, so another page may exist. */
  more: boolean;
}
export function parseQueryResponse(entity: QboEntity, json: unknown, pageSize: number): QueryPage {
  const qr = obj(obj(json).QueryResponse);
  const rows = qr[ENTITY_META[entity].qboObject];
  const records = Array.isArray(rows) ? (rows as RawRecord[]) : [];
  return { records, more: records.length >= pageSize };
}

/** `{ Customer: {...} }` style envelope returned by create / update / get. */
export function parseEntityResponse(entity: QboEntity, json: unknown): RawRecord | null {
  const r = obj(obj(json)[ENTITY_META[entity].qboObject]);
  return r.Id ? r : null;
}

// ============================================================
// OAUTH (Intuit OAuth 2.0)
// ============================================================

export const QBO_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const QBO_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
export const QBO_SCOPE = 'com.intuit.quickbooks.accounting';
const STATE_TTL_MS = 10 * 60 * 1000;

export function buildAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL(QBO_AUTH_URL);
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', QBO_SCOPE);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('state', p.state);
  return u.toString();
}

export interface TokenRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}
export function buildTokenRequest(
  kind: 'code' | 'refresh',
  p: { clientId: string; clientSecret: string; redirectUri?: string; code?: string; refreshToken?: string },
): TokenRequest {
  const body = new URLSearchParams();
  if (kind === 'code') {
    body.set('grant_type', 'authorization_code');
    body.set('code', p.code ?? '');
    body.set('redirect_uri', p.redirectUri ?? '');
  } else {
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', p.refreshToken ?? '');
  }
  return {
    url: QBO_TOKEN_URL,
    headers: {
      Authorization: `Basic ${btoa(`${p.clientId}:${p.clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  };
}

export interface ParsedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
  refreshExpiresInSec: number | null;
}
export function parseTokenResponse(json: unknown): ParsedTokens {
  const j = obj(json);
  if (typeof j.access_token !== 'string' || !j.access_token) throw new Error('Token response had no access token.');
  const exp = num(j.expires_in);
  const rexp = num(j.x_refresh_token_expires_in);
  return {
    accessToken: j.access_token,
    refreshToken: typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : null,
    expiresInSec: exp && exp > 0 ? exp : null,
    refreshExpiresInSec: rexp && rexp > 0 ? rexp : null,
  };
}

export interface OAuthState {
  /** account owner id */
  o: string;
  /** user who clicked connect */
  u: string;
  /** nonce */
  n: string;
  t: number;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

export async function signOAuthState(data: { owner: string; user: string }, secret: string, now: number = Date.now()): Promise<string> {
  const payload: OAuthState = { o: data.owner, u: data.user, n: b64url(crypto.getRandomValues(new Uint8Array(16))), t: now };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${b64url(await hmac(secret, body))}`;
}

export async function verifyOAuthState(state: string, secret: string, now: number = Date.now()): Promise<OAuthState | null> {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = b64url(await hmac(secret, body));
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as OAuthState;
    if (typeof p.o !== 'string' || typeof p.u !== 'string' || typeof p.n !== 'string') return null;
    if (!Number.isFinite(p.t) || now - p.t > STATE_TTL_MS || p.t - now > 60_000) return null;
    return p;
  } catch {
    return null;
  }
}

/** Intuit webhook signature: base64(HMAC-SHA256(verifierToken, rawBody)), compared in constant time. */
export async function verifyWebhookSignature(rawBody: string, signature: string | null, verifierToken: string): Promise<boolean> {
  if (!signature || !verifierToken) return false;
  const expected = btoa(String.fromCharCode(...(await hmac(verifierToken, rawBody))));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/** Realm ids named in an Intuit webhook payload. */
export function webhookRealms(payload: unknown): string[] {
  const n = obj(payload).eventNotifications;
  if (!Array.isArray(n)) return [];
  const ids = (n as RawRecord[]).map((e) => e.realmId).filter(isValidRealmId);
  return [...new Set(ids)];
}

// ============================================================
// STATS
// ============================================================

export interface SyncStats {
  created_vireek: number;
  updated_vireek: number;
  created_qbo: number;
  updated_qbo: number;
  skipped: number;
  conflicts: number;
  errors: number;
}
export const emptyStats = (): SyncStats => ({ created_vireek: 0, updated_vireek: 0, created_qbo: 0, updated_qbo: 0, skipped: 0, conflicts: 0, errors: 0 });

export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
export const normalizeDigits = (s: string | null | undefined): string => (s ?? '').replace(/\D/g, '');
