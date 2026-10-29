// supabase/functions/_shared/accounting/core.ts
//
// Provider-neutral core of the Vireek accounting connectors (Xero, Zoho Books, NetSuite).
// Pure and deterministic: NO network, NO database, NO Deno/DOM APIs (only WebCrypto). It is imported
// by the edge functions, by the React client (settings catalog for the mapping UI) and by the tests.
//
//   Settings : per-entity enable / direction / conflict rule / per-field direction + defaults
//   Merge    : field-level THREE-WAY merge (shared with CRM Sync and QuickBooks Sync)
//   Documents: invoice + payment canonical shapes, amount signatures, tax allocation
//   Contract : the `Adapter` / `AuthAdapter` interfaces each provider file implements
//   Security : provider-bound signed OAuth state, constant-time webhook signature check
//
// Integrity rules (same as the QuickBooks engine):
//   1. Nothing from the client ever becomes a table, column, URL path or query fragment.
//   2. Bearer tokens and client secrets are only sent to the provider's allow-listed hosts.
//   3. Money is integer cents on the Vireek side and is converted at the edge only.
//   4. A conflict exists only when BOTH sides changed the same field since the last sync.
//   5. Anything that cannot be represented faithfully (discounts, bundles, other currencies) is
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

export const ACCT_PROVIDERS = ['xero', 'zoho_books', 'netsuite'] as const;
export type AcctProvider = (typeof ACCT_PROVIDERS)[number];
export const isProvider = (v: unknown): v is AcctProvider => typeof v === 'string' && (ACCT_PROVIDERS as readonly string[]).includes(v);

export const ACCT_ENTITIES = ['account', 'customer', 'item', 'invoice', 'payment'] as const;
export type AcctEntity = (typeof ACCT_ENTITIES)[number];
export type SimpleEntity = 'account' | 'customer' | 'item';
export type AcctDirection = 'both' | 'to_ext' | 'from_ext';
export type FieldDirection = AcctDirection | 'off';
export type AcctConflictRule = 'newest_wins' | 'vireek_wins' | 'ext_wins' | 'manual';

export const ACCT_DIRECTIONS: AcctDirection[] = ['both', 'to_ext', 'from_ext'];
export const ACCT_CONFLICT_RULES: AcctConflictRule[] = ['newest_wins', 'vireek_wins', 'ext_wins', 'manual'];

export interface ProviderMeta {
  label: string;
  tagline: string;
  /** oauth = redirect flow; oauth_region = redirect flow with a data-centre picker; m2m = server-to-server (no redirect). */
  connect: 'oauth' | 'oauth_region' | 'm2m';
  /** Words the UI uses for the provider's own concepts. */
  words: { incomeAccount: string; depositAccount: string; fallbackItem: string; taxCode: string };
  /** What each default is needed for, shown under the pickers. */
  needs: { fallbackItem: boolean; subsidiary: boolean };
  regions?: { id: string; label: string }[];
}

export const PROVIDER_META: Record<AcctProvider, ProviderMeta> = {
  xero: {
    label: 'Xero',
    tagline: 'Two-way sync of contacts, accounts, items, invoices and payments with Xero.',
    connect: 'oauth',
    words: { incomeAccount: 'Sales account code for new items and invoice lines', depositAccount: 'Bank account for payments', fallbackItem: 'Fallback item', taxCode: 'Tax rate (optional)' },
    needs: { fallbackItem: false, subsidiary: false },
  },
  zoho_books: {
    label: 'Zoho Books',
    tagline: 'Two-way sync of contacts, accounts, items, invoices and payments with Zoho Books.',
    connect: 'oauth_region',
    words: { incomeAccount: 'Income account for new items', depositAccount: 'Deposit account for payments', fallbackItem: 'Fallback item', taxCode: 'Tax (optional)' },
    needs: { fallbackItem: false, subsidiary: false },
    regions: [
      { id: 'com', label: 'United States (.com)' },
      { id: 'eu', label: 'Europe (.eu)' },
      { id: 'in', label: 'India (.in)' },
      { id: 'com.au', label: 'Australia (.com.au)' },
      { id: 'jp', label: 'Japan (.jp)' },
      { id: 'ca', label: 'Canada (.ca)' },
      { id: 'sa', label: 'Saudi Arabia (.sa)' },
      { id: 'com.cn', label: 'China (.com.cn)' },
    ],
  },
  netsuite: {
    label: 'NetSuite',
    tagline: 'Two-way sync of customers, accounts, items, invoices and payments with Oracle NetSuite.',
    connect: 'm2m',
    words: { incomeAccount: 'Income account', depositAccount: 'Deposit account for payments', fallbackItem: 'Fallback item for invoice lines', taxCode: 'Tax code (optional)' },
    needs: { fallbackItem: true, subsidiary: true },
  },
};

export const ENTITY_META: Record<AcctEntity, { label: string; vireekLabel: string; table: string; hasActive: boolean; hint: string }> = {
  account: { label: 'Accounts', vireekLabel: 'Chart of accounts', table: 'chart_of_accounts', hasActive: true, hint: 'Your chart of accounts. The accounting system is normally the source of truth.' },
  customer: { label: 'Customers', vireekLabel: 'Customers', table: 'customers', hasActive: true, hint: 'Names, email, phone, billing address and notes.' },
  item: { label: 'Items', vireekLabel: 'Price book', table: 'price_book_items', hasActive: true, hint: 'Services and their prices (service and non-inventory items).' },
  invoice: { label: 'Invoices', vireekLabel: 'AR invoices', table: 'ar_invoices', hasActive: false, hint: 'Invoices, line items, tax, due dates and voids.' },
  payment: { label: 'Payments', vireekLabel: 'AR payments', table: 'ar_payments', hasActive: false, hint: 'Customer payments applied to invoices. Payments are never edited, only created.' },
};

export const DIRECTION_META: Record<AcctDirection, { label: (p: AcctProvider) => string }> = {
  both: { label: () => 'Two-way' },
  to_ext: { label: (p) => `Vireek → ${PROVIDER_META[p].label}` },
  from_ext: { label: (p) => `${PROVIDER_META[p].label} → Vireek` },
};

export const CONFLICT_RULE_META: Record<AcctConflictRule, { label: (p: AcctProvider) => string; hint: string }> = {
  newest_wins: { label: () => 'Newest change wins', hint: 'When both sides edited the same field, keep the most recent edit.' },
  vireek_wins: { label: () => 'Vireek wins', hint: 'Vireek is the source of truth for conflicting fields.' },
  ext_wins: { label: (p) => `${PROVIDER_META[p].label} wins`, hint: 'The accounting system is the source of truth for conflicting fields.' },
  manual: { label: () => 'Review manually', hint: 'Leave both values untouched and ask me to choose.' },
};

export interface VireekField {
  key: string;
  label: string;
  type: VireekFieldType;
  required?: boolean;
}

const BASE_FIELDS: Record<AcctEntity, VireekField[]> = {
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

/** Fields the provider has no place to store: hidden from the mapping UI and never merged. */
const UNSUPPORTED: Record<AcctProvider, Partial<Record<AcctEntity, string[]>>> = {
  xero: { customer: ['notes'], item: ['active'] },
  zoho_books: {},
  netsuite: { item: ['price'] },
};
/** Fields that only flow INTO Vireek (the provider API cannot be written for them safely). */
const READ_ONLY: Record<AcctProvider, Partial<Record<AcctEntity, string[]>>> = {
  xero: {},
  zoho_books: { account: ['active'], item: ['active'] },
  netsuite: { customer: ['address'], invoice: ['voided'] },
};

export function fieldsFor(provider: AcctProvider, entity: AcctEntity): VireekField[] {
  const hide = UNSUPPORTED[provider][entity] ?? [];
  return BASE_FIELDS[entity].filter((f) => !hide.includes(f.key));
}
export const isReadOnlyField = (provider: AcctProvider, entity: AcctEntity, key: string): boolean => (READ_ONLY[provider][entity] ?? []).includes(key);
export function fieldLabel(provider: AcctProvider, entity: AcctEntity, key: string): string {
  return fieldsFor(provider, entity).find((f) => f.key === key)?.label ?? key;
}

export const QUERY_PAGE = 100;
export const PAGE_CAP_PER_RUN = 1500;

// ============================================================
// SETTINGS
// ============================================================

export interface EntitySettings {
  enabled: boolean;
  direction: AcctDirection;
  conflict: AcctConflictRule;
  fields: Record<string, FieldDirection>;
}
export interface AcctDefaults {
  /** Income / sales account used for items and invoice lines Vireek creates (Xero: account CODE). */
  incomeAccountId: string | null;
  /** Account payments are deposited to when the Vireek account is not linked (Xero: account CODE). */
  depositAccountId: string | null;
  /** Item used for invoice lines that match no synced item (required by NetSuite only). */
  fallbackItemId: string | null;
  /** Tax rate / tax code applied to taxable lines. Optional. */
  taxCodeId: string | null;
  /** NetSuite OneWorld subsidiary for records Vireek creates. Optional elsewhere. */
  subsidiaryId: string | null;
  /** ISO-4217 currency of the books. Documents in any other currency are skipped, never converted. */
  currency: string;
  /** Send the Vireek invoice number as the provider's invoice number. */
  sendDocNumber: boolean;
}
export interface AcctSettings {
  version: 1;
  entities: Record<AcctEntity, EntitySettings>;
  defaults: AcctDefaults;
}

const allFields = (provider: AcctProvider, entity: AcctEntity): Record<string, FieldDirection> =>
  Object.fromEntries(fieldsFor(provider, entity).map((f) => [f.key, 'both' as FieldDirection]));

export function defaultSettings(provider: AcctProvider): AcctSettings {
  const mk = (direction: AcctDirection, conflict: AcctConflictRule, entity: AcctEntity): EntitySettings => ({ enabled: true, direction, conflict, fields: allFields(provider, entity) });
  return {
    version: 1,
    entities: {
      // The accounting system owns the chart of accounts; Vireek only reads it by default.
      account: mk('from_ext', 'ext_wins', 'account'),
      customer: mk('both', 'newest_wins', 'customer'),
      // NetSuite items need subsidiary / tax schedule / income account: read-only until the admin opts in.
      item: mk(provider === 'netsuite' ? 'from_ext' : 'both', 'newest_wins', 'item'),
      // Money documents never auto-resolve a disagreement.
      invoice: mk('both', 'manual', 'invoice'),
      payment: mk('both', 'manual', 'payment'),
    },
    defaults: { incomeAccountId: null, depositAccountId: null, fallbackItemId: null, taxCodeId: null, subsidiaryId: null, currency: 'USD', sendDocNumber: provider !== 'netsuite' },
  };
}

export const EXT_ID = /^[A-Za-z0-9_.-]{1,40}$/;
export type SettingsResult = { ok: true; settings: AcctSettings } | { ok: false; error: string };

export function validateSettings(provider: AcctProvider, input: unknown): SettingsResult {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Settings must be an object.' };
  const src = input as Record<string, unknown>;
  const base = defaultSettings(provider);
  const out: AcctSettings = { version: 1, entities: {} as AcctSettings['entities'], defaults: { ...base.defaults } };

  const srcEntities = (src.entities ?? {}) as Record<string, unknown>;
  if (typeof srcEntities !== 'object' || srcEntities === null) return { ok: false, error: 'entities must be an object.' };
  for (const entity of ACCT_ENTITIES) {
    const raw = srcEntities[entity] as Record<string, unknown> | undefined;
    const d = base.entities[entity];
    const label = ENTITY_META[entity].label;
    if (raw === undefined) {
      out.entities[entity] = d;
      continue;
    }
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: `${label}: invalid settings.` };
    const enabled = raw.enabled === undefined ? d.enabled : raw.enabled;
    const direction = raw.direction === undefined ? d.direction : raw.direction;
    const conflict = raw.conflict === undefined ? d.conflict : raw.conflict;
    if (typeof enabled !== 'boolean') return { ok: false, error: `${label}: "enabled" must be true or false.` };
    if (!ACCT_DIRECTIONS.includes(direction as AcctDirection)) return { ok: false, error: `${label}: unknown sync direction.` };
    if (!ACCT_CONFLICT_RULES.includes(conflict as AcctConflictRule)) return { ok: false, error: `${label}: unknown conflict rule.` };
    const fields: Record<string, FieldDirection> = { ...d.fields };
    const rawFields = (raw.fields ?? {}) as Record<string, unknown>;
    if (typeof rawFields !== 'object' || rawFields === null) return { ok: false, error: `${label}: invalid fields.` };
    const known = fieldsFor(provider, entity);
    for (const [key, dir] of Object.entries(rawFields)) {
      if (!known.some((f) => f.key === key)) return { ok: false, error: `${label}: unknown field "${key}".` };
      if (dir !== 'off' && !ACCT_DIRECTIONS.includes(dir as AcctDirection)) return { ok: false, error: `${label}: invalid direction for "${key}".` };
      fields[key] = dir as FieldDirection;
    }
    for (const f of known) {
      if (f.required && fields[f.key] === 'off') return { ok: false, error: `${label}: "${f.label}" is required and cannot be turned off.` };
    }
    out.entities[entity] = { enabled, direction: direction as AcctDirection, conflict: conflict as AcctConflictRule, fields };
  }

  const dflt = (src.defaults ?? {}) as Record<string, unknown>;
  if (typeof dflt !== 'object' || dflt === null) return { ok: false, error: 'defaults must be an object.' };
  for (const key of ['incomeAccountId', 'depositAccountId', 'fallbackItemId', 'taxCodeId', 'subsidiaryId'] as const) {
    const v = dflt[key];
    if (v === undefined) continue;
    if (v === null || v === '') out.defaults[key] = null;
    else if (typeof v === 'string' && EXT_ID.test(v)) out.defaults[key] = v;
    else return { ok: false, error: `Invalid value for ${key}.` };
  }
  if (dflt.currency !== undefined) {
    if (typeof dflt.currency !== 'string' || !/^[A-Z]{3}$/.test(dflt.currency)) return { ok: false, error: 'currency must be a 3-letter ISO code such as USD.' };
    out.defaults.currency = dflt.currency;
  }
  if (dflt.sendDocNumber !== undefined) {
    if (typeof dflt.sendDocNumber !== 'boolean') return { ok: false, error: 'sendDocNumber must be true or false.' };
    out.defaults.sendDocNumber = dflt.sendDocNumber;
  }
  return { ok: true, settings: out };
}

/** The direction a field really syncs in, after the entity-level direction is applied. */
export function effectiveDirection(entityDir: AcctDirection, fieldDir: FieldDirection): FieldDirection {
  if (fieldDir === 'off') return 'off';
  if (entityDir === 'both') return fieldDir;
  if (fieldDir === 'both') return entityDir;
  return fieldDir === entityDir ? fieldDir : 'off';
}
export const canCreateInExt = (es: EntitySettings) => es.enabled && es.direction !== 'from_ext';
export const canCreateInVireek = (es: EntitySettings) => es.enabled && es.direction !== 'to_ext';

// ============================================================
// MERGE (thin wrapper over the shared three-way merge)
// ============================================================

const toCrmDir = (d: FieldDirection): 'both' | 'to_crm' | 'from_crm' => (d === 'to_ext' ? 'to_crm' : d === 'from_ext' ? 'from_crm' : 'both');

export function mergeFieldsFor(provider: AcctProvider, entity: AcctEntity, es: EntitySettings): MergeField[] {
  const out: MergeField[] = [];
  for (const f of fieldsFor(provider, entity)) {
    let dir = effectiveDirection(es.direction, es.fields[f.key] ?? 'both');
    if (dir !== 'off' && isReadOnlyField(provider, entity, f.key)) dir = dir === 'to_ext' ? 'off' : 'from_ext';
    if (dir === 'off') continue;
    out.push({ key: f.key, type: f.type, direction: toCrmDir(dir), required: f.required });
  }
  return out;
}

export function mergeEntity(input: {
  provider: AcctProvider;
  entity: AcctEntity;
  settings: EntitySettings;
  base: Canon | null;
  vireek: Canon;
  ext: Canon;
  vireekTs: number | null;
  extTs: number | null;
  ruleOverride?: 'vireek_wins' | 'ext_wins';
}): MergeResult {
  const rule = input.ruleOverride ?? input.settings.conflict;
  return threeWayMerge({
    fields: mergeFieldsFor(input.provider, input.entity, input.settings),
    base: input.base,
    vireek: input.vireek,
    crm: input.ext,
    rule: rule === 'ext_wins' ? 'crm_wins' : rule,
    vireekTs: input.vireekTs,
    crmTs: input.extTs,
  });
}

// ============================================================
// SMALL HELPERS
// ============================================================

export type RawRecord = Record<string, unknown>;

export const toCents = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
export const fromCents = (cents: number): number => Math.round(cents) / 100;

export function parseTimestamp(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
export const obj = (v: unknown): RawRecord => (v && typeof v === 'object' && !Array.isArray(v) ? (v as RawRecord) : {});
export const arr = (v: unknown): RawRecord[] => (Array.isArray(v) ? (v as RawRecord[]) : []);
export const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
export const dateOnly = (v: unknown): string | null => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? ''));
  return m ? m[1] : null;
};
export const normText = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
export const normalizeDigits = (s: string | null | undefined): string => (s ?? '').replace(/\D/g, '');
/** SQL string literal (SuiteQL): doubles single quotes; control characters are dropped. */
export const sqlLiteral = (s: string): string => `'${s.replace(/[\u0000-\u001f]/g, ' ').replace(/'/g, "''")}'`;
export const joinAddress = (parts: unknown[]): string | null => {
  const p = parts.map((x) => str(x)).filter((x): x is string => !!x);
  return p.length ? p.join(', ') : null;
};

// ============================================================
// ACCOUNTS
// ============================================================

export type VireekAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export const normalBalanceFor = (t: VireekAccountType): 'debit' | 'credit' => (t === 'asset' || t === 'expense' ? 'debit' : 'credit');
export function accountTypeFromClassification(c: unknown): VireekAccountType | null {
  switch (String(c ?? '').toLowerCase()) {
    case 'asset': return 'asset';
    case 'liability': return 'liability';
    case 'equity': return 'equity';
    case 'revenue': return 'revenue';
    case 'expense': return 'expense';
    default: return null;
  }
}
/** chart_of_accounts.code for an account that has no number in the accounting system. */
export const generatedAccountCode = (externalId: string): string => `EX${externalId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`.slice(0, 20);

// ============================================================
// INVOICES + PAYMENTS (canonical documents)
// ============================================================

export interface InvoiceLine {
  description: string;
  qty: number;
  unitPriceCents: number;
  amountCents: number;
  itemId: string | null;
}
export interface ExtInvoiceDoc {
  id: string;
  version: string;
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
export type InvoiceParse = { ok: true; doc: ExtInvoiceDoc } | { ok: false; reason: string; silent?: boolean };

export interface ExtPaymentDoc {
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

export interface VireekInvoiceInput {
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  taxCents: number;
  lines: InvoiceLine[];
}

/** Canonical signature of an invoice's money. Equal signatures mean "same itemisation and total". */
export function invoiceAmountSig(i: { lines: Pick<InvoiceLine, 'description' | 'qty' | 'amountCents'>[]; taxCents: number; totalCents: number }): string {
  const lines = i.lines.map((l) => `${normText(l.description)}~${Math.round(l.qty * 10000) / 10000}~${l.amountCents}`).join(';');
  return `${i.totalCents}|${i.taxCents}|${lines}`;
}

/** Resolve each line's item (exact name match against synced items, else the fallback). `required` = provider cannot take free-text lines. */
export function resolveLineItems(
  lines: InvoiceLine[],
  itemByName: Map<string, string>,
  fallbackItemId: string | null,
  required: boolean,
): { ok: true; lines: InvoiceLine[] } | { ok: false; reason: string } {
  const out: InvoiceLine[] = [];
  for (const l of lines) {
    const id = itemByName.get(normText(l.description)) ?? fallbackItemId;
    if (!id && required) return { ok: false, reason: `No item for the line "${l.description.slice(0, 60)}". Choose a fallback item under Mapping → Defaults.` };
    out.push({ ...l, itemId: id ?? null });
  }
  return { ok: true, lines: out };
}

/** Spread `taxCents` over lines in proportion to their amounts (largest remainder): always sums exactly. */
export function allocateTax(lines: Pick<InvoiceLine, 'amountCents'>[], taxCents: number): number[] {
  const total = lines.reduce((s, l) => s + Math.max(0, l.amountCents), 0);
  if (taxCents <= 0 || total <= 0) return lines.map(() => 0);
  const raw = lines.map((l) => (Math.max(0, l.amountCents) * taxCents) / total);
  const base = raw.map(Math.floor);
  let left = taxCents - base.reduce((s, n) => s + n, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) base[order[k].i]++;
  return base;
}

export type VireekPaymentMethod = 'card' | 'ach' | 'check' | 'cash' | 'other';
export function paymentMethodFromName(name: string | null): VireekPaymentMethod {
  const n = (name ?? '').toLowerCase();
  if (!n) return 'other';
  if (/check|cheque/.test(n)) return 'check';
  if (/cash/.test(n)) return 'cash';
  if (/ach|bank|echeck|e-check|transfer|eft/.test(n)) return 'ach';
  if (/visa|master|amex|american express|discover|card|credit|debit/.test(n)) return 'card';
  return 'other';
}
/** Stable key for one payment-to-invoice application (one external payment can pay several invoices). */
export const paymentLinkKey = (paymentId: string, invoiceId: string) => `${paymentId}:${invoiceId}`;

// ============================================================
// PROVIDER CONTRACT
// ============================================================

export interface HttpReq {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}
export interface ConnInfo {
  provider: AcctProvider;
  /** Xero tenantId · Zoho organization_id · NetSuite account id. */
  tenantId: string;
  /** Zoho data centre (e.g. "eu"); null elsewhere. */
  region: string | null;
  /** Non-secret connection settings (NetSuite client / certificate ids). */
  config: Record<string, unknown>;
}
export interface PulledRecord {
  id: string;
  /** Change marker: equal markers mean "unchanged since we last applied it". Empty string = unknown. */
  version: string;
  modifiedAt: number | null;
  /** Full record when the list call already returned it; null when a detail GET is needed. */
  raw: RawRecord | null;
}
export interface PageResult {
  records: PulledRecord[];
  more: boolean;
}
export type FaultKind = 'ok' | 'stale' | 'duplicate' | 'validation' | 'auth' | 'throttle' | 'notfound' | 'error';
export interface Classified {
  kind: FaultKind;
  message: string;
}
export interface PayloadCtx {
  defaults: AcctDefaults;
  /** Provider account type to create (accounts only). */
  accountType?: string | null;
  /** The live provider record being updated, when the API needs fields echoed back. */
  existing?: RawRecord | null;
  /** Vireek record id (used to derive codes the provider requires). */
  vireekId?: string;
}
export interface OptionRow {
  id: string;
  name: string;
  type: string;
  classification: 'revenue' | 'asset' | 'liability' | 'equity' | 'expense' | '';
}
export interface OptionsSpec {
  key: 'accounts' | 'items' | 'taxCodes' | 'subsidiaries';
  req: HttpReq;
  parse: (json: unknown) => OptionRow[];
}
export interface PaymentCreateInput {
  customerId: string;
  invoiceId: string;
  amountCents: number;
  date: string;
  depositAccountId: string | null;
  method: VireekPaymentMethod;
  note: string;
}

export interface Adapter {
  readonly provider: AcctProvider;
  readonly caps: {
    canVoid: boolean;
    /** Invoice lines must reference an item (NetSuite). */
    lineNeedsItem: boolean;
    /** A created invoice is a draft until it is marked sent (Zoho Books). */
    markSentAfterCreate: boolean;
    /** Writes answer 204 / no body: read the record again after every write (NetSuite). */
    refetchAfterWrite: boolean;
    /** Minimum gap between two API calls (provider rate limit). */
    minGapMs: number;
    hasWebhook: boolean;
    /** How far back every pull re-reads, to absorb clock skew (change markers keep this cheap). */
    pullOverlapMs: number;
  };
  isAllowedUrl(url: string, c: ConnInfo): boolean;
  authHeaders(token: string, c: ConnInfo): Record<string, string>;
  /** `since` is an ISO-8601 UTC timestamp; `pos` is the 1-based page (Xero, Zoho) or 0-based offset (NetSuite). */
  list(c: ConnInfo, e: AcctEntity, since: string | null, pos: number): HttpReq;
  parseList(e: AcctEntity, json: unknown, pos: number): PageResult;
  get(c: ConnInfo, e: AcctEntity, id: string): HttpReq;
  parseOne(e: AcctEntity, json: unknown): RawRecord | null;
  /** Exact-match lookup used to link instead of creating a duplicate; null when the lookup cannot be expressed safely. */
  find(c: ConnInfo, e: AcctEntity, field: 'name' | 'code' | 'number', value: string): HttpReq | null;
  parseFind(e: AcctEntity, json: unknown, field: 'name' | 'code' | 'number', value: string): RawRecord[];
  create(c: ConnInfo, e: AcctEntity, payload: RawRecord, key: string): HttpReq;
  update(c: ConnInfo, e: AcctEntity, id: string, payload: RawRecord, version: string | null): HttpReq;
  parseWrite(e: AcctEntity, json: unknown, location: string | null): { record: RawRecord | null; id: string | null };
  classify(status: number, json: unknown): Classified;
  meta(e: AcctEntity, raw: RawRecord): { id: string; version: string; modifiedAt: number | null };
  isSyncable(e: AcctEntity, raw: RawRecord): boolean;
  toCanon(e: SimpleEntity, raw: RawRecord): Canon;
  toPayload(e: SimpleEntity, values: Canon, ctx: PayloadCtx, create: boolean): RawRecord;
  accountTypeOf(raw: RawRecord): VireekAccountType | null;
  suggestAccountType(type: VireekAccountType, code: string | null): string;
  itemIncomeRef(raw: RawRecord): string | null;
  isCustomerRecord(raw: RawRecord): boolean;
  parseInvoice(raw: RawRecord, currency: string): InvoiceParse;
  buildInvoice(inv: VireekInvoiceInput, customerId: string, ctx: { defaults: AcctDefaults }, existing?: { id: string; version: string; raw: RawRecord | null }): RawRecord;
  voidInvoice(c: ConnInfo, id: string, version: string | null): HttpReq | null;
  markSent(c: ConnInfo, id: string): HttpReq | null;
  parsePayment(raw: RawRecord): ExtPaymentDoc | null;
  createPayment(c: ConnInfo, input: PaymentCreateInput, key: string): HttpReq;
  options(c: ConnInfo): OptionsSpec[];
}

export interface TokenReq {
  url: string;
  headers: Record<string, string>;
  body: string;
}
export interface ParsedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
  refreshExpiresInSec: number | null;
  /** Extra non-secret fields of the token response (Zoho api_domain). */
  extra: Record<string, unknown>;
}
export interface AuthAdapter {
  /** Environment variable prefix: XERO_, ZOHO_, NETSUITE_. */
  readonly envPrefix: string;
  authorizeUrl?(p: { clientId: string; redirectUri: string; state: string; region: string | null; scopes: string }): string;
  tokenRequest(kind: 'code' | 'refresh' | 'client', p: { clientId: string; clientSecret: string; redirectUri?: string; code?: string; refreshToken?: string; region?: string | null; c?: ConnInfo; certificateId?: string; privateKeyPem?: string; alg?: string }): Promise<TokenReq>;
  isAllowedTokenUrl(url: string, c?: ConnInfo | null): boolean;
}
export interface Provider {
  adapter: Adapter;
  auth: AuthAdapter;
}

export const parseTokenResponse = (json: unknown): ParsedTokens => {
  const j = obj(json);
  if (typeof j.access_token !== 'string' || !j.access_token) throw new Error('Token response had no access token.');
  const exp = num(j.expires_in);
  const rexp = num(j.refresh_token_expires_in) ?? num(j.x_refresh_token_expires_in);
  const { access_token: _a, refresh_token: _r, expires_in: _e, ...rest } = j;
  return {
    accessToken: j.access_token,
    refreshToken: typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : null,
    expiresInSec: exp && exp > 0 ? exp : null,
    refreshExpiresInSec: rexp && rexp > 0 ? rexp : null,
    extra: rest,
  };
};

// ============================================================
// OAUTH STATE + WEBHOOK SIGNATURES
// ============================================================

const STATE_TTL_MS = 10 * 60 * 1000;
export interface OAuthState {
  /** account owner id */
  o: string;
  /** user who clicked connect */
  u: string;
  /** provider the state was issued for: a state is never accepted by another provider */
  p: AcctProvider;
  /** requested data centre (Zoho) */
  r: string | null;
  /** nonce */
  n: string;
  t: number;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}
export const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export async function signOAuthState(data: { owner: string; user: string; provider: AcctProvider; region?: string | null }, secret: string, now: number = Date.now()): Promise<string> {
  const payload: OAuthState = { o: data.owner, u: data.user, p: data.provider, r: data.region ?? null, n: b64url(crypto.getRandomValues(new Uint8Array(16))), t: now };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${b64url(await hmac(secret, body))}`;
}

export async function verifyOAuthState(state: string, secret: string, now: number = Date.now()): Promise<OAuthState | null> {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!constantTimeEqual(b64url(await hmac(secret, body)), sig)) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as OAuthState;
    if (typeof p.o !== 'string' || typeof p.u !== 'string' || typeof p.n !== 'string' || !isProvider(p.p)) return null;
    if (!Number.isFinite(p.t) || now - p.t > STATE_TTL_MS || p.t - now > 60_000) return null;
    return { ...p, r: typeof p.r === 'string' ? p.r : null };
  } catch {
    return null;
  }
}

/** base64(HMAC-SHA256(key, rawBody)), compared in constant time (Xero webhooks). */
export async function verifyHmacBase64(rawBody: string, signature: string | null, key: string): Promise<boolean> {
  if (!signature || !key) return false;
  const expected = btoa(String.fromCharCode(...(await hmac(key, rawBody))));
  return constantTimeEqual(expected, signature);
}

// ============================================================
// STATS
// ============================================================

export interface SyncStats {
  created_vireek: number;
  updated_vireek: number;
  created_ext: number;
  updated_ext: number;
  skipped: number;
  conflicts: number;
  errors: number;
}
export const emptyStats = (): SyncStats => ({ created_vireek: 0, updated_vireek: 0, created_ext: 0, updated_ext: 0, skipped: 0, conflicts: 0, errors: 0 });

/** Fixed-length id check used for every id that is interpolated into a URL path. */
export const isSafeId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(s);
export const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
