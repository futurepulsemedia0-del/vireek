// supabase/functions/_shared/xero/engine.ts
//
// Vireek <-> Xero sync engine: pure and deterministic. NO network, NO database, NO Deno/DOM APIs
// (only WebCrypto, which exists in Deno, browsers and Node 20+). It is imported by the edge
// functions, by the React client (settings catalog for the mapping UI) and by the unit tests.
//
//   OAuth      : signed state, authorize / token / refresh request shapes, host allow-lists,
//                connection (tenant) selection, webhook signature
//   Settings   : per-entity enable / direction / conflict rule / per-field direction + defaults
//   Adapters   : Xero record <-> canonical values (contacts, items, accounts)
//   Invoices   : parsing (tax-inclusive/exclusive, discounts, MULTI-CURRENCY -> base) and payloads
//   Payments   : parsing, FX-aware base-currency conversion, payloads
//   Tax rates  : parsing + selection helpers for the mapping UI
//   Requests   : list / get / find / write request builders, fault classification, retry policy
//   Merge      : field-level THREE-WAY merge (shared with CRM Sync / QuickBooks Sync)
//
// Integrity rules (same philosophy as the QuickBooks engine):
//   1. Nothing from the client ever becomes a table, column, URL path or query fragment. Every
//      interpolated value is a fixed constant, validated against a strict pattern, or URL-encoded.
//   2. Bearer tokens and the client secret are only sent to the allow-listed Xero hosts.
//   3. Money is integer cents on the Vireek side and is converted at the edge only.
//   4. A conflict exists only when BOTH sides changed the same field since the last sync.
//   5. Anything that cannot be represented faithfully is reported as "unsupported" with a reason,
//      never guessed. Foreign-currency documents are converted at Xero's own rate (never at an
//      invented one) and the original amount + rate are kept on the link for audit.
//   6. Realised FX gain/loss on foreign-currency payments is NOT posted to the ledger (reported).
//
// NOT LIVE-VERIFIED: every request/response shape below follows Xero's public documentation and the
// unit tests exercise it with mocked data only. Verify against a Xero Demo Company before relying
// on it in production (see XERO_SYNC.md).

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

export const XERO_ENTITIES = ['account', 'contact', 'item', 'invoice', 'payment'] as const;
export type XeroEntity = (typeof XERO_ENTITIES)[number];
export type XeroDirection = 'both' | 'to_xero' | 'from_xero';
export type FieldDirection = XeroDirection | 'off';
export type XeroConflictRule = 'newest_wins' | 'vireek_wins' | 'xero_wins' | 'manual';
export type ForeignCurrencyMode = 'convert' | 'skip';

export const XERO_DIRECTIONS: XeroDirection[] = ['both', 'to_xero', 'from_xero'];
export const XERO_CONFLICT_RULES: XeroConflictRule[] = ['newest_wins', 'vireek_wins', 'xero_wins', 'manual'];
export const FOREIGN_CURRENCY_MODES: ForeignCurrencyMode[] = ['convert', 'skip'];

export const ENTITY_META: Record<
  XeroEntity,
  { label: string; vireekLabel: string; xeroLabel: string; table: string; xeroPath: string; idKey: string; hint: string }
> = {
  account: { label: 'Accounts', vireekLabel: 'Chart of accounts', xeroLabel: 'Chart of accounts', table: 'chart_of_accounts', xeroPath: 'Accounts', idKey: 'AccountID', hint: 'Your chart of accounts. Xero is normally the source of truth.' },
  contact: { label: 'Contacts', vireekLabel: 'Customers', xeroLabel: 'Contacts', table: 'customers', xeroPath: 'Contacts', idKey: 'ContactID', hint: 'Names, email, phone and street address. Pure suppliers are not imported.' },
  item: { label: 'Items', vireekLabel: 'Price book', xeroLabel: 'Products & services', table: 'price_book_items', xeroPath: 'Items', idKey: 'ItemID', hint: 'Services and their sales prices (items that are not tracked as inventory).' },
  invoice: { label: 'Invoices', vireekLabel: 'AR invoices', xeroLabel: 'Sales invoices', table: 'ar_invoices', xeroPath: 'Invoices', idKey: 'InvoiceID', hint: 'Approved sales invoices, line items, tax, due dates and voids. Foreign-currency invoices are converted at Xero’s rate.' },
  payment: { label: 'Payments', vireekLabel: 'AR payments', xeroLabel: 'Payments', table: 'ar_payments', xeroPath: 'Payments', idKey: 'PaymentID', hint: 'Customer payments applied to invoices. Payments are never edited, only created.' },
};

export const DIRECTION_META: Record<XeroDirection, { label: string }> = {
  both: { label: 'Two-way' },
  to_xero: { label: 'Vireek → Xero' },
  from_xero: { label: 'Xero → Vireek' },
};

export const CONFLICT_RULE_META: Record<XeroConflictRule, { label: string; hint: string }> = {
  newest_wins: { label: 'Newest change wins', hint: 'When both sides edited the same field, keep the most recent edit.' },
  vireek_wins: { label: 'Vireek wins', hint: 'Vireek is the source of truth for conflicting fields.' },
  xero_wins: { label: 'Xero wins', hint: 'Xero is the source of truth for conflicting fields.' },
  manual: { label: 'Review manually', hint: 'Leave both values untouched and ask me to choose.' },
};

export const CURRENCY_MODE_META: Record<ForeignCurrencyMode, { label: string; hint: string }> = {
  convert: { label: 'Convert to my currency', hint: 'Foreign-currency invoices are booked in your base currency at the exchange rate stored on the Xero invoice. The original amount and rate are kept in the sync log.' },
  skip: { label: 'Skip foreign-currency invoices', hint: 'Only invoices in your base currency are synced. Others are listed in the log.' },
};

export interface VireekField {
  key: string;
  label: string;
  type: VireekFieldType;
  required?: boolean;
}

export const VIREEK_FIELDS: Record<XeroEntity, VireekField[]> = {
  account: [
    { key: 'code', label: 'Account code', type: 'text', required: true },
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'active', label: 'Active / archived', type: 'text' },
  ],
  contact: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'phone', label: 'Phone', type: 'phone' },
    { key: 'address', label: 'Street address', type: 'text' },
  ],
  item: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'description', label: 'Description', type: 'text' },
    { key: 'price', label: 'Sales price', type: 'number' },
  ],
  invoice: [
    { key: 'due_date', label: 'Due date', type: 'date' },
    { key: 'amounts', label: 'Line items, tax and total', type: 'text' },
    { key: 'voided', label: 'Void status', type: 'text' },
  ],
  payment: [],
};

export const XERO_PAGE = 100;
export const PULL_OVERLAP_MS = 2 * 60 * 1000;
export const PAGE_CAP_PER_RUN = 1500;
/** Xero refresh tokens expire after 60 days; every refresh issues a new one. */
export const REFRESH_TOKEN_TTL_SEC = 60 * 24 * 3600;
/** Foreign-currency payment rounding tolerance (cents) when settling the base-currency balance. */
export const FX_DUST_CENTS = 2;

// ============================================================
// SETTINGS
// ============================================================

export interface EntitySettings {
  enabled: boolean;
  direction: XeroDirection;
  conflict: XeroConflictRule;
  fields: Record<string, FieldDirection>;
}
export interface XeroDefaults {
  /** Xero account CODE used for invoice lines that match no synced item (e.g. "200"). */
  salesAccountCode: string | null;
  /** Xero AccountID (GUID) of the bank / payment-enabled account payments are deposited to. */
  depositAccountId: string | null;
  /** Xero item CODE used for invoice lines that match no synced item. Optional. */
  fallbackItemCode: string | null;
  /** Xero TaxType applied to the lines of invoices that carry tax. */
  taxType: string | null;
  /** Xero TaxType applied to lines of tax-free invoices. Defaults to "NONE" when not set. */
  zeroTaxType: string | null;
  /** Send the Vireek invoice number as the Xero InvoiceNumber. */
  sendInvoiceNumber: boolean;
  /** Keep the read-only Xero tax-rate list fresh (powers the mapping dropdowns). */
  syncTaxRates: boolean;
  /** What to do with invoices not in the base currency. */
  foreignCurrency: ForeignCurrencyMode;
}
export interface XeroSettings {
  version: 1;
  entities: Record<XeroEntity, EntitySettings>;
  defaults: XeroDefaults;
}

const allFields = (entity: XeroEntity): Record<string, FieldDirection> =>
  Object.fromEntries(VIREEK_FIELDS[entity].map((f) => [f.key, 'both' as FieldDirection]));

export function defaultSettings(): XeroSettings {
  const mk = (direction: XeroDirection, conflict: XeroConflictRule, entity: XeroEntity): EntitySettings => ({
    enabled: true,
    direction,
    conflict,
    fields: allFields(entity),
  });
  return {
    version: 1,
    entities: {
      // Xero owns the chart of accounts; Vireek only reads it by default.
      account: mk('from_xero', 'xero_wins', 'account'),
      contact: mk('both', 'newest_wins', 'contact'),
      item: mk('both', 'newest_wins', 'item'),
      // Money documents never auto-resolve a disagreement.
      invoice: mk('both', 'manual', 'invoice'),
      payment: mk('both', 'manual', 'payment'),
    },
    defaults: {
      salesAccountCode: null,
      depositAccountId: null,
      fallbackItemCode: null,
      taxType: null,
      zeroTaxType: null,
      sendInvoiceNumber: true,
      syncTaxRates: true,
      foreignCurrency: 'convert',
    },
  };
}

export const XERO_GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Xero account / item codes: printable, no quotes, backslashes, angle brackets or control characters. */
export const XERO_CODE = /^[^\u0000-\u001f"'\\<>]{1,30}$/;
export const XERO_TAX_TYPE = /^[A-Za-z0-9_\-]{1,50}$/;
export const isValidXeroId = (s: unknown): s is string => typeof s === 'string' && XERO_GUID.test(s);

export type SettingsResult = { ok: true; settings: XeroSettings } | { ok: false; error: string };

export function validateSettings(input: unknown): SettingsResult {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Settings must be an object.' };
  const src = input as Record<string, unknown>;
  const base = defaultSettings();
  const out: XeroSettings = { version: 1, entities: {} as XeroSettings['entities'], defaults: { ...base.defaults } };

  const srcEntities = (src.entities ?? {}) as Record<string, unknown>;
  if (typeof srcEntities !== 'object' || srcEntities === null) return { ok: false, error: 'entities must be an object.' };
  for (const entity of XERO_ENTITIES) {
    const raw = srcEntities[entity] as Record<string, unknown> | undefined;
    const d = base.entities[entity];
    if (raw === undefined) {
      out.entities[entity] = d;
      continue;
    }
    const label = ENTITY_META[entity].label;
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: `${label}: invalid settings.` };
    const enabled = raw.enabled === undefined ? d.enabled : raw.enabled;
    const direction = raw.direction === undefined ? d.direction : raw.direction;
    const conflict = raw.conflict === undefined ? d.conflict : raw.conflict;
    if (typeof enabled !== 'boolean') return { ok: false, error: `${label}: "enabled" must be true or false.` };
    if (!XERO_DIRECTIONS.includes(direction as XeroDirection)) return { ok: false, error: `${label}: unknown sync direction.` };
    if (!XERO_CONFLICT_RULES.includes(conflict as XeroConflictRule)) return { ok: false, error: `${label}: unknown conflict rule.` };
    const fields: Record<string, FieldDirection> = { ...d.fields };
    const rawFields = (raw.fields ?? {}) as Record<string, unknown>;
    if (typeof rawFields !== 'object' || rawFields === null) return { ok: false, error: `${label}: invalid fields.` };
    for (const [key, dir] of Object.entries(rawFields)) {
      if (!VIREEK_FIELDS[entity].some((f) => f.key === key)) return { ok: false, error: `${label}: unknown field "${key}".` };
      if (dir !== 'off' && !XERO_DIRECTIONS.includes(dir as XeroDirection)) return { ok: false, error: `${label}: invalid direction for "${key}".` };
      fields[key] = dir as FieldDirection;
    }
    for (const f of VIREEK_FIELDS[entity]) {
      if (f.required && fields[f.key] === 'off') return { ok: false, error: `${label}: "${f.label}" is required and cannot be turned off.` };
    }
    out.entities[entity] = { enabled, direction: direction as XeroDirection, conflict: conflict as XeroConflictRule, fields };
  }

  const dflt = (src.defaults ?? {}) as Record<string, unknown>;
  if (typeof dflt !== 'object' || dflt === null) return { ok: false, error: 'defaults must be an object.' };
  const checks: { key: 'salesAccountCode' | 'fallbackItemCode' | 'depositAccountId' | 'taxType' | 'zeroTaxType'; re: RegExp }[] = [
    { key: 'salesAccountCode', re: XERO_CODE },
    { key: 'fallbackItemCode', re: XERO_CODE },
    { key: 'depositAccountId', re: XERO_GUID },
    { key: 'taxType', re: XERO_TAX_TYPE },
    { key: 'zeroTaxType', re: XERO_TAX_TYPE },
  ];
  for (const { key, re } of checks) {
    const v = dflt[key];
    if (v === undefined) continue;
    if (v === null || v === '') out.defaults[key] = null;
    else if (typeof v === 'string' && re.test(v)) out.defaults[key] = v;
    else return { ok: false, error: `Invalid value for ${key}.` };
  }
  for (const key of ['sendInvoiceNumber', 'syncTaxRates'] as const) {
    if (dflt[key] === undefined) continue;
    if (typeof dflt[key] !== 'boolean') return { ok: false, error: `${key} must be true or false.` };
    out.defaults[key] = dflt[key] as boolean;
  }
  if (dflt.foreignCurrency !== undefined) {
    if (!FOREIGN_CURRENCY_MODES.includes(dflt.foreignCurrency as ForeignCurrencyMode)) return { ok: false, error: 'Unknown foreign-currency mode.' };
    out.defaults.foreignCurrency = dflt.foreignCurrency as ForeignCurrencyMode;
  }
  return { ok: true, settings: out };
}

/** The direction a field really syncs in, after the entity-level direction is applied. */
export function effectiveDirection(entityDir: XeroDirection, fieldDir: FieldDirection): FieldDirection {
  if (fieldDir === 'off') return 'off';
  if (entityDir === 'both') return fieldDir;
  if (fieldDir === 'both') return entityDir;
  return fieldDir === entityDir ? fieldDir : 'off';
}
export const canCreateInXero = (es: EntitySettings) => es.enabled && es.direction !== 'from_xero';
export const canCreateInVireek = (es: EntitySettings) => es.enabled && es.direction !== 'to_xero';

// ============================================================
// MERGE (thin wrapper over the shared three-way merge)
// ============================================================

const toCrmDir = (d: FieldDirection): 'both' | 'to_crm' | 'from_crm' => (d === 'to_xero' ? 'to_crm' : d === 'from_xero' ? 'from_crm' : 'both');

export function mergeFieldsFor(entity: XeroEntity, es: EntitySettings): MergeField[] {
  const out: MergeField[] = [];
  for (const f of VIREEK_FIELDS[entity]) {
    const dir = effectiveDirection(es.direction, es.fields[f.key] ?? 'both');
    if (dir === 'off') continue;
    out.push({ key: f.key, type: f.type, direction: toCrmDir(dir), required: f.required });
  }
  return out;
}

export function mergeEntity(input: {
  entity: XeroEntity;
  settings: EntitySettings;
  base: Canon | null;
  vireek: Canon;
  xero: Canon;
  vireekTs: number | null;
  xeroTs: number | null;
  ruleOverride?: 'vireek_wins' | 'xero_wins';
}): MergeResult {
  const rule = input.ruleOverride ?? input.settings.conflict;
  return threeWayMerge({
    fields: mergeFieldsFor(input.entity, input.settings),
    base: input.base,
    vireek: input.vireek,
    crm: input.xero,
    rule: rule === 'xero_wins' ? 'crm_wins' : rule,
    vireekTs: input.vireekTs,
    crmTs: input.xeroTs,
  });
}

// ============================================================
// SMALL HELPERS
// ============================================================

export type RawRecord = Record<string, unknown>;

export const toCents = (amount: unknown): number => {
  const n = typeof amount === 'number' ? amount : Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
export const fromCents = (cents: number): number => Math.round(cents) / 100;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const obj = (v: unknown): RawRecord => (v && typeof v === 'object' && !Array.isArray(v) ? (v as RawRecord) : {});
const arr = (v: unknown): RawRecord[] => (Array.isArray(v) ? (v as RawRecord[]) : []);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const normText = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
export const normalizeText = normText;

/**
 * Xero dates. JSON responses use the .NET form "/Date(1439434356790+0000)/"; newer *String fields
 * are ISO without a zone (always UTC). Both are accepted. Returns epoch ms or null.
 */
export function parseXeroDate(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const ms = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(v);
  if (ms) return Number(ms[1]);
  const iso = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(v) ? `${v}Z` : v;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}
export const parseTimestamp = parseXeroDate;

/** "YYYY-MM-DD" of a date field, preferring the unambiguous `<Key>String` variant. */
export function xeroDateOnly(raw: RawRecord, key: string): string | null {
  const s = str(raw[`${key}String`]);
  const m = s ? /^(\d{4}-\d{2}-\d{2})/.exec(s) : null;
  if (m) return m[1];
  const direct = str(raw[key]);
  const d = direct ? /^(\d{4}-\d{2}-\d{2})/.exec(direct) : null;
  if (d) return d[1];
  const ms = parseXeroDate(raw[key]);
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
}

/** `If-Modified-Since` header value (UTC, no zone designator). */
export const xeroIfModifiedSince = (ms: number): string => new Date(ms).toISOString().slice(0, 19);

export function recordMeta(entity: XeroEntity, raw: RawRecord): { id: string; version: string; modifiedAt: number | null } {
  const id = String(raw[ENTITY_META[entity].idKey] ?? '');
  const iso = str(raw.UpdatedDateUTCString);
  return { id, version: iso ?? String(raw.UpdatedDateUTC ?? ''), modifiedAt: parseXeroDate(iso) ?? parseXeroDate(raw.UpdatedDateUTC) };
}

/** Largest-remainder allocation: the parts always sum to exactly `total`. */
export function allocateCents(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (!n) return [];
  const t = Math.round(total);
  const out = new Array<number>(n).fill(0);
  if (t <= 0) {
    out[0] = t;
    return out;
  }
  const w = weights.map((x) => Math.max(0, x));
  const sum = w.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    out[0] = t;
    return out;
  }
  const exact = w.map((x) => (t * x) / sum);
  const floor = exact.map(Math.floor);
  let left = t - floor.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) floor[order[k].i]++;
  return floor;
}

export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
export const normalizeDigits = (s: string | null | undefined): string => (s ?? '').replace(/\D/g, '');

/** Short deterministic hash (FNV-1a, 32 bit, hex) used inside idempotency keys. */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Idempotency-Key for a create call. Same record + same payload = same key (a retry after a timeout
 * can never create a second copy); a changed payload gets a new key (so Xero never sees one key with
 * two different bodies). Max 128 chars, URL-safe.
 */
export function idempotencyKey(prefix: string, vireekId: string, payload: unknown): string {
  return `vk-${prefix}-${vireekId.replace(/[^A-Za-z0-9]/g, '')}-${shortHash(JSON.stringify(payload))}`.slice(0, 128);
}
export const isValidIdempotencyKey = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);

// ============================================================
// ACCOUNTS
// ============================================================

export type VireekAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export const normalBalanceFor = (t: VireekAccountType): 'debit' | 'credit' => (t === 'asset' || t === 'expense' ? 'debit' : 'credit');

export function accountTypeFromClass(cls: unknown): VireekAccountType | null {
  switch (String(cls ?? '').toUpperCase()) {
    case 'ASSET': return 'asset';
    case 'LIABILITY': return 'liability';
    case 'EQUITY': return 'equity';
    case 'REVENUE': return 'revenue';
    case 'EXPENSE': return 'expense';
    default: return null;
  }
}

/**
 * Xero account TYPE to create for a Vireek account. BANK is never suggested (Xero requires a bank
 * account number for it) and system accounts (debtors, creditors, tax) cannot be created by API.
 */
export function suggestXeroAccountType(type: VireekAccountType, code: string | null): string {
  const c = code ?? '';
  switch (type) {
    case 'asset': return c === '1500' ? 'FIXED' : 'CURRENT';
    case 'liability': return c === '2500' ? 'TERMLIAB' : 'CURRLIAB';
    case 'equity': return 'EQUITY';
    case 'revenue': return c === '4900' ? 'OTHERINCOME' : 'REVENUE';
    case 'expense': return c.startsWith('5') ? 'DIRECTCOSTS' : 'EXPENSE';
  }
}

/** Xero account codes: max 10 chars, letters / digits / "." "-" "_" " ". */
export const xeroAccountCode = (s: string): string => s.replace(/[^A-Za-z0-9._\- ]/g, '').trim().slice(0, 10);
/** Vireek code for a Xero account that has no code (rare: Xero requires one unless account numbers are off). */
export const generatedAccountCode = (xeroId: string): string => `XR${xeroId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
/** Xero item codes: max 30 chars. */
export const xeroItemName = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 50);
export function suggestItemCode(name: string, vireekId: string): string {
  const clean = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 21);
  const suffix = vireekId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
  return clean ? `${clean}-${suffix}`.slice(0, 30) : `VK-${suffix}`;
}

// ============================================================
// XERO RECORD <-> CANONICAL (contacts, items, accounts)
// ============================================================

export function composeAddress(a: unknown): string | null {
  const x = obj(a);
  const region = [str(x.Region), str(x.PostalCode)].filter(Boolean).join(' ') || null;
  const parts = [str(x.AddressLine1), str(x.AddressLine2), str(x.AddressLine3), str(x.AddressLine4), str(x.City), region].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function composePhone(p: RawRecord | undefined): string | null {
  if (!p) return null;
  const cc = str(p.PhoneCountryCode);
  const area = str(p.PhoneAreaCode);
  const number = str(p.PhoneNumber);
  if (!number) return null;
  return `${cc ? `+${cc.replace(/^\+/, '')} ` : ''}${area ? `${area} ` : ''}${number}`.trim();
}

export function xeroToCanon(entity: 'account' | 'contact' | 'item', raw: RawRecord): Canon {
  switch (entity) {
    case 'contact': {
      const phones = arr(raw.Phones).filter((p) => str(p.PhoneNumber));
      const phone = phones.find((p) => p.PhoneType === 'DEFAULT') ?? phones.find((p) => p.PhoneType === 'MOBILE') ?? phones[0];
      const addresses = arr(raw.Addresses);
      const street = addresses.find((a) => a.AddressType === 'STREET') ?? addresses.find((a) => composeAddress(a));
      return {
        name: str(raw.Name),
        email: str(raw.EmailAddress),
        phone: composePhone(phone),
        address: composeAddress(street),
      };
    }
    case 'item': {
      const name = str(raw.Name);
      return {
        name: name ? xeroItemName(name) : null,
        description: str(raw.Description),
        price: num(obj(raw.SalesDetails).UnitPrice),
      };
    }
    case 'account':
      return {
        code: str(raw.Code),
        name: str(raw.Name),
        active: String(raw.Status ?? 'ACTIVE').toUpperCase() === 'ARCHIVED' ? 'inactive' : 'active',
      };
  }
}

export interface PayloadCtx {
  defaults: XeroDefaults;
  /** Only for accounts being created in Xero. */
  accountType?: string | null;
  /** Only for items being created in Xero. */
  itemCode?: string | null;
  /** Live Xero record, so partial updates never wipe sibling fields (item SalesDetails). */
  existing?: RawRecord | null;
}

/** Fields (in `values`) to write to Xero. For creates pass every mapped field. */
export function canonToXero(entity: 'account' | 'contact' | 'item', values: Canon, ctx: PayloadCtx, create: boolean): RawRecord {
  const p: RawRecord = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(values, k);
  switch (entity) {
    case 'contact':
      if (has('name') && values.name) p.Name = String(values.name).slice(0, 255);
      if (has('email')) p.EmailAddress = values.email ? String(values.email).slice(0, 255) : '';
      if (has('phone') && values.phone) p.Phones = [{ PhoneType: 'DEFAULT', PhoneNumber: String(values.phone).slice(0, 50) }];
      if (has('address') && values.address) p.Addresses = [{ AddressType: 'STREET', AddressLine1: String(values.address).slice(0, 500) }];
      return p;
    case 'item': {
      if (create && ctx.itemCode) p.Code = ctx.itemCode.slice(0, 30);
      if (has('name') && values.name) p.Name = xeroItemName(String(values.name));
      if (has('description')) p.Description = values.description ? String(values.description).slice(0, 4000) : '';
      if (has('price') && values.price !== null && values.price !== undefined) {
        const keep = create ? {} : obj(ctx.existing?.SalesDetails);
        p.SalesDetails = {
          ...keep,
          UnitPrice: Number(values.price),
          ...(create && ctx.defaults.salesAccountCode ? { AccountCode: ctx.defaults.salesAccountCode } : {}),
        };
      } else if (create && ctx.defaults.salesAccountCode) {
        p.SalesDetails = { AccountCode: ctx.defaults.salesAccountCode };
      }
      if (create) {
        p.IsSold = true;
        p.IsPurchased = false;
      }
      return p;
    }
    case 'account':
      if (has('name') && values.name) p.Name = String(values.name).slice(0, 150);
      if (has('code') && values.code) p.Code = xeroAccountCode(String(values.code));
      if (has('active')) p.Status = values.active === 'inactive' ? 'ARCHIVED' : 'ACTIVE';
      if (create && ctx.accountType) p.Type = ctx.accountType;
      return p;
  }
}

/** Items Vireek can represent as a price-book entry: sold, not stock-tracked. */
export const isSyncableItem = (raw: RawRecord): boolean => raw.IsTrackedAsInventory !== true && raw.IsSold !== false && !!str(raw.Code);
/** Contacts worth importing: active, and not a pure supplier. */
export function isSyncableContact(raw: RawRecord): boolean {
  if (String(raw.ContactStatus ?? 'ACTIVE').toUpperCase() !== 'ACTIVE') return false;
  return raw.IsSupplier !== true || raw.IsCustomer === true;
}
/** A synced account must be usable as a ledger account. */
export const isSyncableAccount = (raw: RawRecord): boolean => {
  const status = String(raw.Status ?? 'ACTIVE').toUpperCase();
  return status !== 'DELETED' && accountTypeFromClass(raw.Class) !== null;
};

// ============================================================
// CURRENCY
// ============================================================

export interface FxInfo {
  /** ISO code of the document currency. */
  currency: string;
  /** Xero CurrencyRate: units of `currency` per 1 unit of the base currency. */
  rate: number;
  /** Original document amounts in the document currency (cents). */
  totalCents: number;
  subtotalCents: number;
  taxCents: number;
}

export type CurrencyCheck = { ok: true } | { ok: false; reason: string };
/** Money documents are only synced when both ledgers share one base currency. */
export function checkBaseCurrency(xeroBase: string | null | undefined, vireekCurrency: string | null | undefined): CurrencyCheck {
  const x = (xeroBase ?? '').toUpperCase();
  const v = (vireekCurrency ?? 'USD').toUpperCase();
  if (!x) return { ok: false, reason: 'The Xero organisation base currency is unknown. Reconnect Xero.' };
  if (x === v) return { ok: true };
  return { ok: false, reason: `Xero's base currency is ${x} but Vireek is set to ${v}. Invoices and payments are not synced until both use the same currency (Settings → Regional), or connect an organisation that uses ${v}.` };
}

/**
 * Converts a foreign document to the base currency at the Xero rate. The converted total is
 * round(total / rate); tax is converted the same way and the subtotal is the remainder, then spread
 * over the lines with largest-remainder so the base-currency invoice is exactly balanced.
 */
export function convertToBase(
  lines: { amountCents: number; qty: number }[],
  taxCents: number,
  totalCents: number,
  rate: number,
): { amounts: number[]; unitPrices: number[]; taxCents: number; totalCents: number; subtotalCents: number } {
  const baseTotal = Math.max(0, Math.round(totalCents / rate));
  const baseTax = Math.min(baseTotal, Math.max(0, Math.round(taxCents / rate)));
  const baseSub = baseTotal - baseTax;
  const amounts = allocateCents(baseSub, lines.map((l) => l.amountCents));
  const unitPrices = amounts.map((a, i) => (lines[i].qty ? Math.round(a / lines[i].qty) : a));
  return { amounts, unitPrices, taxCents: baseTax, totalCents: baseTotal, subtotalCents: baseSub };
}

export function describeFx(fx: FxInfo, base: string, baseTotalCents: number): string {
  return `${fx.currency} ${(fx.totalCents / 100).toFixed(2)} at ${fx.rate} = ${base} ${(baseTotalCents / 100).toFixed(2)}`;
}

// ============================================================
// INVOICES
// ============================================================

export interface InvoiceLine {
  description: string;
  qty: number;
  unitPriceCents: number;
  /** Net amount (excluding tax), in the BASE currency. */
  amountCents: number;
  itemCode: string | null;
  accountCode: string | null;
}
export interface XeroInvoiceDoc {
  id: string;
  version: string;
  number: string | null;
  contactId: string | null;
  txnDate: string | null;
  dueDate: string | null;
  status: string;
  /** Lines + totals in the BASE currency (converted when the invoice is in a foreign currency). */
  lines: InvoiceLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  voided: boolean;
  /** null for base-currency invoices. */
  fx: FxInfo | null;
  modifiedAt: number | null;
}
export type InvoiceParse =
  | { ok: true; doc: XeroInvoiceDoc }
  | { ok: false; reason: string; kind: 'not_sales' | 'draft' | 'unsupported' | 'foreign' };

export interface InvoiceParseOpts {
  baseCurrency: string;
  foreignCurrency: ForeignCurrencyMode;
}

export function parseXeroInvoice(raw: RawRecord, opts: InvoiceParseOpts): InvoiceParse {
  const meta = recordMeta('invoice', raw);
  if (!meta.id) return { ok: false, kind: 'unsupported', reason: 'Invoice has no id.' };
  if (raw.Type !== undefined && raw.Type !== 'ACCREC') return { ok: false, kind: 'not_sales', reason: 'Not a sales invoice.' };
  const status = String(raw.Status ?? '').toUpperCase();
  if (status === 'DRAFT' || status === 'SUBMITTED') return { ok: false, kind: 'draft', reason: 'Invoice is not approved yet.' };

  const voided = status === 'VOIDED' || status === 'DELETED';
  const base = {
    id: meta.id,
    version: meta.version,
    number: str(raw.InvoiceNumber),
    contactId: str(obj(raw.Contact).ContactID),
    txnDate: xeroDateOnly(raw, 'Date'),
    dueDate: xeroDateOnly(raw, 'DueDate'),
    status,
    modifiedAt: meta.modifiedAt,
  };
  if (voided) return { ok: true, doc: { ...base, lines: [], subtotalCents: 0, taxCents: 0, totalCents: 0, voided: true, fx: null } };

  const baseCcy = opts.baseCurrency.toUpperCase();
  const currency = (str(raw.CurrencyCode) ?? baseCcy).toUpperCase();
  const foreign = currency !== baseCcy;
  const rate = num(raw.CurrencyRate);
  if (foreign) {
    if (opts.foreignCurrency === 'skip') return { ok: false, kind: 'foreign', reason: `Invoice is in ${currency}; foreign-currency invoices are set to be skipped.` };
    if (rate === null || rate <= 0) return { ok: false, kind: 'foreign', reason: `Invoice is in ${currency} but Xero returned no exchange rate.` };
  }

  const amountType = String(raw.LineAmountTypes ?? 'Exclusive');
  const inclusive = amountType === 'Inclusive';
  const noTax = amountType === 'NoTax';
  const rawLines: { description: string; qty: number; amountCents: number; unitPriceCents: number; itemCode: string | null; accountCode: string | null; tax: number }[] = [];
  for (const l of arr(raw.LineItems)) {
    const lineTax = noTax ? 0 : toCents(l.TaxAmount ?? 0);
    const gross = toCents(l.LineAmount);
    const net = inclusive ? gross - lineTax : gross;
    if (net < 0) return { ok: false, kind: 'unsupported', reason: 'Negative lines are not supported.' };
    const qty = num(l.Quantity) ?? 1;
    const unit = num(l.UnitAmount);
    const discounted = num(l.DiscountRate) !== null && num(l.DiscountRate) !== 0 || num(l.DiscountAmount) !== null && num(l.DiscountAmount) !== 0;
    const unitPriceCents = !inclusive && !discounted && unit !== null ? toCents(unit) : qty ? Math.round(net / qty) : net;
    rawLines.push({
      description: (str(l.Description) ?? str(l.ItemCode) ?? 'Item').slice(0, 1000),
      qty,
      amountCents: net,
      unitPriceCents,
      itemCode: str(l.ItemCode),
      accountCode: str(l.AccountCode),
      tax: lineTax,
    });
  }
  if (rawLines.length === 0) return { ok: false, kind: 'unsupported', reason: 'Invoice has no line items.' };

  const subtotal = rawLines.reduce((s, l) => s + l.amountCents, 0);
  const tax = rawLines.reduce((s, l) => s + l.tax, 0);
  const total = toCents(raw.Total);
  if (subtotal + tax !== total) return { ok: false, kind: 'unsupported', reason: 'Totals do not add up (rounding or tax setup on the Xero side).' };

  if (!foreign) {
    return {
      ok: true,
      doc: {
        ...base,
        lines: rawLines.map(({ tax: _t, ...l }) => l),
        subtotalCents: subtotal,
        taxCents: tax,
        totalCents: total,
        voided: false,
        fx: null,
      },
    };
  }
  const conv = convertToBase(rawLines, tax, total, rate as number);
  return {
    ok: true,
    doc: {
      ...base,
      lines: rawLines.map(({ tax: _t, ...l }, i) => ({ ...l, amountCents: conv.amounts[i], unitPriceCents: conv.unitPrices[i] })),
      subtotalCents: conv.subtotalCents,
      taxCents: conv.taxCents,
      totalCents: conv.totalCents,
      voided: false,
      fx: { currency, rate: rate as number, totalCents: total, subtotalCents: subtotal, taxCents: tax },
    },
  };
}

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

/** Resolve an invoice line's Xero item / account: exact name match against synced items, else fallbacks. */
export function resolveLineItems(
  lines: InvoiceLine[],
  itemByName: Map<string, string>,
  defaults: Pick<XeroDefaults, 'fallbackItemCode' | 'salesAccountCode'>,
): { ok: true; lines: InvoiceLine[] } | { ok: false; reason: string } {
  const out: InvoiceLine[] = [];
  for (const l of lines) {
    const code = itemByName.get(normText(l.description)) ?? defaults.fallbackItemCode;
    if (code) {
      out.push({ ...l, itemCode: code, accountCode: null });
    } else if (defaults.salesAccountCode) {
      out.push({ ...l, itemCode: null, accountCode: defaults.salesAccountCode });
    } else {
      return { ok: false, reason: `No Xero item or sales account for the line "${l.description.slice(0, 60)}". Choose a sales account under Mapping → Defaults.` };
    }
  }
  return { ok: true, lines: out };
}

export type TaxPlan = { ok: true; taxType: string } | { ok: false; reason: string };
export function planTaxType(taxCents: number, defaults: Pick<XeroDefaults, 'taxType' | 'zeroTaxType'>): TaxPlan {
  if (taxCents > 0) {
    return defaults.taxType ? { ok: true, taxType: defaults.taxType } : { ok: false, reason: 'This invoice has tax. Choose a sales tax rate under Mapping → Defaults.' };
  }
  return { ok: true, taxType: defaults.zeroTaxType ?? 'NONE' };
}

/** Body of a Xero sales invoice. Tax is passed per line (largest-remainder) so Xero's total equals Vireek's exactly. */
export function buildXeroInvoicePayload(
  inv: VireekInvoiceInput,
  contactId: string,
  ctx: { defaults: XeroDefaults; taxType: string },
  existing?: { id: string },
): RawRecord {
  const taxes = allocateCents(inv.taxCents, inv.lines.map((l) => l.amountCents));
  const p: RawRecord = {
    Type: 'ACCREC',
    Contact: { ContactID: contactId },
    Date: inv.issueDate,
    DueDate: inv.dueDate,
    LineAmountTypes: 'Exclusive',
    Status: 'AUTHORISED',
    LineItems: inv.lines.map((l, i) => {
      const exact = Math.abs(l.qty * l.unitPriceCents - l.amountCents) < 0.5;
      return {
        Description: l.description,
        Quantity: exact ? l.qty : 1,
        UnitAmount: exact ? fromCents(l.unitPriceCents) : fromCents(l.amountCents),
        ...(l.itemCode ? { ItemCode: l.itemCode } : {}),
        ...(l.accountCode ? { AccountCode: l.accountCode } : {}),
        TaxType: ctx.taxType,
        TaxAmount: fromCents(taxes[i] ?? 0),
      };
    }),
  };
  if (ctx.defaults.sendInvoiceNumber && !existing) p.InvoiceNumber = inv.invoiceNumber.slice(0, 255);
  if (existing) p.InvoiceID = existing.id;
  return p;
}

// ============================================================
// PAYMENTS
// ============================================================

export interface XeroPaymentDoc {
  id: string;
  invoiceId: string;
  invoiceNumber: string | null;
  date: string | null;
  /** Amount in the INVOICE currency (Xero's `Amount`). */
  amountCents: number;
  accountId: string | null;
  accountCode: string | null;
  accountName: string | null;
  reference: string | null;
  deleted: boolean;
  modifiedAt: number | null;
}
export type PaymentParse = { ok: true; doc: XeroPaymentDoc } | { ok: false; reason: string };

export function parseXeroPayment(raw: RawRecord): PaymentParse {
  const meta = recordMeta('payment', raw);
  if (!meta.id) return { ok: false, reason: 'Payment has no id.' };
  const type = String(raw.PaymentType ?? 'ACCRECPAYMENT');
  if (type !== 'ACCRECPAYMENT') return { ok: false, reason: `Payment type ${type} is not synced (only customer payments on invoices are).` };
  const inv = obj(raw.Invoice);
  const invoiceId = str(inv.InvoiceID);
  if (!invoiceId) return { ok: false, reason: 'Payment is not applied to an invoice.' };
  if (inv.Type !== undefined && inv.Type !== 'ACCREC') return { ok: false, reason: 'Payment is not on a sales invoice.' };
  const account = obj(raw.Account);
  const amountCents = toCents(raw.Amount);
  if (amountCents <= 0) return { ok: false, reason: 'Payment amount is not positive.' };
  return {
    ok: true,
    doc: {
      id: meta.id,
      invoiceId,
      invoiceNumber: str(inv.InvoiceNumber),
      date: xeroDateOnly(raw, 'Date'),
      amountCents,
      accountId: str(account.AccountID),
      accountCode: str(account.Code),
      accountName: str(account.Name),
      reference: str(raw.Reference),
      deleted: String(raw.Status ?? 'AUTHORISED').toUpperCase() === 'DELETED',
      modifiedAt: meta.modifiedAt,
    },
  };
}

export type VireekPaymentMethod = 'card' | 'ach' | 'check' | 'cash' | 'other';
export function paymentMethodFromText(text: string | null): VireekPaymentMethod {
  const n = (text ?? '').toLowerCase();
  if (!n) return 'other';
  if (/check|cheque/.test(n)) return 'check';
  if (/cash|petty/.test(n)) return 'cash';
  if (/stripe|paypal|square|visa|master|amex|american express|discover|card|credit|debit/.test(n)) return 'card';
  if (/ach|bank|echeck|e-check|transfer|eft|direct debit|bacs|sepa/.test(n)) return 'ach';
  return 'other';
}

export type PaymentBase = { ok: true; cents: number; note: string | null } | { ok: false; reason: string };

/**
 * Base-currency cents to apply for a payment. Base-currency invoices: exactly the payment. Foreign
 * invoices: the payment's share of the invoice, valued at the INVOICE rate so the receivable clears
 * exactly in proportion (the realised FX difference is reported, not posted). Rounding dust of up to
 * FX_DUST_CENTS settles the balance.
 */
export function paymentBaseCents(input: {
  amountCents: number;
  fx: FxInfo | null;
  invoiceBaseTotalCents: number;
  remainingBaseCents: number;
}): PaymentBase {
  const { amountCents, fx, invoiceBaseTotalCents, remainingBaseCents } = input;
  if (!fx) {
    return amountCents > remainingBaseCents
      ? { ok: false, reason: `Payment of ${amountCents / 100} exceeds the Vireek balance of ${remainingBaseCents / 100}.` }
      : { ok: true, cents: amountCents, note: null };
  }
  if (fx.totalCents <= 0) return { ok: false, reason: 'The invoice has no foreign-currency total on record.' };
  let cents = Math.round((amountCents * invoiceBaseTotalCents) / fx.totalCents);
  if (cents > remainingBaseCents) {
    if (cents - remainingBaseCents > FX_DUST_CENTS) return { ok: false, reason: `Converted payment of ${cents / 100} exceeds the Vireek balance of ${remainingBaseCents / 100}.` };
    cents = remainingBaseCents;
  } else if (remainingBaseCents - cents <= FX_DUST_CENTS && remainingBaseCents - cents > 0) {
    cents = remainingBaseCents;
  }
  if (cents <= 0) return { ok: false, reason: 'Converted payment rounds to zero.' };
  return { ok: true, cents, note: `${fx.currency} ${(amountCents / 100).toFixed(2)} applied at the invoice rate ${fx.rate}. Realised FX gain or loss is not posted to the ledger.` };
}

export function buildXeroPaymentPayload(input: { invoiceId: string; accountId: string; amountCents: number; date: string; reference: string }): RawRecord {
  return {
    Invoice: { InvoiceID: input.invoiceId },
    Account: { AccountID: input.accountId },
    Date: input.date,
    Amount: fromCents(input.amountCents),
    Reference: input.reference.slice(0, 255),
  };
}

// ============================================================
// TAX RATES (read-only reference data from Xero)
// ============================================================

export interface XeroTaxRate {
  taxType: string;
  name: string;
  effectiveRate: number;
  status: string;
  reportTaxType: string | null;
  canApplyToRevenue: boolean;
  components: { name: string; rate: number; isCompound: boolean; isNonRecoverable: boolean }[];
}

export function parseTaxRate(raw: RawRecord): XeroTaxRate | null {
  const taxType = str(raw.TaxType);
  const name = str(raw.Name);
  if (!taxType || !name || !XERO_TAX_TYPE.test(taxType)) return null;
  const components = arr(raw.TaxComponents).map((c) => ({
    name: str(c.Name) ?? '',
    rate: num(c.Rate) ?? 0,
    isCompound: c.IsCompound === true,
    isNonRecoverable: c.IsNonRecoverable === true,
  }));
  const effective = num(raw.EffectiveRate) ?? num(raw.DisplayTaxRate) ?? components.reduce((s, c) => s + c.rate, 0);
  return {
    taxType,
    name: name.slice(0, 200),
    effectiveRate: Math.round(effective * 10000) / 10000,
    status: String(raw.Status ?? 'ACTIVE').toUpperCase(),
    reportTaxType: str(raw.ReportTaxType),
    canApplyToRevenue: raw.CanApplyToRevenue !== false,
    components,
  };
}

/** Rates that can be chosen for sales invoices: active and applicable to revenue. */
export const selectableSalesTaxRates = (rates: XeroTaxRate[]): XeroTaxRate[] =>
  rates.filter((r) => r.status === 'ACTIVE' && r.canApplyToRevenue).sort((a, b) => a.name.localeCompare(b.name));

/** Human warning when the chosen Xero tax rate disagrees with Vireek's own default rate (percent). */
export function taxRateMismatch(selected: XeroTaxRate | undefined, vireekDefaultPercent: number | null | undefined): string | null {
  if (!selected || vireekDefaultPercent === null || vireekDefaultPercent === undefined || vireekDefaultPercent <= 0) return null;
  return Math.abs(selected.effectiveRate - vireekDefaultPercent) < 0.0001
    ? null
    : `"${selected.name}" is ${selected.effectiveRate}% in Xero but Vireek's default tax rate is ${vireekDefaultPercent}%. Invoices still carry Vireek's tax amount exactly; check this is the rate you want Xero to report.`;
}

// ============================================================
// ORGANISATION + CURRENCIES
// ============================================================

export interface XeroOrganisation {
  name: string;
  legalName: string | null;
  baseCurrency: string;
  countryCode: string | null;
  isDemo: boolean;
  shortCode: string | null;
}
export function parseOrganisation(json: unknown): XeroOrganisation | null {
  const o = arr(obj(json).Organisations)[0];
  if (!o) return null;
  const base = str(o.BaseCurrency)?.toUpperCase();
  const name = str(o.Name) ?? str(o.LegalName);
  if (!base || !/^[A-Z]{3}$/.test(base) || !name) return null;
  return { name, legalName: str(o.LegalName), baseCurrency: base, countryCode: str(o.CountryCode), isDemo: o.IsDemoCompany === true, shortCode: str(o.ShortCode) };
}
export const parseCurrencies = (json: unknown): { code: string; description: string }[] =>
  arr(obj(json).Currencies)
    .map((c) => ({ code: String(c.Code ?? '').toUpperCase(), description: String(c.Description ?? '') }))
    .filter((c) => /^[A-Z]{3}$/.test(c.code));

// ============================================================
// REQUEST BUILDERS + RESPONSE PARSERS
// ============================================================

export interface HttpReq {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
export const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
export const isAllowedXeroUrl = (url: string): boolean => url.startsWith(`${XERO_API_BASE}/`) || url === XERO_CONNECTIONS_URL || url.startsWith(`${XERO_CONNECTIONS_URL}/`);

const PAGED: Record<XeroEntity, boolean> = { account: false, contact: true, item: false, invoice: true, payment: true };
export const isPagedEntity = (e: XeroEntity): boolean => PAGED[e];

export function buildListRequest(c: { entity: XeroEntity; page: number; pageSize: number; modifiedSinceMs: number | null }): HttpReq {
  const meta = ENTITY_META[c.entity];
  const q = new URLSearchParams();
  if (PAGED[c.entity]) {
    q.set('page', String(Math.max(1, Math.floor(c.page))));
    q.set('pageSize', String(Math.min(1000, Math.max(1, Math.floor(c.pageSize)))));
    q.set('order', 'UpdatedDateUTC ASC');
  }
  if (c.entity === 'invoice') {
    q.set('where', 'Type=="ACCREC"');
    q.set('Statuses', 'AUTHORISED,PAID,VOIDED,DELETED');
  } else if (c.entity === 'payment') {
    q.set('where', 'PaymentType=="ACCRECPAYMENT"');
  }
  const qs = q.toString();
  return {
    method: 'GET',
    url: `${XERO_API_BASE}/${meta.xeroPath}${qs ? `?${qs}` : ''}`,
    ...(c.modifiedSinceMs !== null ? { headers: { 'If-Modified-Since': xeroIfModifiedSince(c.modifiedSinceMs) } } : {}),
  };
}

export function buildGetRequest(c: { entity: XeroEntity; id: string }): HttpReq {
  if (!isValidXeroId(c.id)) throw new Error('Invalid Xero id.');
  return { method: 'GET', url: `${XERO_API_BASE}/${ENTITY_META[c.entity].xeroPath}/${c.id}` };
}

/** Case-insensitive text search across name / email (Xero `searchTerm`). Compare results exactly in code. */
export function buildFindContactRequest(term: string): HttpReq {
  const q = new URLSearchParams({ searchTerm: term.slice(0, 255), page: '1', pageSize: '20' });
  return { method: 'GET', url: `${XERO_API_BASE}/Contacts?${q.toString()}` };
}
/** Sales invoices by number. Numbers containing a comma cannot be looked up (Xero splits on commas). */
export const canFindInvoiceNumber = (n: string): boolean => !!n && !n.includes(',') && n.length <= 255;
export function buildFindInvoiceRequest(number: string): HttpReq {
  if (!canFindInvoiceNumber(number)) throw new Error('Unsupported invoice number.');
  const q = new URLSearchParams({ InvoiceNumbers: number, where: 'Type=="ACCREC"', page: '1' });
  return { method: 'GET', url: `${XERO_API_BASE}/Invoices?${q.toString()}` };
}
export const buildItemByCodeRequest = (code: string): HttpReq => {
  if (!XERO_CODE.test(code)) throw new Error('Invalid item code.');
  return { method: 'GET', url: `${XERO_API_BASE}/Items/${encodeURIComponent(code)}` };
};

/** Create (PUT, with Idempotency-Key) or update (POST /<id>). The envelope is always `{ <Plural>: [record] }`. */
export function buildWriteRequest(c: { entity: XeroEntity; payload: RawRecord; id?: string; idempotencyKey?: string }): HttpReq {
  const meta = ENTITY_META[c.entity];
  const headers: Record<string, string> = {};
  if (c.id) {
    if (!isValidXeroId(c.id)) throw new Error('Invalid Xero id.');
    return { method: 'POST', url: `${XERO_API_BASE}/${meta.xeroPath}/${c.id}`, body: { [meta.xeroPath]: [{ ...c.payload, [meta.idKey]: c.id }] } };
  }
  if (isValidIdempotencyKey(c.idempotencyKey)) headers['Idempotency-Key'] = c.idempotencyKey;
  return { method: 'PUT', url: `${XERO_API_BASE}/${meta.xeroPath}`, headers, body: { [meta.xeroPath]: [c.payload] } };
}

export function buildVoidRequest(c: { id: string }): HttpReq {
  return buildWriteRequest({ entity: 'invoice', id: c.id, payload: { Status: 'VOIDED' } });
}

export const buildOrganisationRequest = (): HttpReq => ({ method: 'GET', url: `${XERO_API_BASE}/Organisation` });
export const buildTaxRatesRequest = (): HttpReq => ({ method: 'GET', url: `${XERO_API_BASE}/TaxRates` });
export const buildCurrenciesRequest = (): HttpReq => ({ method: 'GET', url: `${XERO_API_BASE}/Currencies` });

export interface XeroFault {
  code: string;
  message: string;
  detail: string;
}
export type FaultKind = 'ok' | 'validation' | 'duplicate' | 'auth' | 'forbidden' | 'throttle' | 'notfound' | 'error';

export function parseFault(json: unknown): XeroFault | null {
  const j = obj(json);
  const messages: string[] = [];
  for (const el of arr(j.Elements)) for (const v of arr(el.ValidationErrors)) if (str(v.Message)) messages.push(String(v.Message));
  for (const v of arr(j.ValidationErrors)) if (str(v.Message)) messages.push(String(v.Message));
  const type = str(j.Type) ?? str(j.title) ?? str(j.Title);
  const message = str(j.Message) ?? str(j.Detail) ?? str(j.detail) ?? (str(j.error_description) ?? str(j.error));
  if (!messages.length && !type && !message) return null;
  return { code: String(j.ErrorNumber ?? j.Status ?? type ?? ''), message: String(message ?? type ?? '').slice(0, 300), detail: messages.join('; ').slice(0, 500) };
}

export function classifyResponse(status: number, json: unknown): { kind: FaultKind; fault: XeroFault | null } {
  const fault = parseFault(json);
  if (status >= 200 && status < 300 && !(obj(json).Type === 'ValidationException')) return { kind: 'ok', fault: null };
  if (status === 401) return { kind: 'auth', fault };
  if (status === 403) return { kind: /AuthenticationUnsuccessful/i.test(`${fault?.message} ${fault?.detail} ${fault?.code}`) ? 'auth' : 'forbidden', fault };
  if (status === 429) return { kind: 'throttle', fault };
  if (status === 404) return { kind: 'notfound', fault };
  const text = `${fault?.message ?? ''} ${fault?.detail ?? ''}`;
  if (status === 400 || obj(json).Type === 'ValidationException') {
    return { kind: /unique|already (exists|in use|used)|duplicate/i.test(text) ? 'duplicate' : 'validation', fault };
  }
  return { kind: 'error', fault };
}

export interface ListPage {
  records: RawRecord[];
  /** True when a full page came back, so another page may exist (paged entities only). */
  more: boolean;
}
export function parseListResponse(entity: XeroEntity, json: unknown, pageSize: number): ListPage {
  const records = arr(obj(json)[ENTITY_META[entity].xeroPath]);
  return { records, more: PAGED[entity] && records.length >= pageSize };
}
/** First record of `{ <Plural>: [record] }` (create / update / get / find). */
export function parseEntityResponse(entity: XeroEntity, json: unknown): RawRecord | null {
  const r = arr(obj(json)[ENTITY_META[entity].xeroPath])[0];
  return r && r[ENTITY_META[entity].idKey] ? r : null;
}

/** When (if ever) to retry: ms to wait, or null to stop. 429 honours Retry-After up to a cap. */
export const RATE_WAIT_CAP_MS = 45_000;
export function retryDelayMs(input: { status: number | null; attempt: number; retryAfterSec: number | null; maxAttempts?: number }): number | null {
  const max = input.maxAttempts ?? 3;
  if (input.attempt + 1 >= max) return null;
  if (input.status === 429) {
    const wait = (input.retryAfterSec ?? 5 * 2 ** input.attempt) * 1000;
    return wait > RATE_WAIT_CAP_MS ? null : Math.max(500, wait);
  }
  if (input.status === null || [500, 502, 503, 504].includes(input.status)) return Math.min(8000, 800 * 2 ** input.attempt);
  return null;
}
export function parseRetryAfter(v: string | null | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ============================================================
// OAUTH (Xero OAuth 2.0, authorization-code flow)
// ============================================================

export const XERO_AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
export const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
export const XERO_REVOKE_URL = 'https://identity.xero.com/connect/revocation';
/** Granular scopes (required for apps created on/after 2 March 2026; accepted by older apps too). */
export const XERO_SCOPE = 'offline_access accounting.contacts accounting.settings accounting.invoices accounting.payments';
const STATE_TTL_MS = 10 * 60 * 1000;

export function buildAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL(XERO_AUTH_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', XERO_SCOPE);
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
    url: XERO_TOKEN_URL,
    headers: { Authorization: `Basic ${btoa(`${p.clientId}:${p.clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  };
}
export function buildRevokeRequest(p: { clientId: string; clientSecret: string; refreshToken: string }): TokenRequest {
  return {
    url: XERO_REVOKE_URL,
    headers: { Authorization: `Basic ${btoa(`${p.clientId}:${p.clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ token: p.refreshToken }).toString(),
  };
}

export interface ParsedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
  scope: string[];
}
export function parseTokenResponse(json: unknown): ParsedTokens {
  const j = obj(json);
  if (typeof j.access_token !== 'string' || !j.access_token) throw new Error('Token response had no access token.');
  const exp = num(j.expires_in);
  return {
    accessToken: j.access_token,
    refreshToken: typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : null,
    expiresInSec: exp && exp > 0 ? exp : null,
    scope: typeof j.scope === 'string' ? j.scope.split(/\s+/).filter(Boolean) : [],
  };
}

/** Claims of a JWT access token WITHOUT verifying it (it came straight from Xero's token endpoint over TLS). */
export function jwtClaims(token: string): RawRecord {
  try {
    const part = token.split('.')[1];
    return part ? (JSON.parse(new TextDecoder().decode(b64urlDecode(part))) as RawRecord) : {};
  } catch {
    return {};
  }
}

export interface XeroConnectionInfo {
  /** Connection id (used to disconnect). */
  id: string;
  tenantId: string;
  tenantType: string;
  tenantName: string | null;
  authEventId: string | null;
}
export function parseConnections(json: unknown): XeroConnectionInfo[] {
  return (Array.isArray(json) ? (json as RawRecord[]) : [])
    .map((c) => ({
      id: String(c.id ?? ''),
      tenantId: String(c.tenantId ?? ''),
      tenantType: String(c.tenantType ?? ''),
      tenantName: str(c.tenantName),
      authEventId: str(c.authEventId),
    }))
    .filter((c) => isValidXeroId(c.id) && isValidXeroId(c.tenantId) && c.tenantType === 'ORGANISATION');
}

/** Exactly one organisation per Vireek account: pick the one authorised in THIS consent, or report why not. */
export function pickConnection(
  connections: XeroConnectionInfo[],
  authEventId: string | null,
): { ok: true; connection: XeroConnectionInfo; extras: XeroConnectionInfo[] } | { ok: false; reason: 'none' | 'multiple'; extras: XeroConnectionInfo[] } {
  const fresh = authEventId ? connections.filter((c) => c.authEventId === authEventId) : connections;
  if (fresh.length === 0) return { ok: false, reason: 'none', extras: [] };
  if (fresh.length > 1) return { ok: false, reason: 'multiple', extras: fresh };
  return { ok: true, connection: fresh[0], extras: [] };
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
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
  if (!constantTimeEqual(b64url(await hmac(secret, body)), sig)) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as OAuthState;
    if (typeof p.o !== 'string' || typeof p.u !== 'string' || typeof p.n !== 'string') return null;
    if (!Number.isFinite(p.t) || now - p.t > STATE_TTL_MS || p.t - now > 60_000) return null;
    return p;
  } catch {
    return null;
  }
}

/** Xero webhook signature: base64(HMAC-SHA256(webhookKey, rawBody)), compared in constant time. */
export async function verifyWebhookSignature(rawBody: string, signature: string | null, webhookKey: string): Promise<boolean> {
  if (!signature || !webhookKey) return false;
  const expected = btoa(String.fromCharCode(...(await hmac(webhookKey, rawBody))));
  return constantTimeEqual(expected, signature);
}

/** Organisation (tenant) ids named in a Xero webhook payload. An empty list is a valid "intent to receive" probe. */
export function webhookTenants(payload: unknown): string[] {
  const events = arr(obj(payload).events);
  const ids = events.filter((e) => e.tenantType === undefined || e.tenantType === 'ORGANISATION').map((e) => e.tenantId).filter(isValidXeroId);
  return [...new Set(ids)];
}

// ============================================================
// STATS
// ============================================================

export interface SyncStats {
  created_vireek: number;
  updated_vireek: number;
  created_xero: number;
  updated_xero: number;
  skipped: number;
  conflicts: number;
  errors: number;
}
export const emptyStats = (): SyncStats => ({ created_vireek: 0, updated_vireek: 0, created_xero: 0, updated_xero: 0, skipped: 0, conflicts: 0, errors: 0 });
