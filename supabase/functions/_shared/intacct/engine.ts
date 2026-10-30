// supabase/functions/_shared/intacct/engine.ts
//
// Vireek <-> Sage Intacct sync engine: pure and deterministic. NO network, NO database, NO Deno/DOM
// APIs (only WebCrypto). Imported by the edge functions, by the React client (mapping UI catalog) and
// by the unit tests.
//
// *** NOT LIVE-VERIFIED ***  Every Sage Intacct object name, field name, XML function shape and error
// pattern in this file is isolated in the tables marked VERIFY below and was only exercised against
// the in-memory mock gateway (mockGateway.ts). Run it against an Intacct sandbox company and adjust
// those tables before trusting it with production books.
//
// Integrity rules (same as the QuickBooks engine):
//   1. Nothing from the client becomes an XML element name, object name or field name. Names come from
//      fixed tables; every value is XML-escaped; filters are structured, never string-concatenated.
//   2. Sender and user passwords are only ever sent to an allow-listed *.intacct.com gateway.
//   3. Money is integer cents on the Vireek side, converted at the edge only.
//   4. A conflict exists only when BOTH sides changed the same field since the last sync.
//   5. Anything that cannot be represented faithfully is reported "unsupported" with a reason.

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
// TYPES + META
// ============================================================

export const IA_ENTITIES = ['account', 'customer', 'invoice', 'payment'] as const;
export type IaEntity = (typeof IA_ENTITIES)[number];
export type IaDirection = 'both' | 'to_intacct' | 'from_intacct';
export type IaFieldDirection = IaDirection | 'off';
export type IaConflictRule = 'newest_wins' | 'vireek_wins' | 'intacct_wins' | 'manual';

export const IA_DIRECTIONS: IaDirection[] = ['both', 'to_intacct', 'from_intacct'];
export const IA_CONFLICT_RULES: IaConflictRule[] = ['newest_wins', 'vireek_wins', 'intacct_wins', 'manual'];

export const ENTITY_META: Record<IaEntity, { label: string; vireekLabel: string; intacctLabel: string; table: string; hint: string }> = {
  account: { label: 'GL accounts', vireekLabel: 'Chart of accounts', intacctLabel: 'General ledger accounts', table: 'chart_of_accounts', hint: 'Your chart of accounts. Sage Intacct is normally the source of truth.' },
  customer: { label: 'Customers', vireekLabel: 'Customers', intacctLabel: 'Customers', table: 'customers', hint: 'Names, email, phone, billing address and comments.' },
  invoice: { label: 'Invoices', vireekLabel: 'AR invoices', intacctLabel: 'AR invoices', table: 'ar_invoices', hint: 'Invoices, line amounts, sales tax, due dates and reversals. Posted amounts are never edited in Sage Intacct by sync.' },
  payment: { label: 'Payments', vireekLabel: 'AR payments', intacctLabel: 'AR payments', table: 'ar_payments', hint: 'Customer payments applied to invoices. Payments are never edited, only created.' },
};

export const DIRECTION_META: Record<IaDirection, { label: string }> = {
  both: { label: 'Two-way' },
  to_intacct: { label: 'Vireek → Sage Intacct' },
  from_intacct: { label: 'Sage Intacct → Vireek' },
};

export const CONFLICT_RULE_META: Record<IaConflictRule, { label: string; hint: string }> = {
  newest_wins: { label: 'Newest change wins', hint: 'When both sides edited the same field, keep the most recent edit.' },
  vireek_wins: { label: 'Vireek wins', hint: 'Vireek is the source of truth for conflicting fields.' },
  intacct_wins: { label: 'Sage Intacct wins', hint: 'Sage Intacct is the source of truth for conflicting fields.' },
  manual: { label: 'Review manually', hint: 'Leave both values untouched and ask me to choose.' },
};

export interface VireekField { key: string; label: string; type: VireekFieldType; required?: boolean }

export const VIREEK_FIELDS: Record<IaEntity, VireekField[]> = {
  account: [
    { key: 'code', label: 'Account number', type: 'text', required: true },
    { key: 'name', label: 'Title', type: 'text', required: true },
    { key: 'active', label: 'Active / inactive', type: 'text' },
  ],
  customer: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'phone', label: 'Phone', type: 'phone' },
    { key: 'address', label: 'Billing address', type: 'text' },
    { key: 'notes', label: 'Comments', type: 'text' },
  ],
  invoice: [
    { key: 'due_date', label: 'Due date', type: 'date' },
    { key: 'amounts', label: 'Line amounts, tax and total', type: 'text' },
    { key: 'voided', label: 'Reversal status', type: 'text' },
  ],
  payment: [],
};

export const IA_PAGE = 100;
/** Intacct timestamps carry the company's local clock, not UTC: look back 12h (max UTC offset) + 2 min. */
export const PULL_OVERLAP_MS = 12 * 3600_000 + 2 * 60_000;
export const PAGE_CAP_PER_RUN = 1500;

// ============================================================
// SETTINGS
// ============================================================

export interface EntitySettings { enabled: boolean; direction: IaDirection; conflict: IaConflictRule; fields: Record<string, IaFieldDirection> }
export interface IaDefaults {
  /** GL account number used for invoice lines whose Vireek revenue account is not linked. */
  revenueAccountNo: string | null;
  /** GL account number that receives sales tax. Required to send or read invoices that carry tax. */
  taxAccountNo: string | null;
  /** Sage Intacct bank account id payments are deposited to. */
  bankAccountId: string | null;
  /** Send the Vireek invoice number as the Intacct invoice number. */
  sendInvoiceNumber: boolean;
}
export interface IaSettings { version: 1; entities: Record<IaEntity, EntitySettings>; defaults: IaDefaults }

const allFields = (e: IaEntity): Record<string, IaFieldDirection> => Object.fromEntries(VIREEK_FIELDS[e].map((f) => [f.key, 'both' as IaFieldDirection]));

export function defaultSettings(): IaSettings {
  const mk = (direction: IaDirection, conflict: IaConflictRule, e: IaEntity): EntitySettings => ({ enabled: true, direction, conflict, fields: allFields(e) });
  return {
    version: 1,
    entities: {
      account: mk('from_intacct', 'intacct_wins', 'account'),
      customer: mk('both', 'newest_wins', 'customer'),
      invoice: mk('both', 'manual', 'invoice'),
      payment: mk('both', 'manual', 'payment'),
    },
    defaults: { revenueAccountNo: null, taxAccountNo: null, bankAccountId: null, sendInvoiceNumber: true },
  };
}

export const IA_ID = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,39}$/;
export type SettingsResult = { ok: true; settings: IaSettings } | { ok: false; error: string };

export function validateSettings(input: unknown): SettingsResult {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Settings must be an object.' };
  const src = input as Record<string, unknown>;
  const base = defaultSettings();
  const out: IaSettings = { version: 1, entities: {} as IaSettings['entities'], defaults: { ...base.defaults } };
  const srcE = (src.entities ?? {}) as Record<string, unknown>;
  if (typeof srcE !== 'object' || srcE === null) return { ok: false, error: 'entities must be an object.' };
  for (const entity of IA_ENTITIES) {
    const raw = srcE[entity] as Record<string, unknown> | undefined;
    const d = base.entities[entity];
    const label = ENTITY_META[entity].label;
    if (raw === undefined) { out.entities[entity] = d; continue; }
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: `${label}: invalid settings.` };
    const enabled = raw.enabled === undefined ? d.enabled : raw.enabled;
    const direction = raw.direction === undefined ? d.direction : raw.direction;
    const conflict = raw.conflict === undefined ? d.conflict : raw.conflict;
    if (typeof enabled !== 'boolean') return { ok: false, error: `${label}: "enabled" must be true or false.` };
    if (!IA_DIRECTIONS.includes(direction as IaDirection)) return { ok: false, error: `${label}: unknown sync direction.` };
    if (!IA_CONFLICT_RULES.includes(conflict as IaConflictRule)) return { ok: false, error: `${label}: unknown conflict rule.` };
    const fields: Record<string, IaFieldDirection> = { ...d.fields };
    const rawFields = (raw.fields ?? {}) as Record<string, unknown>;
    if (typeof rawFields !== 'object' || rawFields === null) return { ok: false, error: `${label}: invalid fields.` };
    for (const [key, dir] of Object.entries(rawFields)) {
      if (!VIREEK_FIELDS[entity].some((f) => f.key === key)) return { ok: false, error: `${label}: unknown field "${key}".` };
      if (dir !== 'off' && !IA_DIRECTIONS.includes(dir as IaDirection)) return { ok: false, error: `${label}: invalid direction for "${key}".` };
      fields[key] = dir as IaFieldDirection;
    }
    for (const f of VIREEK_FIELDS[entity]) {
      if (f.required && fields[f.key] === 'off') return { ok: false, error: `${label}: "${f.label}" is required and cannot be turned off.` };
    }
    out.entities[entity] = { enabled, direction: direction as IaDirection, conflict: conflict as IaConflictRule, fields };
  }
  const dflt = (src.defaults ?? {}) as Record<string, unknown>;
  if (typeof dflt !== 'object' || dflt === null) return { ok: false, error: 'defaults must be an object.' };
  for (const key of ['revenueAccountNo', 'taxAccountNo', 'bankAccountId'] as const) {
    const v = dflt[key];
    if (v === undefined) continue;
    if (v === null || v === '') out.defaults[key] = null;
    else if (typeof v === 'string' && IA_ID.test(v)) out.defaults[key] = v;
    else return { ok: false, error: `Invalid value for ${key}.` };
  }
  if (dflt.sendInvoiceNumber !== undefined) {
    if (typeof dflt.sendInvoiceNumber !== 'boolean') return { ok: false, error: 'sendInvoiceNumber must be true or false.' };
    out.defaults.sendInvoiceNumber = dflt.sendInvoiceNumber;
  }
  return { ok: true, settings: out };
}

export function effectiveDirection(entityDir: IaDirection, fieldDir: IaFieldDirection): IaFieldDirection {
  if (fieldDir === 'off') return 'off';
  if (entityDir === 'both') return fieldDir;
  if (fieldDir === 'both') return entityDir;
  return fieldDir === entityDir ? fieldDir : 'off';
}
export const canCreateInIntacct = (es: EntitySettings) => es.enabled && es.direction !== 'from_intacct';
export const canCreateInVireek = (es: EntitySettings) => es.enabled && es.direction !== 'to_intacct';

// ============================================================
// MERGE
// ============================================================

const toCrmDir = (d: IaFieldDirection): 'both' | 'to_crm' | 'from_crm' => (d === 'to_intacct' ? 'to_crm' : d === 'from_intacct' ? 'from_crm' : 'both');

export function mergeFieldsFor(entity: IaEntity, es: EntitySettings): MergeField[] {
  const out: MergeField[] = [];
  for (const f of VIREEK_FIELDS[entity]) {
    const dir = effectiveDirection(es.direction, es.fields[f.key] ?? 'both');
    if (dir === 'off') continue;
    out.push({ key: f.key, type: f.type, direction: toCrmDir(dir), required: f.required });
  }
  return out;
}

export function mergeEntity(input: {
  entity: IaEntity; settings: EntitySettings; base: Canon | null; vireek: Canon; intacct: Canon;
  vireekTs: number | null; intacctTs: number | null; ruleOverride?: 'vireek_wins' | 'intacct_wins';
}): MergeResult {
  const rule = input.ruleOverride ?? input.settings.conflict;
  return threeWayMerge({
    fields: mergeFieldsFor(input.entity, input.settings),
    base: input.base, vireek: input.vireek, crm: input.intacct,
    rule: rule === 'intacct_wins' ? 'crm_wins' : rule,
    vireekTs: input.vireekTs, crmTs: input.intacctTs,
  });
}

// ============================================================
// SMALL HELPERS
// ============================================================

export type RawRecord = Record<string, unknown>;
export const toCents = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/,/g, '')) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
export const fromCents = (cents: number): string => (Math.round(cents) / 100).toFixed(2);
export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const obj = (v: unknown): RawRecord => (v && typeof v === 'object' && !Array.isArray(v) ? (v as RawRecord) : {});
export const isRecordNo = (s: unknown): s is string => typeof s === 'string' && /^\d{1,18}$/.test(s);

/** Read a field from a parsed record: flat dotted key ("DISPLAYCONTACT.EMAIL1") or nested path. Keys are UPPERCASE. */
export function field(rec: RawRecord, path: string): string | null {
  const key = path.toUpperCase();
  if (key in rec) { const v = rec[key]; return typeof v === 'string' ? str(v) : null; }
  let cur: unknown = rec;
  for (const part of key.split('.')) {
    cur = obj(cur)[part];
    if (cur === undefined) return null;
  }
  return typeof cur === 'string' ? str(cur) : null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** "YYYY-MM-DD" | "MM/DD/YYYY[ hh:mm:ss]" -> "YYYY-MM-DD". */
export function parseIaDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  return m ? `${m[3]}-${pad(+m[1])}-${pad(+m[2])}` : null;
}
/** Naive Intacct timestamp (company clock) read as UTC. The pull overlap absorbs the real offset. */
export function parseIaTimestamp(v: unknown): number | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}):?(\d{2})?)?/.exec(s);
  if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):?(\d{2})?)?/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return null;
}
export const iaTimestamp = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

/** Deterministic Intacct identifiers derived from a Vireek uuid: a replayed create hits "already exists" instead of duplicating. */
const hex = (uuid: string) => uuid.replace(/-/g, '').toLowerCase();
export const iaCustomerId = (vireekId: string): string => `VK-${hex(vireekId).slice(0, 16)}`;
export const iaPaymentDoc = (vireekId: string): string => `VK-P-${hex(vireekId)}`;
export const iaInvoiceDoc = (vireekId: string): string => `VK-I-${hex(vireekId)}`;
export const iaTitle = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 100);
/** Vireek uuid hidden in a reference this engine generated (VK-P-<32 hex> / VK-I-<32 hex>); null for anything else. */
export function vireekIdFromRef(ref: string | null | undefined, prefix: 'VK-P-' | 'VK-I-'): string | null {
  const m = new RegExp(`^${prefix}([0-9a-f]{32})$`).exec(ref ?? '');
  if (!m) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const paymentLinkKey = (paymentNo: string, invoiceNo: string) => `${paymentNo}:${invoiceNo}`;
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// ============================================================
// XML (minimal, dependency-free, DTD-rejecting)
// ============================================================

export class IaXmlError extends Error {}
export interface XNode { name: string; attrs: Record<string, string>; children: XNode[]; text: string }

export function xmlEscape(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'quot') return '"'; if (e === 'apos') return "'";
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  });

export function parseXml(src: string): XNode {
  if (src.length > 8_000_000) throw new IaXmlError('XML too large.');
  if (/<!DOCTYPE|<!ENTITY/i.test(src)) throw new IaXmlError('DTDs are not allowed.');
  const stack: XNode[] = [];
  let root: XNode | null = null;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) break;
    if (lt > i && stack.length) stack[stack.length - 1].text += decode(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); if (e < 0) throw new IaXmlError('Unterminated comment.'); i = e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt); if (e < 0) throw new IaXmlError('Unterminated CDATA.');
      if (stack.length) stack[stack.length - 1].text += src.slice(lt + 9, e);
      i = e + 3; continue;
    }
    if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt); if (e < 0) throw new IaXmlError('Unterminated declaration.'); i = e + 2; continue; }
    let gt = lt + 1; let q = '';
    while (gt < n) { const c = src[gt]; if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; gt++; }
    if (gt >= n) throw new IaXmlError('Unterminated tag.');
    const inner = src.slice(lt + 1, gt);
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const top = stack.pop();
      if (!top || top.name !== name) throw new IaXmlError(`Mismatched closing tag </${name}>.`);
      if (!stack.length) { root = top; i = gt + 1; break; }
    } else {
      const selfClose = inner.endsWith('/');
      const body = selfClose ? inner.slice(0, -1) : inner;
      const m = /^([^\s/>]+)([\s\S]*)$/.exec(body.trim());
      if (!m) throw new IaXmlError('Empty tag.');
      const attrs: Record<string, string> = {};
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = re.exec(m[2]))) attrs[a[1]] = decode(a[3] ?? a[4] ?? '');
      const node: XNode = { name: m[1], attrs, children: [], text: '' };
      if (stack.length) stack[stack.length - 1].children.push(node);
      if (selfClose) { if (!stack.length) { root = node; i = gt + 1; break; } }
      else { stack.push(node); if (stack.length > 40) throw new IaXmlError('XML nested too deeply.'); }
    }
    i = gt + 1;
  }
  if (!root || stack.length) throw new IaXmlError('Malformed XML.');
  return root;
}

const lc = (s: string) => s.toLowerCase();
export const childOf = (n: XNode | null | undefined, name: string): XNode | null => n?.children.find((c) => lc(c.name) === lc(name)) ?? null;
export const childrenOf = (n: XNode | null | undefined, name: string): XNode[] => (n?.children ?? []).filter((c) => lc(c.name) === lc(name));
export const textOf = (n: XNode | null | undefined, name?: string): string => ((name ? childOf(n, name) : n)?.text ?? '').trim();

/** Convert an element into a plain record with UPPERCASE keys; repeated names become arrays. */
export function nodeToRecord(n: XNode): RawRecord {
  const out: RawRecord = {};
  for (const c of n.children) {
    const k = c.name.toUpperCase();
    const v: unknown = c.children.length ? nodeToRecord(c) : c.text.trim();
    if (k in out) out[k] = Array.isArray(out[k]) ? [...(out[k] as unknown[]), v] : [out[k], v];
    else out[k] = v;
  }
  return out;
}

// ============================================================
// REQUEST BUILDERS (every shape here is a VERIFY item)
// ============================================================

export const IA_GATEWAY = 'https://api.intacct.com/ia/xml/xmlgw.phtml';
export function isAllowedGateway(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.port && !u.username && (u.hostname === 'api.intacct.com' || u.hostname.endsWith('.intacct.com')) && u.pathname === '/ia/xml/xmlgw.phtml';
  } catch { return false; }
}

export interface IaCredentials { companyId: string; userId: string; password: string; entityId?: string | null }
export const isValidCompanyId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_.\-]{1,40}$/.test(s);
export const isValidUserId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_.@\-]{1,64}$/.test(s);
export const isValidEntityId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_.\-]{1,40}$/.test(s);
// eslint-disable-next-line no-control-regex
export const isValidPassword = (s: unknown): s is string => typeof s === 'string' && s.length >= 1 && s.length <= 200 && !/[\u0000-\u001F]/.test(s);

export interface IaFn { name: string; controlId: string; xml: string }
export type IaAuth = { kind: 'login'; creds: IaCredentials } | { kind: 'session'; sessionId: string };

const el = (name: string, v: string | null | undefined) => (v === null || v === undefined ? '' : `<${name}>${xmlEscape(v)}</${name}>`);

export function buildRequest(p: { senderId: string; senderPassword: string; auth: IaAuth; fns: IaFn[]; controlId: string; transaction?: boolean }): string {
  const auth = p.auth.kind === 'login'
    ? `<login>${el('userid', p.auth.creds.userId)}${el('companyid', p.auth.creds.companyId)}${el('password', p.auth.creds.password)}${p.auth.creds.entityId ? el('locationid', p.auth.creds.entityId) : ''}</login>`
    : el('sessionid', p.auth.sessionId);
  const fns = p.fns.map((f) => `<function controlid="${xmlEscape(f.controlId)}">${f.xml}</function>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><request><control>${el('senderid', p.senderId)}${el('password', p.senderPassword)}${el('controlid', p.controlId)}<uniqueid>false</uniqueid><dtdversion>3.0</dtdversion><includewhitespace>false</includewhitespace></control><operation${p.transaction ? ' transaction="true"' : ''}><authentication>${auth}</authentication><content>${fns}</content></operation></request>`;
}

// ---- objects + fields (VERIFY against your Intacct sandbox) ------------------
export const IA_OBJECTS = {
  account: { object: 'GLACCOUNT', select: ['RECORDNO', 'ACCOUNTNO', 'TITLE', 'ACCOUNTTYPE', 'NORMALBALANCE', 'STATUS', 'WHENMODIFIED'] },
  customer: { object: 'CUSTOMER', select: ['RECORDNO', 'CUSTOMERID', 'NAME', 'STATUS', 'COMMENTS', 'DISPLAYCONTACT.EMAIL1', 'DISPLAYCONTACT.PHONE1', 'DISPLAYCONTACT.MAILADDRESS.ADDRESS1', 'DISPLAYCONTACT.MAILADDRESS.ADDRESS2', 'DISPLAYCONTACT.MAILADDRESS.CITY', 'DISPLAYCONTACT.MAILADDRESS.STATE', 'DISPLAYCONTACT.MAILADDRESS.ZIP', 'WHENMODIFIED'] },
  invoice: { object: 'ARINVOICE', select: ['RECORDNO', 'RECORDID', 'DOCNUMBER', 'CUSTOMERID', 'WHENCREATED', 'WHENDUE', 'TOTALENTERED', 'TOTALPAID', 'TOTALDUE', 'STATE', 'CURRENCY', 'WHENMODIFIED'] },
  invoiceLine: { object: 'ARINVOICEITEM', select: ['RECORDNO', 'RECORDKEY', 'LINE_NO', 'ACCOUNTNO', 'ENTRYDESCRIPTION', 'TRX_AMOUNT'] },
  payment: { object: 'ARPYMT', select: ['RECORDNO', 'CUSTOMERID', 'PAYMENTMETHOD', 'RECEIPTDATE', 'TRX_TOTALENTERED', 'DOCNUMBER', 'FINANCIALENTITY', 'STATE', 'CURRENCY', 'WHENMODIFIED'] },
  paymentLine: { object: 'ARPYMTDETAIL', select: ['RECORDNO', 'PAYMENTKEY', 'RECORDKEY', 'TRX_PAYMENTAMOUNT'] },
  bank: { object: 'CHECKINGACCOUNT', select: ['BANKACCOUNTID', 'BANKNAME', 'STATUS'] },
} as const;
export type IaObjectKey = keyof typeof IA_OBJECTS;

export type IaFilter =
  | { op: 'eq' | 'gte' | 'gt'; field: string; value: string }
  | { op: 'in'; field: string; values: string[] }
  | { op: 'and'; of: IaFilter[] };

const FIELD_RE = /^[A-Z][A-Z0-9_.]{0,63}$/;
const checkField = (f: string) => { if (!FIELD_RE.test(f)) throw new Error('Invalid field name.'); return f; };
const OPS = { eq: 'equalto', gte: 'greaterthanorequalto', gt: 'greaterthan' } as const;

export function renderFilter(f: IaFilter): string {
  if (f.op === 'and') return f.of.length === 1 ? renderFilter(f.of[0]) : `<and>${f.of.map(renderFilter).join('')}</and>`;
  if (f.op === 'in') return `<in>${el('field', checkField(f.field))}${f.values.map((v) => el('value', v)).join('')}</in>`;
  return `<${OPS[f.op]}>${el('field', checkField(f.field))}${el('value', f.value)}</${OPS[f.op]}>`;
}

export function fnQuery(c: { controlId: string; object: IaObjectKey; filter?: IaFilter | null; orderBy?: string; pageSize?: number; offset?: number; select?: readonly string[] }): IaFn {
  const spec = IA_OBJECTS[c.object];
  const sel = (c.select ?? spec.select).map((s) => el('field', checkField(s))).join('');
  const size = Math.min(1000, Math.max(1, Math.floor(c.pageSize ?? IA_PAGE)));
  return {
    name: 'query', controlId: c.controlId,
    xml: `<query>${el('object', spec.object)}<select>${sel}</select>${c.filter ? `<filter>${renderFilter(c.filter)}</filter>` : ''}${c.orderBy ? `<orderby><order>${el('field', checkField(c.orderBy))}<ascending/></order></orderby>` : ''}${el('pagesize', String(size))}${c.offset ? el('offset', String(Math.max(0, Math.floor(c.offset)))) : ''}</query>`,
  };
}
export const fnGetSession = (controlId: string): IaFn => ({ name: 'getAPISession', controlId, xml: '<getAPISession/>' });

/** One keyset page of changed records, ordered by RECORDNO so the cursor survives across runs. */
export function fnPull(c: { controlId: string; entity: IaEntity; since: number | null; afterRecordNo: number; pageSize?: number }): IaFn {
  const parts: IaFilter[] = [{ op: 'gt', field: 'RECORDNO', value: String(Math.max(0, Math.floor(c.afterRecordNo))) }];
  if (c.since !== null) parts.push({ op: 'gte', field: 'WHENMODIFIED', value: iaTimestamp(c.since) });
  return fnQuery({ controlId: c.controlId, object: c.entity, filter: { op: 'and', of: parts }, orderBy: 'RECORDNO', pageSize: c.pageSize });
}
const FIND_FIELDS: Record<IaEntity, string[]> = { account: ['ACCOUNTNO', 'RECORDNO'], customer: ['CUSTOMERID', 'NAME', 'RECORDNO'], invoice: ['RECORDID', 'DOCNUMBER', 'RECORDNO'], payment: ['DOCNUMBER', 'RECORDNO'] };
export function fnFind(c: { controlId: string; entity: IaEntity; field: string; value: string }): IaFn {
  if (!FIND_FIELDS[c.entity].includes(c.field)) throw new Error('Unsupported lookup field.');
  return fnQuery({ controlId: c.controlId, object: c.entity, filter: { op: 'eq', field: c.field, value: c.value }, orderBy: 'RECORDNO', pageSize: 5 });
}
export const fnLinesFor = (c: { controlId: string; kind: 'invoiceLine' | 'paymentLine'; keys: string[] }): IaFn => {
  if (!c.keys.every(isRecordNo)) throw new Error('Invalid record number.');
  return fnQuery({ controlId: c.controlId, object: c.kind, filter: { op: 'in', field: c.kind === 'invoiceLine' ? 'RECORDKEY' : 'PAYMENTKEY', values: c.keys }, orderBy: 'RECORDNO', pageSize: 1000 });
};

// ---- write functions (legacy named functions; VERIFY) -------------------------
const dateEl = (name: string, iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); if (!m) throw new Error('Invalid date.'); return `<${name}><year>${m[1]}</year><month>${m[2]}</month><day>${m[3]}</day></${name}>`; };

export function fnCreateCustomer(controlId: string, customerId: string, v: Canon): IaFn {
  if (!IA_ID.test(customerId)) throw new Error('Invalid customer id.');
  const name = iaTitle(String(v.name ?? ''));
  return { name: 'create_customer', controlId, xml: `<create_customer>${el('customerid', customerId)}${el('name', name)}<status>active</status>${v.notes ? el('comments', String(v.notes).slice(0, 4000)) : ''}<displaycontact>${el('contactname', `${name} (${customerId})`.slice(0, 200))}${el('printas', name)}${v.email ? el('email1', String(v.email).slice(0, 200)) : ''}${v.phone ? el('phone1', String(v.phone).slice(0, 30)) : ''}${v.address ? `<mailaddress>${el('address1', String(v.address).slice(0, 200))}</mailaddress>` : ''}</displaycontact></create_customer>` };
}
export function fnUpdateCustomer(controlId: string, customerId: string, v: Canon): IaFn {
  if (!IA_ID.test(customerId)) throw new Error('Invalid customer id.');
  const has = (k: string) => Object.prototype.hasOwnProperty.call(v, k);
  const contact = `${has('email') ? el('email1', v.email ? String(v.email).slice(0, 200) : '') : ''}${has('phone') ? el('phone1', v.phone ? String(v.phone).slice(0, 30) : '') : ''}${has('address') && v.address ? `<mailaddress>${el('address1', String(v.address).slice(0, 200))}</mailaddress>` : ''}`;
  return { name: 'update_customer', controlId, xml: `<update_customer>${el('customerid', customerId)}${has('name') && v.name ? el('name', iaTitle(String(v.name))) : ''}${has('notes') ? el('comments', v.notes ? String(v.notes).slice(0, 4000) : '') : ''}${contact ? `<displaycontact>${contact}</displaycontact>` : ''}</update_customer>` };
}

export type VireekAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export const normalBalanceFor = (t: VireekAccountType): 'debit' | 'credit' => (t === 'asset' || t === 'expense' ? 'debit' : 'credit');
/** Deterministic: Intacct has two statement types + a normal balance; the first digit separates equity from liabilities and revenue from expenses. */
export function accountTypeFromIntacct(raw: RawRecord): VireekAccountType | null {
  const kind = (field(raw, 'ACCOUNTTYPE') ?? '').toLowerCase().replace(/\s+/g, '');
  const bal = (field(raw, 'NORMALBALANCE') ?? '').toLowerCase();
  const first = (field(raw, 'ACCOUNTNO') ?? '')[0];
  if (bal !== 'debit' && bal !== 'credit') return null;
  if (kind === 'balancesheet') return bal === 'debit' ? 'asset' : first === '3' ? 'equity' : 'liability';
  if (kind === 'incomestatement') return bal === 'credit' ? 'revenue' : 'expense';
  return null;
}
export const generatedAccountCode = (recordNo: string): string => `IA${recordNo}`.slice(0, 20);

export function fnCreateAccount(controlId: string, v: Canon, type: VireekAccountType): IaFn {
  const code = String(v.code ?? '');
  if (!IA_ID.test(code)) throw new Error('Invalid account number.');
  const bs = type === 'asset' || type === 'liability' || type === 'equity';
  return { name: 'create_glaccount', controlId, xml: `<create_glaccount>${el('glaccountno', code)}${el('title', iaTitle(String(v.name ?? code)))}${el('normalbalance', normalBalanceFor(type))}${el('accounttype', bs ? 'balancesheet' : 'incomestatement')}${el('closingtype', bs ? 'non-closing account' : 'closing account')}<status>${v.active === 'inactive' ? 'inactive' : 'active'}</status></create_glaccount>` };
}
export function fnUpdateAccount(controlId: string, accountNo: string, v: Canon): IaFn {
  if (!IA_ID.test(accountNo)) throw new Error('Invalid account number.');
  const has = (k: string) => Object.prototype.hasOwnProperty.call(v, k);
  return { name: 'update_glaccount', controlId, xml: `<update_glaccount>${el('glaccountno', accountNo)}${has('name') && v.name ? el('title', iaTitle(String(v.name))) : ''}${has('active') ? `<status>${v.active === 'inactive' ? 'inactive' : 'active'}</status>` : ''}</update_glaccount>` };
}

// ============================================================
// INVOICES
// ============================================================

export interface InvoiceLine { description: string; qty: number; unitPriceCents: number; amountCents: number; accountNo: string | null }
export interface IaInvoiceDoc {
  id: string; docNumber: string | null; ref: string | null; customerId: string | null; txnDate: string | null; dueDate: string | null;
  lines: InvoiceLine[]; subtotalCents: number; taxCents: number; totalCents: number; paidCents: number; voided: boolean; modifiedAt: number | null;
}
export type InvoiceParse = { ok: true; doc: IaInvoiceDoc } | { ok: false; reason: string };

/** `accountTypes` maps linked GL account numbers to their Vireek type, so tax or other non-revenue lines are never booked as revenue. */
export function parseIaInvoice(h: RawRecord, lineRecs: RawRecord[], defaults: Pick<IaDefaults, 'taxAccountNo'>, accountTypes?: ReadonlyMap<string, string>): InvoiceParse {
  const id = field(h, 'RECORDNO');
  if (!id) return { ok: false, reason: 'Invoice has no record number.' };
  const cur = field(h, 'CURRENCY');
  if (cur && cur.toUpperCase() !== 'USD') return { ok: false, reason: `Currency ${cur} is not supported (Vireek ledgers are single-currency).` };
  const state = (field(h, 'STATE') ?? '').toLowerCase();
  const base = { id, docNumber: field(h, 'RECORDID'), ref: field(h, 'DOCNUMBER'), customerId: field(h, 'CUSTOMERID'), txnDate: parseIaDate(field(h, 'WHENCREATED')), dueDate: parseIaDate(field(h, 'WHENDUE')), modifiedAt: parseIaTimestamp(field(h, 'WHENMODIFIED')) };
  if (state === 'reversed') return { ok: true, doc: { ...base, lines: [], subtotalCents: 0, taxCents: 0, totalCents: 0, paidCents: 0, voided: true } };
  if (/^(draft|submitted|declined|reversal.*|void.*)$/.test(state)) return { ok: false, reason: `Invoice state "${field(h, 'STATE')}" is not posted.` };
  const lines: InvoiceLine[] = [];
  let tax = 0;
  for (const l of [...lineRecs].sort((a, b) => Number(field(a, 'LINE_NO') ?? 0) - Number(field(b, 'LINE_NO') ?? 0))) {
    const amountCents = toCents(field(l, 'TRX_AMOUNT'));
    const acct = field(l, 'ACCOUNTNO');
    if (amountCents < 0) return { ok: false, reason: 'Negative lines (discounts) are not supported.' };
    if (defaults.taxAccountNo && acct === defaults.taxAccountNo) { tax += amountCents; continue; }
    const t = acct ? accountTypes?.get(acct) : undefined;
    if (t && t !== 'revenue') return { ok: false, reason: `Line posts to ${t} account ${acct}, not revenue. Choose the sales tax account under Mapping → Defaults.` };
    lines.push({ description: (field(l, 'ENTRYDESCRIPTION') ?? 'Item').slice(0, 1000), qty: 1, unitPriceCents: amountCents, amountCents, accountNo: acct });
  }
  if (!lines.length) return { ok: false, reason: 'Invoice has no revenue lines.' };
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const totalCents = toCents(field(h, 'TOTALENTERED'));
  if (subtotalCents + tax !== totalCents) return { ok: false, reason: 'Totals do not add up (tax account not mapped under Mapping → Defaults, or a header-level adjustment).' };
  return { ok: true, doc: { ...base, lines, subtotalCents, taxCents: tax, totalCents, paidCents: toCents(field(h, 'TOTALPAID')), voided: false } };
}

/** Amount signature. Line descriptions and quantities are cosmetic in Intacct (it has no quantity), so only money is compared. */
export function invoiceAmountSig(i: { lines: { amountCents: number }[]; taxCents: number; totalCents: number }): string {
  return `${i.totalCents}|${i.taxCents}|${i.lines.map((l) => l.amountCents).join(',')}`;
}

export interface VireekInvoiceInput { invoiceNumber: string; issueDate: string; dueDate: string; taxCents: number; lines: InvoiceLine[] }
export function fnCreateInvoice(controlId: string, inv: VireekInvoiceInput, customerId: string, d: { taxAccountNo: string | null; sendInvoiceNumber: boolean }, docRef: string): IaFn | { error: string } {
  if (inv.taxCents > 0 && !d.taxAccountNo) return { error: 'This invoice has sales tax. Choose a sales tax account under Mapping → Defaults.' };
  if (inv.lines.some((l) => !l.accountNo)) return { error: 'A line has no revenue account. Choose a default revenue account under Mapping → Defaults.' };
  const items = inv.lines.map((l) => {
    const exact = l.qty === 1 || Math.abs(l.qty * l.unitPriceCents - l.amountCents) < 0.5;
    const memo = exact && l.qty !== 1 ? `${l.description} (${l.qty} x ${fromCents(l.unitPriceCents)})` : l.description;
    return `<lineitem>${el('glaccountno', l.accountNo)}${el('amount', fromCents(l.amountCents))}${el('memo', memo.slice(0, 500))}</lineitem>`;
  });
  if (inv.taxCents > 0) items.push(`<lineitem>${el('glaccountno', d.taxAccountNo)}${el('amount', fromCents(inv.taxCents))}<memo>Sales tax</memo></lineitem>`);
  return { name: 'create_invoice', controlId, xml: `<create_invoice>${el('customerid', customerId)}${dateEl('datecreated', inv.issueDate)}${dateEl('datedue', inv.dueDate)}${el('invoiceno', d.sendInvoiceNumber ? inv.invoiceNumber.slice(0, 40) : docRef)}${el('ponumber', docRef)}${el('description', `Vireek ${inv.invoiceNumber}`.slice(0, 200))}<invoiceitems>${items.join('')}</invoiceitems></create_invoice>` };
}
export const fnUpdateInvoiceDue = (controlId: string, recordNo: string, dueDate: string): IaFn => {
  if (!isRecordNo(recordNo)) throw new Error('Invalid record number.');
  return { name: 'update_invoice', controlId, xml: `<update_invoice key="${recordNo}">${dateEl('datedue', dueDate)}</update_invoice>` };
};

// ============================================================
// PAYMENTS
// ============================================================

export interface IaPaymentDoc {
  id: string; docNumber: string | null; customerId: string | null; totalCents: number; txnDate: string | null; bankAccountId: string | null; methodName: string | null;
  applications: { invoiceNo: string; amountCents: number }[]; voided: boolean; modifiedAt: number | null;
}
export function parseIaPayment(h: RawRecord, details: RawRecord[]): IaPaymentDoc | null {
  const id = field(h, 'RECORDNO');
  if (!id) return null;
  const apps = details.map((d) => ({ invoiceNo: field(d, 'RECORDKEY') ?? '', amountCents: toCents(field(d, 'TRX_PAYMENTAMOUNT')) })).filter((a) => isRecordNo(a.invoiceNo) && a.amountCents > 0);
  return {
    id, docNumber: field(h, 'DOCNUMBER'), customerId: field(h, 'CUSTOMERID'), totalCents: toCents(field(h, 'TRX_TOTALENTERED')), txnDate: parseIaDate(field(h, 'RECEIPTDATE')),
    bankAccountId: field(h, 'FINANCIALENTITY'), methodName: field(h, 'PAYMENTMETHOD'), applications: apps,
    voided: /reversed|void/i.test(field(h, 'STATE') ?? ''), modifiedAt: parseIaTimestamp(field(h, 'WHENMODIFIED')),
  };
}
export type VireekPaymentMethod = 'card' | 'ach' | 'check' | 'cash' | 'other';
export function paymentMethodFromName(name: string | null): VireekPaymentMethod {
  const n = (name ?? '').toLowerCase();
  if (!n) return 'other';
  if (/check|cheque/.test(n)) return 'check';
  if (/cash/.test(n)) return 'cash';
  if (/eft|ach|bank|transfer|wire/.test(n)) return 'ach';
  if (/card|visa|master|amex/.test(n)) return 'card';
  return 'other';
}
export const IA_PAYMENT_METHOD: Record<VireekPaymentMethod, string> = { card: 'Credit Card', ach: 'EFT', check: 'Printed Check', cash: 'Cash', other: 'EFT' }; // VERIFY
export function fnCreatePayment(controlId: string, p: { customerId: string; invoiceNo: string; amountCents: number; date: string; bankAccountId: string; method: VireekPaymentMethod; docRef: string; memo: string }): IaFn {
  if (!isRecordNo(p.invoiceNo)) throw new Error('Invalid invoice number.');
  return { name: 'create_arpayment', controlId, xml: `<create_arpayment>${el('customerid', p.customerId)}${el('paymentmethod', IA_PAYMENT_METHOD[p.method])}${el('bankaccountid', p.bankAccountId)}${dateEl('receiptdate', p.date)}${el('amountreceived', fromCents(p.amountCents))}${el('refid', p.docRef)}${el('documentnumber', p.docRef)}${el('memo', p.memo.slice(0, 500))}<arpaymentitem>${el('invoicekey', p.invoiceNo)}${el('amount', fromCents(p.amountCents))}</arpaymentitem></create_arpayment>` };
}

// ============================================================
// CUSTOMERS / ACCOUNTS <-> CANON
// ============================================================

export function composeAddress(raw: RawRecord): string | null {
  const g = (k: string) => field(raw, `DISPLAYCONTACT.MAILADDRESS.${k}`);
  const parts = [g('ADDRESS1'), g('ADDRESS2'), g('CITY'), [g('STATE'), g('ZIP')].filter(Boolean).join(' ') || null].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}
export function intacctToCanon(entity: 'account' | 'customer', raw: RawRecord): Canon {
  if (entity === 'customer') return { name: field(raw, 'NAME'), email: field(raw, 'DISPLAYCONTACT.EMAIL1'), phone: field(raw, 'DISPLAYCONTACT.PHONE1'), address: composeAddress(raw), notes: field(raw, 'COMMENTS') };
  return { code: field(raw, 'ACCOUNTNO'), name: field(raw, 'TITLE'), active: (field(raw, 'STATUS') ?? '').toLowerCase() === 'inactive' ? 'inactive' : 'active' };
}
export const recordMeta = (raw: RawRecord): { id: string; modifiedAt: number | null } => ({ id: field(raw, 'RECORDNO') ?? '', modifiedAt: parseIaTimestamp(field(raw, 'WHENMODIFIED')) });

// ============================================================
// RESPONSES + FAULTS
// ============================================================

export interface IaError { code: string; message: string; detail: string; correction: string }
export interface IaResult { fn: string; controlId: string; ok: boolean; errors: IaError[]; records: RawRecord[]; count: number; totalCount: number; numRemaining: number }
export interface IaResponse { controlOk: boolean; controlErrors: IaError[]; authOk: boolean; authErrors: IaError[]; results: IaResult[]; data: XNode | null }

function readErrors(n: XNode | null): IaError[] {
  const out: IaError[] = [];
  const walk = (x: XNode) => {
    for (const c of x.children) {
      if (lc(c.name) === 'errormessage') for (const e of childrenOf(c, 'error')) out.push({ code: textOf(e, 'errorno'), message: (textOf(e, 'description2') || textOf(e, 'description')).slice(0, 300), detail: textOf(e, 'description').slice(0, 300), correction: textOf(e, 'correction').slice(0, 300) });
    }
  };
  if (n) walk(n);
  return out;
}

export function parseResponse(xml: string): IaResponse {
  const root = parseXml(xml);
  if (lc(root.name) !== 'response') throw new IaXmlError('Not an Intacct response.');
  const control = childOf(root, 'control');
  const op = childOf(root, 'operation');
  const auth = childOf(op, 'authentication');
  const controlOk = lc(textOf(control, 'status')) === 'success';
  const authOk = !op || !auth ? true : lc(textOf(auth, 'status')) === 'success';
  const results: IaResult[] = childrenOf(op, 'result').map((r) => {
    const data = childOf(r, 'data');
    const records = (data?.children ?? []).map(nodeToRecord);
    const a = data?.attrs ?? {};
    return {
      fn: textOf(r, 'function'), controlId: textOf(r, 'controlid'), ok: lc(textOf(r, 'status')) === 'success', errors: readErrors(r),
      records, count: Number(a.count ?? records.length) || 0, totalCount: Number(a.totalcount ?? records.length) || 0, numRemaining: Number(a.numremaining ?? 0) || 0,
    };
  });
  return { controlOk, controlErrors: controlOk ? [] : readErrors(root), authOk, authErrors: readErrors(auth), results, data: childOf(childOf(op, 'result'), 'data') };
}
export function parseSession(r: IaResponse): { id: string; endpoint: string } | null {
  const api = childOf(r.data, 'api');
  const id = textOf(api, 'sessionid');
  const endpoint = textOf(api, 'endpoint');
  return id ? { id, endpoint } : null;
}

export type IaFaultKind = 'ok' | 'auth' | 'throttle' | 'duplicate' | 'notfound' | 'validation' | 'error';
// VERIFY: patterns are matched on the human-readable message because Intacct error numbers differ between functions.
export function classifyFault(errors: IaError[]): IaFaultKind {
  if (!errors.length) return 'ok';
  const t = errors.map((e) => `${e.code} ${e.message} ${e.detail}`).join(' | ');
  if (/sign-?in information|invalid session|session (has )?(expired|is invalid|not valid)|login (failed|incorrect)|incorrect password|authentication failed/i.test(t)) return 'auth';
  if (/too many requests|rate limit|throttl|exceeded the (maximum|number)/i.test(t)) return 'throttle';
  if (/already exists|duplicate|must be unique|is not unique/i.test(t)) return 'duplicate';
  if (/not found|does not exist|no such/i.test(t)) return 'notfound';
  return 'validation';
}
export const faultText = (errors: IaError[]): string => errors.map((e) => `${e.message}${e.correction ? ` (${e.correction})` : ''}`).join('; ').slice(0, 300) || 'Unknown error';

// ============================================================
// STATS
// ============================================================

export interface SyncStats { created_vireek: number; updated_vireek: number; created_intacct: number; updated_intacct: number; skipped: number; conflicts: number; errors: number }
export const emptyStats = (): SyncStats => ({ created_vireek: 0, updated_vireek: 0, created_intacct: 0, updated_intacct: 0, skipped: 0, conflicts: 0, errors: 0 });
