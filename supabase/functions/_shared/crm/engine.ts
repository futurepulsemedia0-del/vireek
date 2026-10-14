// supabase/functions/_shared/crm/engine.ts
//
// Vireek CRM Sync engine (Salesforce, Pipedrive, Zoho CRM): pure, deterministic,
// NO network, NO database, NO Deno/DOM APIs (only WebCrypto, available in Deno,
// browsers and Node 20+). It is imported by the edge functions AND by the
// React client (field catalogs for the mapping UI) AND by the unit tests, so it
// must stay a single self-contained file (no relative imports).
//
//   OAuth      : signed state, PKCE, token request/response shapes, host allow-lists
//   Secrets    : AES-GCM encryption for tokens at rest
//   Mapping    : Vireek field <-> CRM field catalogs, validation, defaults
//   Adapters   : raw CRM record <-> canonical record, request builders, response parsers
//   Merge      : field-level THREE-WAY merge with explicit conflict rules
//
// Integrity rules:
//   1. A client can never name an arbitrary table, column or API path. Custom CRM
//      field names are validated against a strict pattern BEFORE they are ever
//      interpolated into a SOQL query / `fields=` list.
//   2. Every host we send a bearer token or client secret to is checked against
//      an allow-list (SSRF / credential-leak protection).
//   3. Equality is decided on NORMALISED values (case-folded emails, digits-only
//      phones, 2-dp numbers) so formatting differences never cause write loops.
//   4. A conflict is only a conflict when BOTH sides changed the same field since
//      the last sync (the stored base snapshot); everything else merges silently.

// ============================================================
// TYPES
// ============================================================

export type CrmProvider = 'salesforce' | 'pipedrive' | 'zoho';
export type CrmEntity = 'contact' | 'lead' | 'deal';
export type ConflictRule = 'newest_wins' | 'vireek_wins' | 'crm_wins' | 'manual';
export type SyncDirection = 'both' | 'to_crm' | 'from_crm';
export type CanonValue = string | number | null;
export type Canon = Record<string, CanonValue>;
export type VireekFieldType = 'text' | 'email' | 'phone' | 'number' | 'date' | 'status';

export const CRM_PROVIDERS: CrmProvider[] = ['salesforce', 'pipedrive', 'zoho'];
export const CRM_ENTITIES: CrmEntity[] = ['contact', 'lead', 'deal'];
export const CONFLICT_RULES: ConflictRule[] = ['newest_wins', 'vireek_wins', 'crm_wins', 'manual'];
export const SYNC_DIRECTIONS: SyncDirection[] = ['both', 'to_crm', 'from_crm'];

export const PROVIDER_META: Record<CrmProvider, { label: string; tagline: string }> = {
  salesforce: { label: 'Salesforce', tagline: 'Sync contacts, leads and opportunities with Salesforce.' },
  pipedrive: { label: 'Pipedrive', tagline: 'Sync people, leads and deals with Pipedrive.' },
  zoho: { label: 'Zoho CRM', tagline: 'Sync contacts, leads and deals with Zoho CRM.' },
};

export const ENTITY_META: Record<CrmEntity, { label: string; vireekLabel: string; table: string; crmLabel: Record<CrmProvider, string> }> = {
  contact: { label: 'Contacts', vireekLabel: 'Customers', table: 'customers', crmLabel: { salesforce: 'Contacts', pipedrive: 'People', zoho: 'Contacts' } },
  lead: { label: 'Leads', vireekLabel: 'Leads', table: 'leads', crmLabel: { salesforce: 'Leads', pipedrive: 'Leads', zoho: 'Leads' } },
  deal: { label: 'Deals', vireekLabel: 'Deals', table: 'crm_deals', crmLabel: { salesforce: 'Opportunities', pipedrive: 'Deals', zoho: 'Deals' } },
};

export const CONFLICT_RULE_META: Record<ConflictRule, { label: string; hint: string }> = {
  newest_wins: { label: 'Newest change wins', hint: 'When both sides edited the same field, keep the most recent edit.' },
  vireek_wins: { label: 'Vireek wins', hint: 'Vireek is the source of truth for conflicting fields.' },
  crm_wins: { label: 'CRM wins', hint: 'Your CRM is the source of truth for conflicting fields.' },
  manual: { label: 'Review manually', hint: 'Leave both values untouched and ask me to choose.' },
};

export const DIRECTION_META: Record<SyncDirection, { label: string }> = {
  both: { label: 'Two-way' },
  to_crm: { label: 'Vireek → CRM' },
  from_crm: { label: 'CRM → Vireek' },
};

// ============================================================
// VIREEK FIELD CATALOG
// ============================================================

export interface VireekField {
  key: string;
  label: string;
  type: VireekFieldType;
  required?: boolean;
}

export const VIREEK_FIELDS: Record<CrmEntity, VireekField[]> = {
  contact: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'phone', label: 'Phone', type: 'phone' },
    { key: 'address', label: 'Address', type: 'text' },
    { key: 'notes', label: 'Notes', type: 'text' },
  ],
  lead: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'phone', label: 'Phone', type: 'phone' },
    { key: 'service_interested', label: 'Service interested', type: 'text' },
    { key: 'notes', label: 'Notes', type: 'text' },
    { key: 'quote_amount', label: 'Quote amount', type: 'number' },
  ],
  deal: [
    { key: 'title', label: 'Title', type: 'text', required: true },
    { key: 'amount', label: 'Amount', type: 'number' },
    { key: 'currency', label: 'Currency', type: 'text' },
    { key: 'status', label: 'Status (open / won / lost)', type: 'status' },
    { key: 'stage', label: 'Stage', type: 'text' },
    { key: 'close_date', label: 'Close date', type: 'date' },
  ],
};

export function vireekField(entity: CrmEntity, key: string): VireekField | undefined {
  return VIREEK_FIELDS[entity].find((f) => f.key === key);
}

// ============================================================
// CRM FIELD CATALOGS  (keys starting with "__" are virtual / composite)
// ============================================================

export interface CrmFieldDef {
  key: string;
  label: string;
  /** Can never be written to the CRM (derived). */
  readonly?: boolean;
}

export const CRM_CATALOG: Record<CrmProvider, Record<CrmEntity, CrmFieldDef[]>> = {
  salesforce: {
    contact: [
      { key: '__full_name', label: 'Name (First + Last)' },
      { key: 'Email', label: 'Email' },
      { key: 'Phone', label: 'Phone' },
      { key: 'MobilePhone', label: 'Mobile phone' },
      { key: '__mailing_address', label: 'Mailing address' },
      { key: 'Description', label: 'Description' },
    ],
    lead: [
      { key: '__full_name', label: 'Name (First + Last)' },
      { key: 'Email', label: 'Email' },
      { key: 'Phone', label: 'Phone' },
      { key: 'MobilePhone', label: 'Mobile phone' },
      { key: '__street_address', label: 'Address' },
      { key: 'Description', label: 'Description' },
    ],
    deal: [
      { key: 'Name', label: 'Opportunity name' },
      { key: 'Amount', label: 'Amount' },
      { key: 'CloseDate', label: 'Close date' },
      { key: 'StageName', label: 'Stage' },
      { key: '__status', label: 'Status (from stage)' },
      { key: 'Description', label: 'Description' },
    ],
  },
  pipedrive: {
    contact: [
      { key: 'name', label: 'Name' },
      { key: '__primary_email', label: 'Email (primary)' },
      { key: '__primary_phone', label: 'Phone (primary)' },
    ],
    lead: [
      { key: 'title', label: 'Lead title' },
      { key: '__lead_amount', label: 'Value' },
    ],
    deal: [
      { key: 'title', label: 'Deal title' },
      { key: 'value', label: 'Value' },
      { key: 'currency', label: 'Currency' },
      { key: 'status', label: 'Status' },
      { key: 'expected_close_date', label: 'Expected close date' },
    ],
  },
  zoho: {
    contact: [
      { key: '__full_name', label: 'Name (First + Last)' },
      { key: 'Email', label: 'Email' },
      { key: 'Phone', label: 'Phone' },
      { key: 'Mobile', label: 'Mobile' },
      { key: '__mailing_address', label: 'Mailing address' },
      { key: 'Description', label: 'Description' },
    ],
    lead: [
      { key: '__full_name', label: 'Name (First + Last)' },
      { key: 'Email', label: 'Email' },
      { key: 'Phone', label: 'Phone' },
      { key: 'Mobile', label: 'Mobile' },
      { key: '__street_address', label: 'Address' },
      { key: 'Description', label: 'Description' },
    ],
    deal: [
      { key: 'Deal_Name', label: 'Deal name' },
      { key: 'Amount', label: 'Amount' },
      { key: 'Stage', label: 'Stage' },
      { key: 'Closing_Date', label: 'Closing date' },
      { key: '__status', label: 'Status (from stage)' },
      { key: 'Description', label: 'Description' },
    ],
  },
};

/** What each provider lets us do. Pipedrive Leads can't be created without a person. */
export const CRM_CAPS: Record<CrmProvider, Record<CrmEntity, { create: boolean }>> = {
  salesforce: { contact: { create: true }, lead: { create: true }, deal: { create: true } },
  pipedrive: { contact: { create: true }, lead: { create: false }, deal: { create: true } },
  zoho: { contact: { create: true }, lead: { create: true }, deal: { create: true } },
};

/** Updates must start from the live record (multi-value / nested fields). */
export function needsFetchBeforeUpdate(provider: CrmProvider, entity: CrmEntity): boolean {
  return provider === 'pipedrive' && (entity === 'contact' || entity === 'lead');
}

/** Custom CRM API names: letters/digits/underscore only (SOQL-safe, Pipedrive hash keys OK). */
export const CUSTOM_CRM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

// ============================================================
// SETTINGS (per connection)
// ============================================================

export interface FieldMapping {
  vireek: string;
  crm: string;
  direction: SyncDirection;
}
export interface EntitySettings {
  enabled: boolean;
  conflict_rule: ConflictRule;
  mapping: FieldMapping[];
}
export interface CrmSettings {
  entities: Record<CrmEntity, EntitySettings>;
}

const M = (vireek: string, crm: string, direction: SyncDirection = 'both'): FieldMapping => ({ vireek, crm, direction });

const DEFAULT_MAPPINGS: Record<CrmProvider, Record<CrmEntity, FieldMapping[]>> = {
  salesforce: {
    contact: [M('name', '__full_name'), M('email', 'Email'), M('phone', 'Phone'), M('address', '__mailing_address', 'from_crm'), M('notes', 'Description')],
    lead: [M('name', '__full_name'), M('email', 'Email'), M('phone', 'Phone'), M('notes', 'Description')],
    deal: [M('title', 'Name'), M('amount', 'Amount'), M('stage', 'StageName'), M('status', '__status'), M('close_date', 'CloseDate')],
  },
  pipedrive: {
    contact: [M('name', 'name'), M('email', '__primary_email'), M('phone', '__primary_phone')],
    lead: [M('name', 'title'), M('quote_amount', '__lead_amount')],
    deal: [M('title', 'title'), M('amount', 'value'), M('currency', 'currency'), M('status', 'status'), M('close_date', 'expected_close_date')],
  },
  zoho: {
    contact: [M('name', '__full_name'), M('email', 'Email'), M('phone', 'Phone'), M('address', '__mailing_address', 'from_crm'), M('notes', 'Description')],
    lead: [M('name', '__full_name'), M('email', 'Email'), M('phone', 'Phone'), M('notes', 'Description')],
    deal: [M('title', 'Deal_Name'), M('amount', 'Amount'), M('stage', 'Stage'), M('status', '__status'), M('close_date', 'Closing_Date')],
  },
};

export function defaultSettings(provider: CrmProvider): CrmSettings {
  const entities = {} as Record<CrmEntity, EntitySettings>;
  for (const e of CRM_ENTITIES) {
    entities[e] = {
      enabled: e !== 'deal', // deals create a new record type in Vireek, so they are opt-in
      conflict_rule: 'newest_wins',
      mapping: DEFAULT_MAPPINGS[provider][e].map((m) => ({ ...m })),
    };
  }
  return { entities };
}

export type SettingsResult = { ok: true; settings: CrmSettings } | { ok: false; error: string };

export function validateSettings(provider: CrmProvider, input: unknown): SettingsResult {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Settings must be an object.' };
  const src = (input as { entities?: Record<string, unknown> }).entities;
  if (!src || typeof src !== 'object') return { ok: false, error: 'Settings are missing entities.' };

  const out = {} as Record<CrmEntity, EntitySettings>;
  for (const entity of CRM_ENTITIES) {
    const label = ENTITY_META[entity].label;
    const raw = src[entity] as Partial<EntitySettings> | undefined;
    if (!raw || typeof raw !== 'object') return { ok: false, error: `${label}: settings are missing.` };
    if (typeof raw.enabled !== 'boolean') return { ok: false, error: `${label}: "enabled" must be true or false.` };
    if (!CONFLICT_RULES.includes(raw.conflict_rule as ConflictRule)) return { ok: false, error: `${label}: unknown conflict rule.` };
    if (!Array.isArray(raw.mapping)) return { ok: false, error: `${label}: mapping must be a list.` };

    const catalog = CRM_CATALOG[provider][entity];
    const seenV = new Set<string>();
    const seenC = new Set<string>();
    const mapping: FieldMapping[] = [];
    for (const m of raw.mapping as Partial<FieldMapping>[]) {
      if (!m || typeof m.vireek !== 'string' || typeof m.crm !== 'string') return { ok: false, error: `${label}: invalid mapping row.` };
      const vf = vireekField(entity, m.vireek);
      if (!vf) return { ok: false, error: `${label}: unknown Vireek field "${m.vireek}".` };
      if (!SYNC_DIRECTIONS.includes(m.direction as SyncDirection)) return { ok: false, error: `${label}: invalid direction for ${vf.label}.` };
      const cat = catalog.find((c) => c.key === m.crm);
      if (!cat && !CUSTOM_CRM_KEY.test(m.crm)) return { ok: false, error: `${label}: "${m.crm}" is not a valid CRM field name.` };
      if (cat?.readonly && m.direction !== 'from_crm') return { ok: false, error: `${label}: ${cat.label} is read-only in the CRM.` };
      if (seenV.has(m.vireek)) return { ok: false, error: `${label}: ${vf.label} is mapped more than once.` };
      if (seenC.has(m.crm)) return { ok: false, error: `${label}: a CRM field is mapped more than once.` };
      seenV.add(m.vireek);
      seenC.add(m.crm);
      mapping.push({ vireek: m.vireek, crm: m.crm, direction: m.direction as SyncDirection });
    }
    if (raw.enabled) {
      for (const f of VIREEK_FIELDS[entity].filter((x) => x.required)) {
        if (!seenV.has(f.key)) return { ok: false, error: `${label}: map "${f.label}" to a CRM field to turn this sync on.` };
      }
    }
    out[entity] = { enabled: raw.enabled, conflict_rule: raw.conflict_rule as ConflictRule, mapping };
  }
  return { ok: true, settings: { entities: out } };
}

// ============================================================
// NORMALISATION
// ============================================================

/** Comparison form of a value. Two values are "the same" iff their forms are equal. */
export function normalizeValue(type: VireekFieldType, v: unknown): CanonValue {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
      return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
    }
    case 'date': {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
      return m ? m[1] : null;
    }
    case 'status': {
      const s = String(v).trim().toLowerCase();
      return s === 'open' || s === 'won' || s === 'lost' ? s : null;
    }
    case 'email': {
      const s = String(v).trim().toLowerCase();
      return s || null;
    }
    case 'phone': {
      const s = String(v).trim();
      const digits = s.replace(/\D/g, '');
      return digits ? `${s.startsWith('+') ? '+' : ''}${digits}` : null;
    }
    default: {
      const s = String(v).replace(/\s+/g, ' ').trim();
      return s || null;
    }
  }
}

/** Value to actually store / send (keeps the original formatting). */
export function coerceValue(type: VireekFieldType, v: unknown): CanonValue {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'number':
    case 'date':
    case 'status':
      return normalizeValue(type, v);
    default: {
      const s = String(v).trim();
      return s || null;
    }
  }
}

export const sameValue = (type: VireekFieldType, a: unknown, b: unknown) => normalizeValue(type, a) === normalizeValue(type, b);

// ============================================================
// THREE-WAY MERGE
// ============================================================

export interface MergeField {
  key: string;
  type: VireekFieldType;
  direction: SyncDirection;
  required?: boolean;
}
export interface MergeConflict {
  field: string;
  vireek: CanonValue;
  crm: CanonValue;
  base: CanonValue;
}
export interface MergeResult {
  toVireek: Canon;
  toCrm: Canon;
  conflicts: MergeConflict[];
  resolved: { field: string; winner: 'vireek' | 'crm' }[];
  /** New base snapshot (normalised) to store after BOTH writes succeeded. */
  next: Canon;
}

export function threeWayMerge(input: {
  fields: MergeField[];
  base: Canon | null;
  vireek: Canon;
  crm: Canon;
  rule: ConflictRule;
  vireekTs: number | null;
  crmTs: number | null;
}): MergeResult {
  const { fields, base, vireek, crm, rule, vireekTs, crmTs } = input;
  const res: MergeResult = { toVireek: {}, toCrm: {}, conflicts: [], resolved: [], next: {} };

  for (const f of fields) {
    const k = f.key;
    const v = normalizeValue(f.type, vireek[k]);
    const c = normalizeValue(f.type, crm[k]);

    const pushToCrm = () => {
      const val = coerceValue(f.type, vireek[k]);
      if (val === null && f.required) {
        res.toVireek[k] = coerceValue(f.type, crm[k]); // never blank a required field
        res.next[k] = c;
      } else {
        res.toCrm[k] = val;
        res.next[k] = v;
      }
    };
    const pullToVireek = () => {
      const val = coerceValue(f.type, crm[k]);
      if (val === null && f.required) {
        res.toCrm[k] = coerceValue(f.type, vireek[k]);
        res.next[k] = v;
      } else {
        res.toVireek[k] = val;
        res.next[k] = c;
      }
    };

    if (v === c) {
      res.next[k] = v;
      continue;
    }
    if (f.direction === 'to_crm') {
      pushToCrm();
      continue;
    }
    if (f.direction === 'from_crm') {
      pullToVireek();
      continue;
    }

    const hasBase = base !== null && Object.prototype.hasOwnProperty.call(base, k);
    if (!hasBase) {
      // First time these two records meet: fill blanks, otherwise it's a real disagreement.
      if (v === null) {
        pullToVireek();
        continue;
      }
      if (c === null) {
        pushToCrm();
        continue;
      }
    } else {
      const b = normalizeValue(f.type, base![k]);
      const vChanged = v !== b;
      const cChanged = c !== b;
      if (vChanged && !cChanged) {
        pushToCrm();
        continue;
      }
      if (!vChanged && cChanged) {
        pullToVireek();
        continue;
      }
    }

    // Both sides changed this field to different values.
    const b = hasBase ? normalizeValue(f.type, base![k]) : null;
    let winner: 'vireek' | 'crm' | null = null;
    if (rule === 'vireek_wins') winner = 'vireek';
    else if (rule === 'crm_wins') winner = 'crm';
    else if (rule === 'newest_wins') {
      if (vireekTs === null && crmTs === null) winner = 'vireek';
      else if (vireekTs === null) winner = 'crm';
      else if (crmTs === null) winner = 'vireek';
      else winner = vireekTs >= crmTs ? 'vireek' : 'crm';
    }

    if (winner === null) {
      res.conflicts.push({ field: k, vireek: coerceValue(f.type, vireek[k]), crm: coerceValue(f.type, crm[k]), base: b });
      res.next[k] = b; // keep the old base so the conflict is re-detected, not forgotten
    } else {
      res.resolved.push({ field: k, winner });
      if (winner === 'vireek') pushToCrm();
      else pullToVireek();
    }
  }
  return res;
}

// ============================================================
// FIELD ADAPTERS  (raw CRM record <-> canonical values)
// ============================================================

export type RawRecord = Record<string, unknown>;

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const joinParts = (parts: unknown[], sep = ', ') => parts.map(str).filter(Boolean).join(sep);

const isSf = (p: CrmProvider) => p === 'salesforce';

function fullNameKeys(p: CrmProvider) {
  return isSf(p) ? { first: 'FirstName', last: 'LastName' } : { first: 'First_Name', last: 'Last_Name' };
}

const ADDRESS_PARTS: Record<string, string[]> = {
  'salesforce:__mailing_address': ['MailingStreet', 'MailingCity', 'MailingState', 'MailingPostalCode', 'MailingCountry'],
  'zoho:__mailing_address': ['Mailing_Street', 'Mailing_City', 'Mailing_State', 'Mailing_Zip', 'Mailing_Country'],
  'salesforce:__street_address': ['Street', 'City', 'State', 'PostalCode', 'Country'],
  'zoho:__street_address': ['Street', 'City', 'State', 'Zip_Code', 'Country'],
};

function primaryOf(v: unknown): string {
  if (Array.isArray(v)) {
    const arr = v as { value?: unknown; primary?: unknown }[];
    const p = arr.find((x) => x && x.primary === true) ?? arr[0];
    return p ? str(p.value) : '';
  }
  return str(v);
}

/** Zoho stage names that mean the deal is closed. */
export function dealStatusFromStage(stage: unknown): 'open' | 'won' | 'lost' {
  const s = str(stage).toLowerCase();
  if (/closed\s*won|\bwon\b/.test(s)) return 'won';
  if (/closed\s*lost|\blost\b/.test(s)) return 'lost';
  return 'open';
}

export function readCrmField(provider: CrmProvider, entity: CrmEntity, raw: RawRecord, key: string): unknown {
  switch (key) {
    case '__full_name': {
      const k = fullNameKeys(provider);
      return joinParts([raw[k.first], raw[k.last]], ' ') || null;
    }
    case '__mailing_address':
    case '__street_address': {
      const parts = ADDRESS_PARTS[`${provider}:${key}`] ?? [];
      return joinParts(parts.map((p) => raw[p])) || null;
    }
    case '__primary_email':
      return primaryOf(raw.email) || null;
    case '__primary_phone':
      return primaryOf(raw.phone) || null;
    case '__lead_amount': {
      const v = raw.value as { amount?: unknown } | null | undefined;
      return v && typeof v === 'object' ? (v.amount ?? null) : null;
    }
    case '__status':
      if (provider === 'salesforce') return raw.IsWon === true ? 'won' : raw.IsClosed === true ? 'lost' : 'open';
      if (provider === 'zoho') return dealStatusFromStage(raw.Stage);
      return raw.status === 'deleted' ? 'lost' : (raw.status ?? null);
    default:
      if (provider === 'pipedrive' && entity === 'deal' && key === 'status' && raw.status === 'deleted') return 'lost';
      return raw[key] ?? null;
  }
}

const STAGE_FOR_STATUS: Record<string, Record<'open' | 'won' | 'lost', string>> = {
  salesforce: { open: 'Prospecting', won: 'Closed Won', lost: 'Closed Lost' },
  zoho: { open: 'Qualification', won: 'Closed Won', lost: 'Closed Lost' },
};

export function splitName(full: string): { first: string; last: string } {
  const t = full.replace(/\s+/g, ' ').trim();
  const i = t.lastIndexOf(' ');
  return i === -1 ? { first: '', last: t } : { first: t.slice(0, i), last: t.slice(i + 1) };
}

function mergeMulti(current: unknown, value: string | null): { value: string; primary: boolean; label?: string }[] {
  const arr = Array.isArray(current) ? (current as { value?: unknown; primary?: unknown; label?: unknown }[]) : [];
  const keep = arr
    .filter((x) => x && x.primary !== true)
    .map((x) => ({ value: str(x.value), primary: false, label: x.label ? str(x.label) : undefined }))
    .filter((x) => x.value && x.value !== value);
  if (!value) return keep;
  return [{ value, primary: true }, ...keep];
}

/** Writes one canonical value into a provider payload (mutates `payload`). */
export function writeCrmField(
  provider: CrmProvider,
  entity: CrmEntity,
  payload: Record<string, unknown>,
  key: string,
  value: CanonValue,
  current?: RawRecord,
): void {
  switch (key) {
    case '__full_name': {
      const k = fullNameKeys(provider);
      const { first, last } = splitName(str(value));
      payload[k.first] = first || null;
      payload[k.last] = last || null;
      return;
    }
    case '__mailing_address':
    case '__street_address': {
      const parts = ADDRESS_PARTS[`${provider}:${key}`];
      // The whole address lives on the street line; the other parts are cleared
      // so reading it back yields exactly what was written (no duplication loop).
      parts.forEach((p, i) => (payload[p] = i === 0 ? (value ?? null) : null));
      return;
    }
    case '__primary_email':
      payload.email = mergeMulti(current?.email, value === null ? null : str(value));
      return;
    case '__primary_phone':
      payload.phone = mergeMulti(current?.phone, value === null ? null : str(value));
      return;
    case '__lead_amount': {
      const cur = (current?.value as { currency?: unknown } | null | undefined)?.currency;
      payload.value = value === null ? null : { amount: Number(value), currency: str(cur) || 'USD' };
      return;
    }
    case '__status':
      // Resolved after the other fields (needs to know whether a stage was set).
      return;
    default:
      payload[key] = value;
  }
}

export interface CanonicalRecord {
  externalId: string;
  modifiedAt: number | null;
  values: Canon;
}

export function parseTimestamp(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = `${s.replace(' ', 'T')}Z`; // Pipedrive (UTC)
  s = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'); // Salesforce "+0000"
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

export function recordMeta(provider: CrmProvider, raw: RawRecord): { id: string; modifiedAt: number | null } {
  if (provider === 'salesforce') return { id: str(raw.Id), modifiedAt: parseTimestamp(raw.LastModifiedDate) };
  if (provider === 'pipedrive') return { id: str(raw.id), modifiedAt: parseTimestamp(raw.update_time) };
  return { id: str(raw.id), modifiedAt: parseTimestamp(raw.Modified_Time) };
}

export function toCanonical(provider: CrmProvider, entity: CrmEntity, raw: RawRecord, mapping: FieldMapping[]): CanonicalRecord {
  const meta = recordMeta(provider, raw);
  const values: Canon = {};
  for (const m of mapping) {
    const vf = vireekField(entity, m.vireek);
    if (!vf) continue;
    values[m.vireek] = coerceValue(vf.type, readCrmField(provider, entity, raw, m.crm));
  }
  return { externalId: meta.id, modifiedAt: meta.modifiedAt, values };
}

/** Today + N days as YYYY-MM-DD (UTC). */
function datePlus(days: number, now = Date.now()): string {
  return new Date(now + days * 86_400_000).toISOString().slice(0, 10);
}

export function buildCrmPayload(
  provider: CrmProvider,
  entity: CrmEntity,
  patch: Canon,
  mapping: FieldMapping[],
  opts: { creating?: boolean; current?: RawRecord; now?: number } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  let statusValue: CanonValue | undefined;

  for (const [vkey, value] of Object.entries(patch)) {
    const m = mapping.find((x) => x.vireek === vkey);
    if (!m || m.direction === 'from_crm') continue;
    if (m.crm === '__status') {
      statusValue = value;
      continue;
    }
    writeCrmField(provider, entity, payload, m.crm, value, opts.current);
  }

  // Deal status is derived from the stage in Salesforce / Zoho: if the status
  // changed but the stage was not sent, pick the conventional closed/open stage.
  if (entity === 'deal' && statusValue !== undefined && (provider === 'salesforce' || provider === 'zoho')) {
    const stageKey = provider === 'salesforce' ? 'StageName' : 'Stage';
    if (payload[stageKey] === undefined && statusValue) {
      payload[stageKey] = STAGE_FOR_STATUS[provider][statusValue as 'open' | 'won' | 'lost'];
    }
  }

  if (opts.creating) {
    const now = opts.now ?? Date.now();
    if (provider === 'salesforce') {
      if (entity === 'lead' && !payload.Company) payload.Company = str(patch.name) || 'Unknown';
      if (entity === 'deal') {
        payload.StageName ??= STAGE_FOR_STATUS.salesforce.open;
        payload.CloseDate ??= datePlus(30, now);
      }
    } else if (provider === 'zoho') {
      if (entity === 'lead' && !payload.Company) payload.Company = str(patch.name) || 'Unknown';
      if (entity === 'deal') {
        payload.Stage ??= STAGE_FOR_STATUS.zoho.open;
        payload.Closing_Date ??= datePlus(30, now);
      }
    } else if (entity === 'deal' && payload.status === undefined) {
      payload.status = 'open';
    }
  }
  return payload;
}

// ============================================================
// HTTP REQUEST BUILDERS / RESPONSE PARSERS
// ============================================================

export interface HttpReq {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export const SF_API_VERSION = 'v61.0';
const SF_OBJECT: Record<CrmEntity, string> = { contact: 'Contact', lead: 'Lead', deal: 'Opportunity' };
const ZOHO_MODULE: Record<CrmEntity, string> = { contact: 'Contacts', lead: 'Leads', deal: 'Deals' };
const PD_PATH: Record<CrmEntity, string> = { contact: 'persons', lead: 'leads', deal: 'deals' };

/** Real API field names needed to read the mapped fields (virtual fields expanded, custom names validated). */
export function crmReadFields(provider: CrmProvider, entity: CrmEntity, mapping: FieldMapping[]): string[] {
  const out = new Set<string>();
  const add = (k: string) => {
    if (!CUSTOM_CRM_KEY.test(k)) throw new Error(`Unsafe CRM field name: ${k}`);
    out.add(k);
  };
  for (const m of mapping) {
    switch (m.crm) {
      case '__full_name': {
        const k = fullNameKeys(provider);
        add(k.first);
        add(k.last);
        break;
      }
      case '__mailing_address':
      case '__street_address':
        (ADDRESS_PARTS[`${provider}:${m.crm}`] ?? []).forEach(add);
        break;
      case '__status':
        if (provider === 'salesforce') ['IsWon', 'IsClosed', 'StageName'].forEach(add);
        else if (provider === 'zoho') add('Stage');
        else add('status');
        break;
      case '__primary_email':
        add('email');
        break;
      case '__primary_phone':
        add('phone');
        break;
      case '__lead_amount':
        add('value');
        break;
      default:
        add(m.crm);
    }
  }
  return [...out];
}

export interface ListCtx {
  provider: CrmProvider;
  entity: CrmEntity;
  /** Salesforce instance_url / Pipedrive api_domain / Zoho api_domain (no trailing slash). */
  base: string;
  mapping: FieldMapping[];
  /** ISO watermark; null = first full pass. */
  since: string | null;
  /** Provider cursor from the previous page. */
  cursor: string | null;
  pageSize?: number;
}

function sfDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid watermark');
  return d.toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

export function buildListRequest(ctx: ListCtx): HttpReq {
  const { provider, entity, base, mapping, since, cursor } = ctx;
  const size = ctx.pageSize ?? 200;

  if (provider === 'salesforce') {
    if (cursor) {
      if (!cursor.startsWith('/services/data/')) throw new Error('Unsafe Salesforce cursor');
      return { method: 'GET', url: `${base}${cursor}`, headers: { 'Sforce-Query-Options': `batchSize=${size}` } };
    }
    const fields = [...new Set(['Id', 'LastModifiedDate', ...crmReadFields(provider, entity, mapping)])];
    const where: string[] = [];
    if (entity === 'lead') where.push('IsConverted = false');
    if (since) where.push(`LastModifiedDate > ${sfDateTime(since)}`);
    const soql = `SELECT ${fields.join(', ')} FROM ${SF_OBJECT[entity]}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY LastModifiedDate ASC`;
    return {
      method: 'GET',
      url: `${base}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`,
      headers: { 'Sforce-Query-Options': `batchSize=${size}` },
    };
  }

  if (provider === 'pipedrive') {
    // Full pass: stable id order. Incremental: newest first, the runner stops at the watermark.
    const sort = since ? 'update_time DESC' : 'id ASC';
    const start = cursor ? Number(cursor) || 0 : 0;
    return { method: 'GET', url: `${base}/api/v1/${PD_PATH[entity]}?limit=${Math.min(size, 500)}&start=${start}&sort=${encodeURIComponent(sort)}` };
  }

  const fields = [...new Set(['id', 'Modified_Time', ...crmReadFields(provider, entity, mapping)])];
  const qs = new URLSearchParams({ fields: fields.join(','), per_page: String(Math.min(size, 200)), sort_by: 'id', sort_order: 'asc' });
  if (cursor?.startsWith('token:')) qs.set('page_token', cursor.slice(6));
  else qs.set('page', cursor?.startsWith('page:') ? cursor.slice(5) : '1');
  const headers: Record<string, string> = {};
  if (since) headers['If-Modified-Since'] = new Date(since).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  return { method: 'GET', url: `${base}/crm/v6/${ZOHO_MODULE[entity]}?${qs.toString()}`, headers };
}

export interface ListPage {
  records: RawRecord[];
  /** null = this pass is finished. */
  next: string | null;
}

export function parseListResponse(provider: CrmProvider, json: unknown, ctx: Pick<ListCtx, 'cursor'>): ListPage {
  const j = (json ?? {}) as Record<string, unknown>;
  if (provider === 'salesforce') {
    const records = Array.isArray(j.records) ? (j.records as RawRecord[]) : [];
    const next = j.done === false && typeof j.nextRecordsUrl === 'string' ? j.nextRecordsUrl : null;
    return { records, next };
  }
  if (provider === 'pipedrive') {
    const records = Array.isArray(j.data) ? (j.data as RawRecord[]) : [];
    const pg = ((j.additional_data as Record<string, unknown> | undefined)?.pagination ?? {}) as Record<string, unknown>;
    const next = pg.more_items_in_collection === true && pg.next_start !== undefined ? String(pg.next_start) : null;
    return { records, next };
  }
  const records = Array.isArray(j.data) ? (j.data as RawRecord[]) : [];
  const info = (j.info ?? {}) as Record<string, unknown>;
  if (info.more_records !== true) return { records, next: null };
  if (typeof info.next_page_token === 'string' && info.next_page_token) return { records, next: `token:${info.next_page_token}` };
  const page = Number(info.page) || Number(ctx.cursor?.replace(/^page:/, '')) || 1;
  return { records, next: `page:${page + 1}` };
}

export function buildGetRequest(provider: CrmProvider, entity: CrmEntity, base: string, id: string, mapping: FieldMapping[]): HttpReq {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Unsafe record id');
  if (provider === 'salesforce') {
    const fields = [...new Set(['Id', 'LastModifiedDate', ...crmReadFields(provider, entity, mapping)])];
    return { method: 'GET', url: `${base}/services/data/${SF_API_VERSION}/sobjects/${SF_OBJECT[entity]}/${id}?fields=${fields.join(',')}` };
  }
  if (provider === 'pipedrive') return { method: 'GET', url: `${base}/api/v1/${PD_PATH[entity]}/${id}` };
  const fields = [...new Set(['id', 'Modified_Time', ...crmReadFields(provider, entity, mapping)])];
  return { method: 'GET', url: `${base}/crm/v6/${ZOHO_MODULE[entity]}/${id}?fields=${fields.join(',')}` };
}

export function parseGetResponse(provider: CrmProvider, json: unknown): RawRecord | null {
  const j = json as Record<string, unknown> | null;
  if (!j) return null;
  if (provider === 'salesforce') return j.Id ? (j as RawRecord) : null;
  if (provider === 'pipedrive') return j.data && typeof j.data === 'object' ? (j.data as RawRecord) : null;
  const d = j.data as RawRecord[] | undefined;
  return Array.isArray(d) && d[0] ? d[0] : null;
}

export function buildCreateRequest(provider: CrmProvider, entity: CrmEntity, base: string, payload: Record<string, unknown>): HttpReq {
  if (!CRM_CAPS[provider][entity].create) throw new Error(`${PROVIDER_META[provider].label} does not allow creating ${ENTITY_META[entity].crmLabel[provider]} from Vireek.`);
  if (provider === 'salesforce') return { method: 'POST', url: `${base}/services/data/${SF_API_VERSION}/sobjects/${SF_OBJECT[entity]}`, body: payload };
  if (provider === 'pipedrive') return { method: 'POST', url: `${base}/api/v1/${PD_PATH[entity]}`, body: payload };
  return { method: 'POST', url: `${base}/crm/v6/${ZOHO_MODULE[entity]}`, body: { data: [payload] } };
}

export function buildUpdateRequest(provider: CrmProvider, entity: CrmEntity, base: string, id: string, payload: Record<string, unknown>): HttpReq {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Unsafe record id');
  if (provider === 'salesforce') return { method: 'PATCH', url: `${base}/services/data/${SF_API_VERSION}/sobjects/${SF_OBJECT[entity]}/${id}`, body: payload };
  if (provider === 'pipedrive') {
    return { method: entity === 'lead' ? 'PATCH' : 'PUT', url: `${base}/api/v1/${PD_PATH[entity]}/${id}`, body: payload };
  }
  return { method: 'PUT', url: `${base}/crm/v6/${ZOHO_MODULE[entity]}/${id}`, body: { data: [payload] } };
}

export interface WriteResult {
  ok: boolean;
  id: string | null;
  duplicateOf?: string;
  error?: string;
}

export function parseWriteResponse(provider: CrmProvider, status: number, json: unknown): WriteResult {
  const j = json as Record<string, unknown> | unknown[] | null;
  if (provider === 'salesforce') {
    if (status >= 200 && status < 300) return { ok: true, id: j && !Array.isArray(j) && j.id ? str(j.id) : null };
    const first = Array.isArray(j) ? (j[0] as Record<string, unknown> | undefined) : undefined;
    return { ok: false, id: null, error: str(first?.message) || `Salesforce error (${status})` };
  }
  if (provider === 'pipedrive') {
    const o = (j ?? {}) as Record<string, unknown>;
    if (status >= 200 && status < 300 && o.success !== false) {
      const data = o.data as Record<string, unknown> | undefined;
      return { ok: true, id: data?.id !== undefined ? str(data.id) : null };
    }
    return { ok: false, id: null, error: str(o.error) || str(o.error_info) || `Pipedrive error (${status})` };
  }
  const o = (j ?? {}) as Record<string, unknown>;
  const first = (Array.isArray(o.data) ? o.data[0] : undefined) as Record<string, unknown> | undefined;
  const details = (first?.details ?? {}) as Record<string, unknown>;
  if (first && first.status === 'success') return { ok: true, id: details.id !== undefined ? str(details.id) : null };
  if (first && first.code === 'DUPLICATE_DATA' && details.id !== undefined) {
    return { ok: false, id: null, duplicateOf: str(details.id), error: 'Duplicate record in Zoho CRM' };
  }
  return { ok: false, id: null, error: str(first?.message) || str(o.message) || `Zoho error (${status})` };
}

// ============================================================
// OAUTH
// ============================================================

const SF_HOST = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(salesforce|force|cloudforce)\.com$/i;
const PD_HOST = /^https:\/\/[a-z0-9-]+\.pipedrive\.com$/i;
const ZOHO_API_HOST = /^https:\/\/([a-z0-9-]+\.)*(zohoapis\.(com|eu|in|com\.au|jp|com\.cn|sa|ca)|zohocloud\.ca)$/i;
const ZOHO_ACCOUNTS_HOST = /^https:\/\/accounts\.(zoho\.(com|eu|in|com\.au|jp|com\.cn|sa)|zohocloud\.ca)$/i;
const SF_LOGIN_HOST = /^https:\/\/(login|test)\.salesforce\.com$|^https:\/\/[a-z0-9-]+\.my\.salesforce\.com$/i;

/** Base URL we will send a bearer token to (Salesforce instance / Pipedrive / Zoho API domain). */
export function isAllowedApiBase(provider: CrmProvider, url: string): boolean {
  const u = url.replace(/\/+$/, '');
  return provider === 'salesforce' ? SF_HOST.test(u) : provider === 'pipedrive' ? PD_HOST.test(u) : ZOHO_API_HOST.test(u);
}
export const isAllowedZohoAccountsServer = (url: string) => ZOHO_ACCOUNTS_HOST.test(url.replace(/\/+$/, ''));
export const isAllowedSalesforceLogin = (url: string) => SF_LOGIN_HOST.test(url.replace(/\/+$/, ''));

export const OAUTH_SCOPES = {
  salesforce: 'api refresh_token',
  pipedrive: '', // Pipedrive scopes are configured on the app itself
  zoho: 'ZohoCRM.modules.contacts.ALL,ZohoCRM.modules.leads.ALL,ZohoCRM.modules.deals.ALL',
} as const;

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  /** Salesforce login URL (login/test/My Domain) or Zoho accounts server. */
  authBase?: string;
  pkceChallenge?: string;
}

export function buildAuthorizeUrl(provider: CrmProvider, p: AuthorizeParams): string {
  let u: URL;
  if (provider === 'salesforce') {
    const base = (p.authBase ?? 'https://login.salesforce.com').replace(/\/+$/, '');
    if (!isAllowedSalesforceLogin(base)) throw new Error('Unsupported Salesforce login URL');
    u = new URL(`${base}/services/oauth2/authorize`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', OAUTH_SCOPES.salesforce);
    if (p.pkceChallenge) {
      u.searchParams.set('code_challenge', p.pkceChallenge);
      u.searchParams.set('code_challenge_method', 'S256');
    }
  } else if (provider === 'pipedrive') {
    u = new URL('https://oauth.pipedrive.com/oauth/authorize');
  } else {
    const base = (p.authBase ?? 'https://accounts.zoho.com').replace(/\/+$/, '');
    if (!isAllowedZohoAccountsServer(base)) throw new Error('Unsupported Zoho accounts server');
    u = new URL(`${base}/oauth/v2/auth`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', OAUTH_SCOPES.zoho);
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
  }
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('state', p.state);
  return u.toString();
}

export interface TokenRequestParams {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
  code?: string;
  refreshToken?: string;
  codeVerifier?: string;
  /** Salesforce login URL / Zoho accounts server the user authorised against. */
  authBase?: string;
}

export function buildTokenRequest(
  provider: CrmProvider,
  kind: 'code' | 'refresh',
  p: TokenRequestParams,
): { url: string; headers: Record<string, string>; body: string } {
  const form = new URLSearchParams();
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  let url: string;

  if (kind === 'code') {
    form.set('grant_type', 'authorization_code');
    if (!p.code) throw new Error('Missing authorization code');
    form.set('code', p.code);
    if (p.redirectUri) form.set('redirect_uri', p.redirectUri);
  } else {
    form.set('grant_type', 'refresh_token');
    if (!p.refreshToken) throw new Error('Missing refresh token');
    form.set('refresh_token', p.refreshToken);
  }

  if (provider === 'salesforce') {
    const base = (p.authBase ?? 'https://login.salesforce.com').replace(/\/+$/, '');
    if (!isAllowedSalesforceLogin(base)) throw new Error('Unsupported Salesforce login URL');
    url = `${base}/services/oauth2/token`;
    form.set('client_id', p.clientId);
    form.set('client_secret', p.clientSecret);
    if (kind === 'code' && p.codeVerifier) form.set('code_verifier', p.codeVerifier);
  } else if (provider === 'pipedrive') {
    url = 'https://oauth.pipedrive.com/oauth/token';
    headers.Authorization = `Basic ${btoa(`${p.clientId}:${p.clientSecret}`)}`;
  } else {
    const base = (p.authBase ?? 'https://accounts.zoho.com').replace(/\/+$/, '');
    if (!isAllowedZohoAccountsServer(base)) throw new Error('Unsupported Zoho accounts server');
    url = `${base}/oauth/v2/token`;
    form.set('client_id', p.clientId);
    form.set('client_secret', p.clientSecret);
  }
  return { url, headers, body: form.toString() };
}

export interface ParsedTokens {
  accessToken: string;
  refreshToken: string | null;
  /** null = unknown (Salesforce); the runner refreshes on 401 instead. */
  expiresInSec: number | null;
  apiBase: string;
}

export function parseTokenResponse(provider: CrmProvider, json: unknown): ParsedTokens {
  const j = (json ?? {}) as Record<string, unknown>;
  const accessToken = str(j.access_token);
  if (!accessToken) throw new Error(str(j.error_description) || str(j.error) || 'Token exchange failed.');
  const apiBase = str(provider === 'salesforce' ? j.instance_url : j.api_domain).replace(/\/+$/, '');
  if (!apiBase || !isAllowedApiBase(provider, apiBase)) throw new Error('The CRM returned an unexpected API address.');
  const exp = Number(j.expires_in ?? j.expires_in_sec);
  return {
    accessToken,
    refreshToken: str(j.refresh_token) || null,
    expiresInSec: Number.isFinite(exp) && exp > 0 ? exp : null,
    apiBase,
  };
}

// ---- signed OAuth state + PKCE (stateless, HMAC-SHA256) --------------------

const STATE_TTL_MS = 10 * 60 * 1000;

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacBytes(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

export interface OAuthState {
  /** account owner id */
  o: string;
  /** user who clicked connect */
  u: string;
  p: CrmProvider;
  /** nonce (also seeds the PKCE verifier) */
  n: string;
  t: number;
}

export async function signOAuthState(
  data: { owner: string; user: string; provider: CrmProvider },
  secret: string,
  now: number = Date.now(),
): Promise<{ state: string; nonce: string }> {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const payload: OAuthState = { o: data.owner, u: data.user, p: data.provider, n: nonce, t: now };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = b64url(await hmacBytes(secret, body));
  return { state: `${body}.${sig}`, nonce };
}

export async function verifyOAuthState(state: string, secret: string, now: number = Date.now()): Promise<OAuthState | null> {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = b64url(await hmacBytes(secret, body));
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as OAuthState;
    if (!CRM_PROVIDERS.includes(p.p) || typeof p.o !== 'string' || typeof p.u !== 'string' || typeof p.n !== 'string') return null;
    if (!Number.isFinite(p.t) || now - p.t > STATE_TTL_MS || p.t - now > 60_000) return null;
    return p;
  } catch {
    return null;
  }
}

export async function pkceVerifier(secret: string, nonce: string): Promise<string> {
  return b64url(await hmacBytes(secret, `pkce:${nonce}`)); // 43 chars, RFC 7636 compliant
}
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

// ---- tokens at rest (AES-256-GCM) -----------------------------------------

async function aesKey(keyB64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(keyB64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error('CRM_TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plain: string, keyB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyB64), new TextEncoder().encode(plain)));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

export async function decryptSecret(token: string, keyB64: string): Promise<string> {
  const [v, iv, ct] = token.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('Unrecognised secret format.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(iv) }, await aesKey(keyB64), b64urlDecode(ct));
  return new TextDecoder().decode(pt);
}

// ============================================================
// MISC
// ============================================================

export interface SyncStats {
  created_vireek: number;
  updated_vireek: number;
  created_crm: number;
  updated_crm: number;
  skipped: number;
  conflicts: number;
  errors: number;
}
export const emptyStats = (): SyncStats => ({ created_vireek: 0, updated_vireek: 0, created_crm: 0, updated_crm: 0, skipped: 0, conflicts: 0, errors: 0 });

/** Escape LIKE/ILIKE wildcards so an email is matched literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const PULL_OVERLAP_MS = 2 * 60 * 1000;
export const PAGE_CAP_PER_RUN = 1000;
