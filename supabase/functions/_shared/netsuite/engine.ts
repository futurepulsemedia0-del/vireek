// supabase/functions/_shared/netsuite/engine.ts
//
// Vireek <-> Oracle NetSuite sync engine (SuiteTalk REST + Token-Based Authentication).
// Pure and deterministic: NO network, NO database, NO Deno/DOM APIs (only WebCrypto, which exists in
// Deno, browsers and Node 20+). It is imported by the edge functions, by the React client (settings
// catalog for the mapping UI) and by the unit tests. Same shape as the QuickBooks engine on purpose.
//
//   Auth       : TBA credentials validation + OAuth 1.0 HMAC-SHA256 request signing
//   Settings   : per-entity enable / direction / conflict rule / per-field direction + defaults
//   Adapters   : NetSuite record <-> canonical values, invoice + payment parsing and payloads
//   Requests   : SuiteQL / record request builders, externalId upserts, fault classification
//   Merge      : field-level THREE-WAY merge (shared with CRM Sync and QuickBooks)
//
// !! NOT LIVE-VERIFIED !!  Every request shape and record field below follows NetSuite's published
// SuiteTalk REST documentation and is covered by mock tests, but it has NOT been run against a real
// NetSuite account. See NS_VERIFICATION and the "first run" checklist on the NetSuite page.
//
// Integrity rules:
//   1. Nothing from the client ever becomes a table, URL path or query fragment. Every interpolated
//      value is a fixed constant, validated against a strict pattern, or escaped with `nsLiteral`.
//   2. Signed requests are only ever built for https://<account>.suitetalk.api.netsuite.com.
//   3. Money is integer cents on the Vireek side and is converted at the edge only.
//   4. A conflict exists only when BOTH sides changed the same field since the last sync.
//   5. Anything that cannot be represented faithfully (discounts, multi-currency) is reported as
//      "unsupported" with a reason, never guessed.
//   6. Writes use NetSuite externalId upserts (`vk-...`), so a replayed write never duplicates a record.

import {
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
// VERIFICATION LABEL (shown in the UI, the sync log header and the Integrations card)
// ============================================================

export const NS_VERIFICATION = {
  liveVerified: false,
  label: 'Not live-verified',
  detail:
    'This integration follows the NetSuite SuiteTalk REST documentation and is covered by mock tests, but it has not been run against a live NetSuite account yet. Try it in a sandbox account first.',
} as const;

// ============================================================
// TYPES + META
// ============================================================

export const NS_ENTITIES = ['customer', 'item', 'invoice', 'payment'] as const;
export type NsEntity = (typeof NS_ENTITIES)[number];
export type NsEnvironment = 'production' | 'sandbox' | 'release_preview';
export type NsDirection = 'both' | 'to_ns' | 'from_ns';
export type FieldDirection = NsDirection | 'off';
export type NsConflictRule = 'newest_wins' | 'vireek_wins' | 'ns_wins' | 'manual';

export const NS_DIRECTIONS: NsDirection[] = ['both', 'to_ns', 'from_ns'];
export const NS_CONFLICT_RULES: NsConflictRule[] = ['newest_wins', 'vireek_wins', 'ns_wins', 'manual'];

export interface EntityMeta {
  label: string;
  vireekLabel: string;
  nsLabel: string;
  /** Vireek table. */
  table: string;
  /** REST record type used in /services/rest/record/v1/<recordType>. */
  recordType: string;
  hint: string;
}

export const ENTITY_META: Record<NsEntity, EntityMeta> = {
  customer: { label: 'Customers', vireekLabel: 'Customers', nsLabel: 'Customers', table: 'customers', recordType: 'customer', hint: 'Name, email, phone and notes. The billing address is sent once, when Vireek creates the customer in NetSuite.' },
  item: { label: 'Items', vireekLabel: 'Price book', nsLabel: 'Service items', table: 'price_book_items', recordType: 'serviceitem', hint: 'Service items. NetSuite is normally the source of truth for your item list.' },
  invoice: { label: 'Invoices', vireekLabel: 'AR invoices', nsLabel: 'Invoices', table: 'ar_invoices', recordType: 'invoice', hint: 'Invoices, line items, tax and due dates. NetSuite cannot void an invoice over REST, so voids only flow NetSuite → Vireek.' },
  payment: { label: 'Payments', vireekLabel: 'AR payments', nsLabel: 'Customer payments', table: 'ar_payments', recordType: 'customerpayment', hint: 'Customer payments applied to invoices. Payments are never edited, only created.' },
};

export const DIRECTION_META: Record<NsDirection, { label: string }> = {
  both: { label: 'Two-way' },
  to_ns: { label: 'Vireek → NetSuite' },
  from_ns: { label: 'NetSuite → Vireek' },
};

export const CONFLICT_RULE_META: Record<NsConflictRule, { label: string; hint: string }> = {
  newest_wins: { label: 'Newest change wins', hint: 'When both sides edited the same field, keep the most recent edit.' },
  vireek_wins: { label: 'Vireek wins', hint: 'Vireek is the source of truth for conflicting fields.' },
  ns_wins: { label: 'NetSuite wins', hint: 'NetSuite is the source of truth for conflicting fields.' },
  manual: { label: 'Review manually', hint: 'Leave both values untouched and ask me to choose.' },
};

export interface VireekField {
  key: string;
  label: string;
  type: VireekFieldType;
  required?: boolean;
}

export const VIREEK_FIELDS: Record<NsEntity, VireekField[]> = {
  customer: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'phone', label: 'Phone', type: 'phone' },
    { key: 'notes', label: 'Notes', type: 'text' },
  ],
  item: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'description', label: 'Description', type: 'text' },
    { key: 'active', label: 'Active / inactive', type: 'text' },
  ],
  invoice: [
    { key: 'due_date', label: 'Due date', type: 'date' },
    { key: 'amounts', label: 'Line items, tax and total', type: 'text' },
    { key: 'voided', label: 'Void status', type: 'text' },
  ],
  payment: [],
};

export const NS_SUITEQL_PAGE = 200;
/** NetSuite stamps lastModifiedDate in the account's time zone, so the window is wide; unchanged records are skipped cheaply. */
export const PULL_OVERLAP_MS = 26 * 60 * 60 * 1000;
export const PAGE_CAP_PER_RUN = 600;

// ============================================================
// SETTINGS
// ============================================================

export interface EntitySettings {
  enabled: boolean;
  direction: NsDirection;
  conflict: NsConflictRule;
  fields: Record<string, FieldDirection>;
}
export interface NsDefaults {
  /** NetSuite subsidiary internal id (OneWorld accounts only). */
  subsidiaryId: string | null;
  /** NetSuite A/R account internal id for invoices Vireek creates. Optional (NetSuite uses the customer default). */
  arAccountId: string | null;
  /** NetSuite bank / undeposited-funds account for payments Vireek creates. Optional. */
  depositAccountId: string | null;
  /** NetSuite income account for service items Vireek creates. */
  incomeAccountId: string | null;
  /** NetSuite service item used for invoice lines that match no synced item. */
  fallbackItemId: string | null;
  /** NetSuite tax code applied to taxable lines. Optional. */
  taxCodeId: string | null;
  /** Send the Vireek invoice number as the NetSuite transaction number (tranId). */
  sendTranId: boolean;
  /** Send an explicit customer ID (needed when NetSuite uses manual customer numbering). */
  sendEntityId: boolean;
}
export interface NsSettings {
  version: 1;
  entities: Record<NsEntity, EntitySettings>;
  defaults: NsDefaults;
}

const allFields = (entity: NsEntity): Record<string, FieldDirection> =>
  Object.fromEntries(VIREEK_FIELDS[entity].map((f) => [f.key, 'both' as FieldDirection]));

export function defaultSettings(): NsSettings {
  const mk = (direction: NsDirection, conflict: NsConflictRule, entity: NsEntity): EntitySettings => ({ enabled: true, direction, conflict, fields: allFields(entity) });
  return {
    version: 1,
    entities: {
      customer: mk('both', 'newest_wins', 'customer'),
      // NetSuite owns the item list; Vireek only reads it unless the owner opts in.
      item: mk('from_ns', 'ns_wins', 'item'),
      // Money documents never auto-resolve a disagreement.
      invoice: mk('both', 'manual', 'invoice'),
      payment: mk('both', 'manual', 'payment'),
    },
    defaults: { subsidiaryId: null, arAccountId: null, depositAccountId: null, incomeAccountId: null, fallbackItemId: null, taxCodeId: null, sendTranId: true, sendEntityId: false },
  };
}

export const NS_ID = /^\d{1,12}$/;
export const DEFAULT_ID_KEYS = ['subsidiaryId', 'arAccountId', 'depositAccountId', 'incomeAccountId', 'fallbackItemId', 'taxCodeId'] as const;
export const DEFAULT_BOOL_KEYS = ['sendTranId', 'sendEntityId'] as const;

export type SettingsResult = { ok: true; settings: NsSettings } | { ok: false; error: string };

export function validateSettings(input: unknown): SettingsResult {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Settings must be an object.' };
  const src = input as Record<string, unknown>;
  const base = defaultSettings();
  const out: NsSettings = { version: 1, entities: {} as NsSettings['entities'], defaults: { ...base.defaults } };

  const srcEntities = (src.entities ?? {}) as Record<string, unknown>;
  if (typeof srcEntities !== 'object' || srcEntities === null) return { ok: false, error: 'entities must be an object.' };
  for (const entity of NS_ENTITIES) {
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
    if (!NS_DIRECTIONS.includes(direction as NsDirection)) return { ok: false, error: `${label}: unknown sync direction.` };
    if (!NS_CONFLICT_RULES.includes(conflict as NsConflictRule)) return { ok: false, error: `${label}: unknown conflict rule.` };
    const fields: Record<string, FieldDirection> = { ...d.fields };
    const rawFields = (raw.fields ?? {}) as Record<string, unknown>;
    if (typeof rawFields !== 'object' || rawFields === null) return { ok: false, error: `${label}: invalid fields.` };
    for (const [key, dir] of Object.entries(rawFields)) {
      if (!VIREEK_FIELDS[entity].some((f) => f.key === key)) return { ok: false, error: `${label}: unknown field "${key}".` };
      if (dir !== 'off' && !NS_DIRECTIONS.includes(dir as NsDirection)) return { ok: false, error: `${label}: invalid direction for "${key}".` };
      fields[key] = dir as FieldDirection;
    }
    // A required field can never be switched off: a record without it would be invalid.
    for (const f of VIREEK_FIELDS[entity]) {
      if (f.required && fields[f.key] === 'off') return { ok: false, error: `${label}: "${f.label}" is required and cannot be turned off.` };
    }
    out.entities[entity] = { enabled, direction: direction as NsDirection, conflict: conflict as NsConflictRule, fields };
  }

  const dflt = (src.defaults ?? {}) as Record<string, unknown>;
  if (typeof dflt !== 'object' || dflt === null) return { ok: false, error: 'defaults must be an object.' };
  for (const key of DEFAULT_ID_KEYS) {
    const v = dflt[key];
    if (v === undefined) continue;
    if (v === null || v === '') out.defaults[key] = null;
    else if (typeof v === 'string' && NS_ID.test(v)) out.defaults[key] = v;
    else return { ok: false, error: `Invalid value for ${key}.` };
  }
  for (const key of DEFAULT_BOOL_KEYS) {
    const v = dflt[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return { ok: false, error: `${key} must be true or false.` };
    out.defaults[key] = v;
  }
  return { ok: true, settings: out };
}

/** The direction a field really syncs in, after the entity-level direction is applied. */
export function effectiveDirection(entityDir: NsDirection, fieldDir: FieldDirection): FieldDirection {
  if (fieldDir === 'off') return 'off';
  if (entityDir === 'both') return fieldDir;
  if (fieldDir === 'both') return entityDir;
  return fieldDir === entityDir ? fieldDir : 'off';
}
export const canCreateInNs = (es: EntitySettings) => es.enabled && es.direction !== 'from_ns';
export const canCreateInVireek = (es: EntitySettings) => es.enabled && es.direction !== 'to_ns';

// ============================================================
// MERGE (thin wrapper over the shared three-way merge)
// ============================================================

const toCrmDir = (d: FieldDirection): 'both' | 'to_crm' | 'from_crm' => (d === 'to_ns' ? 'to_crm' : d === 'from_ns' ? 'from_crm' : 'both');

export function mergeFieldsFor(entity: NsEntity, es: EntitySettings): MergeField[] {
  const out: MergeField[] = [];
  for (const f of VIREEK_FIELDS[entity]) {
    const dir = effectiveDirection(es.direction, es.fields[f.key] ?? 'both');
    if (dir === 'off') continue;
    out.push({ key: f.key, type: f.type, direction: toCrmDir(dir), required: f.required });
  }
  return out;
}

export function mergeEntity(input: {
  entity: NsEntity;
  settings: EntitySettings;
  base: Canon | null;
  vireek: Canon;
  ns: Canon;
  vireekTs: number | null;
  nsTs: number | null;
  ruleOverride?: 'vireek_wins' | 'ns_wins';
}): MergeResult {
  const rule = input.ruleOverride ?? input.settings.conflict;
  return threeWayMerge({
    fields: mergeFieldsFor(input.entity, input.settings),
    base: input.base,
    vireek: input.vireek,
    crm: input.ns,
    rule: rule === 'ns_wins' ? 'crm_wins' : rule,
    vireekTs: input.vireekTs,
    crmTs: input.nsTs,
  });
}

/** Base snapshot for a record both sides just agreed to link: what each field holds on the side that owns it. */
export function initialBase(entity: NsEntity, es: EntitySettings, vireek: Canon, ns: Canon): Canon {
  const out: Canon = {};
  for (const f of mergeFieldsFor(entity, es)) {
    const v = f.direction === 'from_crm' ? ns[f.key] : vireek[f.key];
    out[f.key] = normalizeValue(f.type, v);
  }
  return out;
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

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const obj = (v: unknown): RawRecord => (v && typeof v === 'object' ? (v as RawRecord) : {});
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
/** NetSuite booleans arrive as true/false or "T"/"F". */
export const nsBool = (v: unknown): boolean => v === true || v === 'T' || v === 'true';
const dateOnly = (v: unknown): string | null => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? ''));
  return m ? m[1] : null;
};
const ref = (v: unknown): { id: string | null; name: string | null } => {
  const o = obj(v);
  return { id: str(o.id), name: str(o.refName) };
};

/** SuiteQL string literal: single quotes are doubled. */
export const nsLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export const isValidNsId = (s: unknown): s is string => typeof s === 'string' && NS_ID.test(s);

export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

export type ExtKind = 'c' | 't' | 'i' | 'p';
/** Deterministic NetSuite externalId for a Vireek record: the key that makes every create idempotent. */
export function externalIdFor(kind: ExtKind, vireekId: string): string {
  const hex = vireekId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('Invalid Vireek id.');
  return `vk-${kind}-${hex}`;
}
export const isValidExternalId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s);

export function recordMeta(raw: RawRecord): { id: string; modifiedAt: number | null } {
  return { id: String(raw.id ?? ''), modifiedAt: parseTimestamp(raw.lastModifiedDate) };
}

// ============================================================
// NETSUITE RECORD <-> CANONICAL (customers, items)
// ============================================================

export function nsToCanon(entity: 'customer' | 'item', raw: RawRecord): Canon {
  if (entity === 'customer') {
    const person = nsBool(raw.isPerson);
    const personName = [str(raw.firstName), str(raw.lastName)].filter(Boolean).join(' ') || null;
    return {
      name: (person ? personName : str(raw.companyName)) ?? str(raw.companyName) ?? personName ?? str(raw.entityId),
      email: str(raw.email),
      phone: str(raw.phone),
      notes: str(raw.comments),
    };
  }
  return {
    name: str(raw.itemId),
    description: str(raw.description) ?? str(raw.displayName),
    active: nsBool(raw.isInactive) ? 'inactive' : 'active',
  };
}

export interface PayloadCtx {
  defaults: NsDefaults;
  /** The record being updated is a person (firstName / lastName) rather than a company. */
  isPerson?: boolean;
}

/** Fields (in `values`) to write to NetSuite. For creates pass every mapped field. */
export function canonToNs(entity: 'customer' | 'item', values: Canon, ctx: PayloadCtx, create: boolean): RawRecord {
  const p: RawRecord = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(values, k);
  if (entity === 'customer') {
    if (has('name') && values.name) {
      const name = String(values.name).slice(0, 83);
      if (ctx.isPerson) {
        const { first, last } = splitName(name);
        p.firstName = first.slice(0, 32);
        p.lastName = last.slice(0, 32);
      } else {
        p.companyName = name;
      }
    }
    if (has('email')) p.email = values.email ? String(values.email).slice(0, 254) : null;
    if (has('phone')) p.phone = values.phone ? String(values.phone).slice(0, 32) : null;
    if (has('notes')) p.comments = values.notes ? String(values.notes).slice(0, 4000) : null;
    if (create) {
      p.isPerson = !!ctx.isPerson;
      if (ctx.defaults.subsidiaryId) p.subsidiary = { id: ctx.defaults.subsidiaryId };
    }
    return p;
  }
  if (has('name') && values.name) p.itemId = String(values.name).replace(/\s+/g, ' ').trim().slice(0, 60);
  if (has('description')) p.description = values.description ? String(values.description).slice(0, 4000) : null;
  if (has('active')) p.isInactive = values.active === 'inactive';
  if (create) {
    if (ctx.defaults.incomeAccountId) p.incomeAccount = { id: ctx.defaults.incomeAccountId };
    if (ctx.defaults.subsidiaryId) p.subsidiary = { items: [{ id: ctx.defaults.subsidiaryId }] };
    p.includeChildren = true;
  }
  return p;
}

/** One-time billing address for a customer Vireek creates in NetSuite (address book is never re-synced). */
export function customerAddressPayload(address: string | null | undefined): RawRecord | null {
  const a = (address ?? '').replace(/\s+/g, ' ').trim();
  if (!a) return null;
  return { addressBook: { items: [{ defaultBilling: true, defaultShipping: true, addressBookAddress: { addr1: a.slice(0, 150), country: { id: 'US' } } }] } };
}

/** Customer ID for accounts that use manual numbering: readable, unique per Vireek record. */
export const customerEntityId = (name: string, vireekId: string): string => `${name.replace(/\s+/g, ' ').trim().slice(0, 70)} ${vireekId.replace(/-/g, '').slice(0, 8)}`;

/** Item type Vireek can represent as a price book entry: service items only. */
export const isSyncableItem = (raw: RawRecord): boolean => raw.itemType === undefined || /service/i.test(String(raw.itemType));

/** Best-effort single-line address from NetSuite's formatted default address (used only when Vireek creates a customer). */
export function addressFromDefault(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines.join(', ').slice(0, 500) : null;
}

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
export interface NsInvoiceDoc {
  id: string;
  tranId: string | null;
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
export type InvoiceParse = { ok: true; doc: NsInvoiceDoc } | { ok: false; reason: string };

const isVoided = (raw: RawRecord): boolean => nsBool(raw.voided) || /void/i.test(String(obj(raw.status).refName ?? raw.status ?? ''));

export function parseNsInvoice(raw: RawRecord): InvoiceParse {
  const m = recordMeta(raw);
  if (!isValidNsId(m.id)) return { ok: false, reason: 'Invoice has no id.' };
  const cur = ref(raw.currency);
  if (cur.name && cur.name !== 'USD') return { ok: false, reason: `Currency ${cur.name} is not supported (Vireek ledgers are single-currency).` };
  const base = {
    id: m.id,
    tranId: str(raw.tranId),
    customerId: ref(raw.entity).id,
    txnDate: dateOnly(raw.tranDate),
    dueDate: dateOnly(raw.dueDate),
    modifiedAt: m.modifiedAt,
  };
  if (isVoided(raw)) return { ok: true, doc: { ...base, lines: [], subtotalCents: 0, taxCents: 0, totalCents: 0, balanceCents: 0, voided: true } };

  const rawLines = Array.isArray(obj(raw.item).items) ? (obj(raw.item).items as RawRecord[]) : null;
  if (!rawLines) return { ok: false, reason: 'Invoice lines were not returned by NetSuite.' };
  const lines: InvoiceLine[] = [];
  for (const l of rawLines) {
    const item = ref(l.item);
    const amountCents = toCents(l.amount);
    const qty = num(l.quantity) ?? 1;
    const rate = num(l.rate);
    if (amountCents < 0) return { ok: false, reason: 'Negative lines (discounts) are not supported.' };
    lines.push({
      description: (str(l.description) ?? item.name ?? 'Item').slice(0, 1000),
      qty,
      unitPriceCents: rate !== null ? toCents(rate) : qty ? Math.round(amountCents / qty) : amountCents,
      amountCents,
      itemId: item.id,
    });
  }
  if (lines.length === 0) return { ok: false, reason: 'Invoice has no lines.' };
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const taxCents = toCents(raw.taxTotal ?? 0);
  const totalCents = toCents(raw.total);
  if (subtotalCents + taxCents !== totalCents) return { ok: false, reason: 'Totals do not add up (header discount, rounding or tax setup on the NetSuite side).' };
  return { ok: true, doc: { ...base, lines, subtotalCents, taxCents, totalCents, balanceCents: toCents(raw.amountRemaining ?? 0), voided: false } };
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

/** Resolve an invoice line's NetSuite item: exact name match against synced items, else the fallback. */
export function resolveLineItems(lines: InvoiceLine[], itemByName: Map<string, string>, fallbackItemId: string | null): { ok: true; lines: InvoiceLine[] } | { ok: false; reason: string } {
  const out: InvoiceLine[] = [];
  for (const l of lines) {
    const id = itemByName.get(normText(l.description)) ?? fallbackItemId;
    if (!id) return { ok: false, reason: `No NetSuite item for the line "${l.description.slice(0, 60)}". Choose a fallback item under Mapping → Defaults.` };
    out.push({ ...l, itemId: id });
  }
  return { ok: true, lines: out };
}

function invoiceLinesPayload(inv: VireekInvoiceInput, defaults: NsDefaults): RawRecord {
  return {
    items: inv.lines.map((l) => {
      const exact = Math.abs(l.qty * l.unitPriceCents - l.amountCents) < 0.5;
      return {
        item: { id: l.itemId },
        description: l.description.slice(0, 4000),
        quantity: exact ? l.qty : 1,
        rate: exact ? fromCents(l.unitPriceCents) : fromCents(l.amountCents),
        amount: fromCents(l.amountCents),
        ...(inv.taxCents > 0 && defaults.taxCodeId ? { taxCode: { id: defaults.taxCodeId } } : {}),
      };
    }),
  };
}

/** Body for creating an invoice (PUT to the externalId URL). */
export function buildNsInvoiceCreate(inv: VireekInvoiceInput, customerId: string, defaults: NsDefaults): RawRecord {
  const p: RawRecord = {
    entity: { id: customerId },
    tranDate: inv.issueDate,
    dueDate: inv.dueDate,
    memo: `Vireek invoice ${inv.invoiceNumber}`.slice(0, 999),
    item: invoiceLinesPayload(inv, defaults),
  };
  if (defaults.subsidiaryId) p.subsidiary = { id: defaults.subsidiaryId };
  if (defaults.arAccountId) p.account = { id: defaults.arAccountId };
  if (defaults.sendTranId) p.tranId = inv.invoiceNumber.slice(0, 45);
  return p;
}

/** Body for PATCHing an existing invoice. `replace` tells NetSuite to replace the whole item sublist. */
export function buildNsInvoicePatch(inv: VireekInvoiceInput, defaults: NsDefaults, parts: { amounts: boolean; due: boolean }): { body: RawRecord; replace: string | null } {
  const body: RawRecord = {};
  if (parts.due) body.dueDate = inv.dueDate;
  if (parts.amounts) {
    body.tranDate = inv.issueDate;
    body.item = invoiceLinesPayload(inv, defaults);
  }
  return { body, replace: parts.amounts ? 'item' : null };
}

// ============================================================
// PAYMENTS
// ============================================================

export interface NsPaymentDoc {
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

export function parseNsPayment(raw: RawRecord): NsPaymentDoc | null {
  const m = recordMeta(raw);
  if (!isValidNsId(m.id)) return null;
  const apps: { invoiceId: string; amountCents: number }[] = [];
  const items = Array.isArray(obj(raw.apply).items) ? (obj(raw.apply).items as RawRecord[]) : [];
  for (const l of items) {
    if (!nsBool(l.apply)) continue;
    const invoiceId = ref(l.doc).id;
    const amountCents = toCents(l.amount);
    if (invoiceId && isValidNsId(invoiceId) && amountCents > 0) apps.push({ invoiceId, amountCents });
  }
  return {
    id: m.id,
    customerId: ref(raw.customer).id,
    totalCents: toCents(raw.payment ?? raw.total),
    txnDate: dateOnly(raw.tranDate),
    depositAccountId: ref(raw.account).id,
    methodName: ref(raw.paymentMethod).name,
    applications: apps,
    voided: isVoided(raw),
    modifiedAt: m.modifiedAt,
  };
}

export type VireekPaymentMethod = 'card' | 'ach' | 'check' | 'cash' | 'other';
export function paymentMethodFromName(name: string | null): VireekPaymentMethod {
  const n = (name ?? '').toLowerCase();
  if (!n) return 'other';
  if (/check|cheque/.test(n)) return 'check';
  if (/cash/.test(n)) return 'cash';
  if (/ach|bank|echeck|e-check|transfer|wire/.test(n)) return 'ach';
  if (/visa|master|amex|american express|discover|card|credit|debit/.test(n)) return 'card';
  return 'other';
}

export function buildNsPaymentCreate(input: { customerId: string; invoiceId: string; amountCents: number; date: string; accountId: string | null; subsidiaryId: string | null; note: string }): RawRecord {
  const p: RawRecord = {
    customer: { id: input.customerId },
    tranDate: input.date,
    payment: fromCents(input.amountCents),
    memo: input.note.slice(0, 999),
    apply: { items: [{ doc: { id: input.invoiceId }, apply: true, amount: fromCents(input.amountCents) }] },
  };
  if (input.accountId) p.account = { id: input.accountId };
  if (input.subsidiaryId) p.subsidiary = { id: input.subsidiaryId };
  return p;
}

/** Stable key for one payment-to-invoice application (a NetSuite payment can pay several invoices). */
export const paymentLinkKey = (paymentId: string, invoiceId: string) => `${paymentId}:${invoiceId}`;

// ============================================================
// ACCOUNT ID + HOSTS
// ============================================================

/** NetSuite account id: digits (production), TSTDRV123456 (trial) or 1234567_SB1 / 1234567_RP1 (sandbox / release preview). */
export const NS_ACCOUNT_ID = /^[A-Za-z0-9]{3,24}([_-](SB|RP)[0-9]{1,2})?$/i;
export const isValidAccountId = (s: unknown): s is string => typeof s === 'string' && NS_ACCOUNT_ID.test(s.trim());

/** Canonical form used in the OAuth realm and in the database: upper case, underscore. */
export const normalizeAccountId = (s: string): string => s.trim().toUpperCase().replace(/-/g, '_');
export const accountHost = (accountId: string): string => `${normalizeAccountId(accountId).toLowerCase().replace(/_/g, '-')}.suitetalk.api.netsuite.com`;
export const apiBaseFor = (accountId: string): string => `https://${accountHost(accountId)}`;
export const isAllowedApiBase = (url: string): boolean => /^https:\/\/[a-z0-9-]{3,40}\.suitetalk\.api\.netsuite\.com$/.test(url.replace(/\/+$/, ''));
export function environmentFor(accountId: string): NsEnvironment {
  const a = normalizeAccountId(accountId);
  if (/_SB\d*$/.test(a)) return 'sandbox';
  if (/_RP\d*$/.test(a)) return 'release_preview';
  return 'production';
}

// ============================================================
// REQUEST BUILDERS + RESPONSE PARSERS
// ============================================================

export interface HttpReq {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

const REST = '/services/rest';
const RECORD_TYPES = new Set(Object.values(ENTITY_META).map((m) => m.recordType));

export function buildSuiteQlRequest(c: { base: string; q: string; limit: number; offset: number }): HttpReq {
  const limit = Math.min(1000, Math.max(1, Math.floor(c.limit)));
  const offset = Math.max(0, Math.floor(c.offset));
  return { method: 'POST', url: `${c.base.replace(/\/+$/, '')}${REST}/query/v1/suiteql?limit=${limit}&offset=${offset}`, headers: { Prefer: 'transient' }, body: { q: c.q } };
}

/** SuiteQL listing records changed since a date (date only: time zones make anything finer unreliable). */
export function changedIdsQuery(entity: NsEntity, sinceMs: number | null): string {
  const where: string[] = [];
  if (entity === 'item') where.push("itemType = 'Service'");
  if (entity === 'invoice') where.push("type = 'CustInvc'");
  if (entity === 'payment') where.push("type = 'CustPymt'");
  if (sinceMs !== null) where.push(`lastModifiedDate >= TO_DATE('${new Date(sinceMs).toISOString().slice(0, 10)}', 'YYYY-MM-DD')`);
  const table = entity === 'invoice' || entity === 'payment' ? 'transaction' : entity;
  return `SELECT id, lastModifiedDate FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY lastModifiedDate, id`;
}

export type FindField = 'externalId' | 'email' | 'name' | 'tranId';

const FIND_ALLOWED: Record<FindField, NsEntity[]> = {
  externalId: ['customer', 'item', 'invoice', 'payment'],
  email: ['customer'],
  name: ['customer', 'item'],
  tranId: ['invoice'],
};

/** Look up an existing NetSuite record by one exact value (link instead of creating a duplicate). */
export function findQuery(entity: NsEntity, field: FindField, value: string): string {
  if (!FIND_ALLOWED[field].includes(entity)) throw new Error('Unsupported lookup.');
  const v = nsLiteral(value);
  const table = entity === 'invoice' || entity === 'payment' ? 'transaction' : entity;
  const type = entity === 'invoice' ? " AND type = 'CustInvc'" : entity === 'payment' ? " AND type = 'CustPymt'" : entity === 'item' ? " AND itemType = 'Service'" : '';
  const cond =
    field === 'externalId' ? `externalId = ${v}`
    : field === 'email' ? `LOWER(email) = LOWER(${v})`
    : field === 'tranId' ? `tranId = ${v}`
    : entity === 'customer' ? `LOWER(companyName) = LOWER(${v})`
    : `LOWER(itemId) = LOWER(${v})`;
  return `SELECT id FROM ${table} WHERE ${cond}${type} FETCH FIRST 5 ROWS ONLY`;
}

export function buildGetRequest(c: { base: string; entity: NsEntity; id: string }): HttpReq {
  if (!isValidNsId(c.id)) throw new Error('Invalid NetSuite id.');
  return { method: 'GET', url: `${c.base.replace(/\/+$/, '')}${REST}/record/v1/${ENTITY_META[c.entity].recordType}/${c.id}?expandSubResources=true` };
}

/** PUT to the externalId URL: creates the record, or updates the one that already carries that id. Idempotent. */
export function buildUpsertRequest(c: { base: string; entity: NsEntity; externalId: string; payload: RawRecord }): HttpReq {
  if (!isValidExternalId(c.externalId)) throw new Error('Invalid external id.');
  return { method: 'PUT', url: `${c.base.replace(/\/+$/, '')}${REST}/record/v1/${ENTITY_META[c.entity].recordType}/eid:${c.externalId}`, body: c.payload };
}

export function buildPatchRequest(c: { base: string; entity: NsEntity; id: string; payload: RawRecord; replace?: string | null }): HttpReq {
  if (!isValidNsId(c.id)) throw new Error('Invalid NetSuite id.');
  if (c.replace && !/^[a-zA-Z]{1,30}$/.test(c.replace)) throw new Error('Invalid sublist.');
  return { method: 'PATCH', url: `${c.base.replace(/\/+$/, '')}${REST}/record/v1/${ENTITY_META[c.entity].recordType}/${c.id}${c.replace ? `?replace=${c.replace}` : ''}`, body: c.payload };
}

export const isRecordType = (s: string): boolean => RECORD_TYPES.has(s);

/** Internal id from a create / update response (`Location: .../record/v1/customer/1234`). */
export function idFromLocation(location: string | null | undefined): string | null {
  const m = /\/(\d{1,12})(?:[?#].*)?$/.exec(location ?? '');
  return m ? m[1] : null;
}

export type FaultKind = 'ok' | 'auth' | 'permission' | 'throttle' | 'notfound' | 'validation' | 'conflict' | 'error';
export interface NsFault {
  code: string;
  message: string;
}

export function parseFault(json: unknown): NsFault | null {
  const j = obj(json);
  const details = Array.isArray(j['o:errorDetails']) ? (j['o:errorDetails'] as RawRecord[]) : [];
  const d = details[0] ?? {};
  const code = str(d['o:errorCode']) ?? str(j['o:errorCode']) ?? '';
  const message = str(d.detail) ?? str(j.detail) ?? str(j.title) ?? str(j.error_description) ?? '';
  if (!code && !message) return null;
  return { code, message: message.slice(0, 400) };
}

export function classifyResponse(status: number, json: unknown): { kind: FaultKind; fault: NsFault | null } {
  const fault = parseFault(json);
  if (status >= 200 && status < 300) return { kind: 'ok', fault: null };
  if (status === 401 || /INVALID_LOGIN|INVALID_LOGIN_ATTEMPT|INVALID_SIGNATURE/i.test(fault?.code ?? '')) return { kind: 'auth', fault };
  if (status === 403 || /INSUFFICIENT_PERMISSION|USER_ERROR_PERMISSION|ACCESS_DENIED/i.test(fault?.code ?? '')) return { kind: 'permission', fault };
  if (status === 429 || /CONCURRENCY_LIMIT/i.test(fault?.code ?? '')) return { kind: 'throttle', fault };
  if (status === 404) return { kind: 'notfound', fault };
  if (status === 409) return { kind: 'conflict', fault };
  if (status === 400 || status === 422) return { kind: 'validation', fault };
  return { kind: 'error', fault };
}

export interface SuiteQlPage {
  rows: RawRecord[];
  hasMore: boolean;
}
export function parseSuiteQlResponse(json: unknown): SuiteQlPage {
  const j = obj(json);
  const rows = Array.isArray(j.items) ? (j.items as RawRecord[]) : [];
  return { rows, hasMore: j.hasMore === true };
}

// ============================================================
// AUTHENTICATION: Token-Based Authentication (OAuth 1.0, HMAC-SHA256)
// ============================================================

export interface NsCredentials {
  accountId: string;
  consumerKey: string;
  consumerSecret: string;
  tokenId: string;
  tokenSecret: string;
}

const TBA_SECRET = /^[A-Za-z0-9]{16,128}$/;

export type CredentialsResult = { ok: true; credentials: NsCredentials } | { ok: false; error: string };

export function validateCredentials(input: unknown): CredentialsResult {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Credentials are required.' };
  const s = input as Record<string, unknown>;
  const get = (k: string) => (typeof s[k] === 'string' ? (s[k] as string).trim() : '');
  const accountId = get('accountId');
  if (!isValidAccountId(accountId)) return { ok: false, error: 'Account ID looks wrong. Use the ID from Setup → Company → Company Information, e.g. 1234567 or 1234567_SB1.' };
  const fields: [keyof NsCredentials, string][] = [
    ['consumerKey', 'Consumer key'],
    ['consumerSecret', 'Consumer secret'],
    ['tokenId', 'Token ID'],
    ['tokenSecret', 'Token secret'],
  ];
  const out: Partial<NsCredentials> = { accountId: normalizeAccountId(accountId) };
  for (const [k, label] of fields) {
    const v = get(k);
    if (!TBA_SECRET.test(v)) return { ok: false, error: `${label} looks wrong. Copy it exactly as NetSuite showed it (letters and digits only).` };
    out[k] = v;
  }
  return { ok: true, credentials: out as NsCredentials };
}

/** RFC 3986 percent-encoding (stricter than encodeURIComponent). */
export const pctEncode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

async function hmacSha256B64(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)));
  let bin = '';
  for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]);
  return btoa(bin);
}

export const newNonce = (): string => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

/** `Authorization` header for one request. The JSON body is not part of the signature; query parameters are. */
export async function signRequest(
  method: string,
  url: string,
  creds: NsCredentials,
  opts: { timestamp?: number; nonce?: string } = {},
): Promise<string> {
  const u = new URL(url);
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: opts.nonce ?? newNonce(),
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(opts.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: creds.tokenId,
    oauth_version: '1.0',
  };
  const pairs: [string, string][] = Object.entries(oauth).map(([k, v]) => [pctEncode(k), pctEncode(v)]);
  for (const [k, v] of u.searchParams.entries()) pairs.push([pctEncode(k), pctEncode(v)]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const paramString = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const baseString = `${method.toUpperCase()}&${pctEncode(baseUrl)}&${pctEncode(paramString)}`;
  const signature = await hmacSha256B64(`${pctEncode(creds.consumerSecret)}&${pctEncode(creds.tokenSecret)}`, baseString);
  const header = [`realm="${normalizeAccountId(creds.accountId)}"`, ...Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${k}="${pctEncode(v)}"`)];
  return `OAuth ${header.join(', ')}`;
}

// ============================================================
// STATS
// ============================================================

export interface SyncStats {
  created_vireek: number;
  updated_vireek: number;
  created_ns: number;
  updated_ns: number;
  skipped: number;
  conflicts: number;
  errors: number;
}
export const emptyStats = (): SyncStats => ({ created_vireek: 0, updated_vireek: 0, created_ns: 0, updated_ns: 0, skipped: 0, conflicts: 0, errors: 0 });

export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const NS_CANNOT_VOID_REASON =
  'Voided in Vireek, but NetSuite cannot void an invoice over REST. Void it in NetSuite (Transactions → Void), then run the sync again.';
