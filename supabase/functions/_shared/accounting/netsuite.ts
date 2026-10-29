// supabase/functions/_shared/accounting/netsuite.ts
//
// Oracle NetSuite adapter (REST Record Service + SuiteQL): pure request builders, parsers and mappers.
//
//   Auth     : OAuth 2.0 CLIENT CREDENTIALS (machine-to-machine). Vireek signs a short-lived JWT with its own
//              private key (ES256 by default, PS256 supported); the customer uploads the matching public
//              certificate in NetSuite and gives us Account ID, Client ID and Certificate ID. Access tokens
//              last 60 minutes and there is no refresh token to expire (the authorization-code flow would
//              force a reconnect every 7 days, which is unusable for unattended sync).
//   Lists    : SuiteQL (id + change marker only), then a record GET only for rows whose marker changed.
//   Writes   : REST answers 204 + Location, so every write is followed by a GET (caps.refetchAfterWrite).
//   Payments : created with POST invoice/{id}/!transform/customerPayment so they apply to the invoice.
//   Limits   : NetSuite cannot void an invoice through REST: voids flow NetSuite -> Vireek only.
//   Tax      : NetSuite calculates tax from the tax code; a total that differs is reported, never forced.

import {
  accountTypeFromClassification,
  arr,
  dateOnly,
  fromCents,
  num,
  obj,
  parseTokenResponse,
  parseTimestamp,
  sqlLiteral,
  str,
  toCents,
  type AcctEntity,
  type Adapter,
  type AuthAdapter,
  type Canon,
  type ConnInfo,
  type ExtInvoiceDoc,
  type ExtPaymentDoc,
  type HttpReq,
  type InvoiceLine,
  type InvoiceParse,
  type OptionRow,
  type OptionsSpec,
  type Provider,
  type RawRecord,
  type SimpleEntity,
  type VireekAccountType,
} from './core.ts';
import { b64url } from '../crm/engine.ts';

export const NS_ACCOUNT_ID = /^[A-Za-z0-9]{3,24}(_[A-Za-z0-9]{1,10})?$/;
export const NS_PAGE = 1000;

export const nsNormalizeAccountId = (s: string): string | null => {
  const t = s.trim().toUpperCase().replace(/-/g, '_');
  return NS_ACCOUNT_ID.test(t) ? t : null;
};
export const nsHost = (accountId: string): string => `${accountId.toLowerCase().replace(/_/g, '-')}.suitetalk.api.netsuite.com`;
export const nsBase = (accountId: string): string => `https://${nsHost(accountId)}/services/rest`;
export const nsTokenUrl = (accountId: string): string => `${nsBase(accountId)}/auth/oauth2/v1/token`;

const RECORD: Record<AcctEntity, string> = { account: 'account', customer: 'customer', item: 'serviceSaleItem', invoice: 'invoice', payment: 'customerpayment' };

/** Last path segment of a Location header (the id of a freshly created record). */
export const idFromLocation = (loc: string | null): string | null => {
  const m = /\/([A-Za-z0-9_-]+)\/?(?:\?.*)?$/.exec(loc ?? '');
  return m ? m[1] : null;
};

const ts = (iso: string): string | null => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : null;
};
const suiteql = (c: ConnInfo, q: string, offset = 0, limit = NS_PAGE): HttpReq => ({
  method: 'POST',
  url: `${nsBase(c.tenantId)}/query/v1/suiteql?limit=${limit}&offset=${Math.max(0, Math.floor(offset))}`,
  headers: { Prefer: 'transient' },
  body: { q },
});

const LM = "TO_CHAR(lastmodifieddate, 'YYYY-MM-DD HH24:MI:SS')";
const LIST_SQL: Record<AcctEntity, string> = {
  customer: `SELECT id, ${LM} AS lm FROM customer`,
  account: `SELECT id, ${LM} AS lm FROM account`,
  item: `SELECT id, ${LM} AS lm FROM item WHERE itemtype IN ('Service', 'NonInvtPart')`,
  invoice: `SELECT id, ${LM} AS lm FROM transaction WHERE type = 'CustInvc'`,
  payment: `SELECT id, ${LM} AS lm FROM transaction WHERE type = 'CustPymt'`,
};

const ACCOUNT_CLASS: Record<string, 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'> = {
  Bank: 'asset', AcctRec: 'asset', OthCurrAsset: 'asset', FixedAsset: 'asset', OthAsset: 'asset', DeferExpense: 'asset', UnbilledRec: 'asset',
  AcctPay: 'liability', CredCard: 'liability', OthCurrLiab: 'liability', LongTermLiab: 'liability', DeferRevenue: 'liability',
  Equity: 'equity', Income: 'revenue', OthIncome: 'revenue', COGS: 'expense', Expense: 'expense', OthExpense: 'expense',
};
const refId = (v: unknown): string | null => str(obj(v).id);

function meta(_e: AcctEntity, raw: RawRecord): { id: string; version: string; modifiedAt: number | null } {
  const lm = str(raw.lastModifiedDate) ?? str(raw.lastmodifieddate);
  return { id: String(raw.id ?? ''), version: lm ?? '', modifiedAt: parseTimestamp(lm) };
}

function classifyResponse(status: number, json: unknown) {
  const j = obj(json);
  const detail = str(obj(arr(j['o:errorDetails'])[0]).detail);
  const message = (detail ?? str(j.title) ?? str(j.error_description) ?? `HTTP ${status}`).slice(0, 300);
  if (status >= 200 && status < 300) return { kind: 'ok' as const, message: '' };
  if (status === 401) return { kind: 'auth' as const, message };
  if (status === 429) return { kind: 'throttle' as const, message };
  if (status === 404) return { kind: 'notfound' as const, message };
  if (status === 400 || status === 403 || status === 422) return { kind: /already exist|duplicate/i.test(message) ? ('duplicate' as const) : ('validation' as const), message };
  return { kind: 'error' as const, message };
}

function parseInvoice(raw: RawRecord, currency: string): InvoiceParse {
  const m = meta('invoice', raw);
  if (!m.id) return { ok: false, reason: 'Invoice has no id.' };
  const cur = str(obj(raw.currency).refName);
  if (cur && cur !== currency && !/^\d+$/.test(cur)) return { ok: false, reason: `Currency ${cur} is not supported (Vireek books are in ${currency}).` };
  const head = {
    id: m.id,
    version: m.version,
    docNumber: str(raw.tranId),
    customerId: refId(raw.entity),
    txnDate: dateOnly(raw.tranDate),
    dueDate: dateOnly(raw.dueDate),
    modifiedAt: m.modifiedAt,
  };
  const statusName = String(obj(raw.status).refName ?? obj(raw.status).id ?? '');
  if (raw.voided === true || raw.voided === 'T' || /void/i.test(statusName)) return { ok: true, doc: { ...head, lines: [], subtotalCents: 0, taxCents: 0, totalCents: 0, balanceCents: 0, voided: true } };
  const lines: InvoiceLine[] = [];
  for (const l of arr(obj(raw.item).items)) {
    const qty = num(l.quantity) ?? 1;
    const amountCents = toCents(l.amount);
    lines.push({
      description: (str(l.description) ?? str(obj(l.item).refName) ?? 'Item').slice(0, 1000),
      qty,
      unitPriceCents: l.rate !== undefined && Math.abs(qty * toCents(l.rate) - amountCents) < 1 ? toCents(l.rate) : qty ? Math.round(amountCents / qty) : amountCents,
      amountCents,
      itemId: refId(l.item),
    });
  }
  if (lines.length === 0) return { ok: false, reason: 'Invoice has no item lines.' };
  if (lines.some((l) => l.amountCents < 0)) return { ok: false, reason: 'Negative lines (discounts) are not supported.' };
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const taxCents = toCents(raw.taxTotal ?? 0);
  const totalCents = toCents(raw.total);
  if (subtotalCents + taxCents !== totalCents) return { ok: false, reason: 'Totals do not add up (discount items, shipping, handling or tax setup on the NetSuite side).' };
  const doc: ExtInvoiceDoc = { ...head, lines, subtotalCents, taxCents, totalCents, balanceCents: toCents(raw.amountRemaining ?? 0), voided: false };
  return { ok: true, doc };
}

function parsePayment(raw: RawRecord): ExtPaymentDoc | null {
  const m = meta('payment', raw);
  if (!m.id) return null;
  const applications = arr(obj(raw.apply).items)
    .filter((a) => a.apply === true || a.apply === 'T')
    .map((a) => ({ invoiceId: refId(a.doc) ?? '', amountCents: toCents(a.amount) }))
    .filter((a) => a.invoiceId && a.amountCents > 0);
  return {
    id: m.id,
    customerId: refId(raw.customer),
    totalCents: toCents(raw.payment ?? raw.total),
    txnDate: dateOnly(raw.tranDate),
    depositAccountId: refId(raw.account),
    methodName: str(obj(raw.paymentMethod).refName),
    applications,
    voided: raw.voided === true || raw.voided === 'T',
    modifiedAt: m.modifiedAt,
  };
}

const adapter: Adapter = {
  provider: 'netsuite',
  caps: { canVoid: false, lineNeedsItem: true, markSentAfterCreate: false, refetchAfterWrite: true, minGapMs: 0, hasWebhook: false, pullOverlapMs: 26 * 60 * 60 * 1000 },

  isAllowedUrl: (u, c) => u.startsWith(`https://${nsHost(c.tenantId)}/`),
  authHeaders: (token) => ({ Authorization: `Bearer ${token}`, Accept: 'application/json' }),

  list(c, e, since, pos) {
    const t = since ? ts(since) : null;
    const where = t ? `${/ WHERE /.test(LIST_SQL[e]) ? ' AND' : ' WHERE'} lastmodifieddate >= TO_DATE('${t}', 'YYYY-MM-DD HH24:MI:SS')` : '';
    return suiteql(c, `${LIST_SQL[e]}${where} ORDER BY lastmodifieddate, id`, pos);
  },
  parseList(_e, json, pos) {
    const j = obj(json);
    const records = arr(j.items)
      .filter((r) => /^\d{1,20}$/.test(String(r.id ?? '')))
      .map((r) => ({ id: String(r.id), version: String(r.lm ?? ''), modifiedAt: null as number | null, raw: null as RawRecord | null }));
    return { records, more: j.hasMore === true && pos >= 0 };
  },
  get(c, e, id) {
    if (!/^\d{1,20}$/.test(id)) throw new Error('Invalid NetSuite id.');
    if (e === 'item') return suiteql(c, `SELECT id, itemid, displayname, description, isinactive, itemtype, ${LM} AS lastmodifieddate FROM item WHERE id = ${id}`, 0, 1);
    return { method: 'GET', url: `${nsBase(c.tenantId)}/record/v1/${RECORD[e]}/${id}?expandSubResources=true` };
  },
  parseOne(e, json) {
    const j = obj(json);
    if (e === 'item') return arr(j.items)[0] ?? null;
    return str(j.id) ? j : null;
  },

  find(c, e, field, value) {
    const v = sqlLiteral(value);
    if (e === 'customer') return suiteql(c, `SELECT id FROM customer WHERE LOWER(entityid) = LOWER(${v}) OR LOWER(companyname) = LOWER(${v})`, 0, 5);
    if (e === 'item') return suiteql(c, `SELECT id FROM item WHERE LOWER(itemid) = LOWER(${v}) AND itemtype IN ('Service', 'NonInvtPart')`, 0, 5);
    if (e === 'account') return suiteql(c, `SELECT id FROM account WHERE ${field === 'code' ? 'acctnumber' : 'LOWER(accountsearchdisplayname)'} = ${field === 'code' ? v : `LOWER(${v})`}`, 0, 5);
    if (e === 'invoice') return suiteql(c, `SELECT id FROM transaction WHERE type = 'CustInvc' AND tranid = ${v}`, 0, 5);
    return null;
  },
  parseFind: (_e, json) => arr(obj(json).items).filter((r) => /^\d{1,20}$/.test(String(r.id ?? ''))),

  create: (c, e, payload, key) => ({ method: 'POST', url: `${nsBase(c.tenantId)}/record/v1/${RECORD[e]}`, headers: { 'X-NetSuite-Idempotency-Key': key.slice(0, 100) }, body: payload }),
  update(c, e, id, payload) {
    const { __rt, ...body } = payload as RawRecord & { __rt?: string };
    const type = e === 'item' ? (__rt === 'NonInvtPart' ? 'nonInventorySaleItem' : 'serviceSaleItem') : RECORD[e];
    return { method: 'PATCH', url: `${nsBase(c.tenantId)}/record/v1/${type}/${id}${e === 'invoice' ? '?replace=item' : ''}`, body };
  },
  parseWrite: (_e, _json, location) => ({ record: null, id: idFromLocation(location) }),
  classify: classifyResponse,
  meta,
  isSyncable: () => true,
  isCustomerRecord: () => true,

  toCanon(e: SimpleEntity, raw: RawRecord): Canon {
    switch (e) {
      case 'customer': {
        const person = [str(raw.firstName), str(raw.lastName)].filter(Boolean).join(' ');
        return {
          name: str(raw.companyName) ?? (person || null) ?? str(raw.entityId),
          email: str(raw.email),
          phone: str(raw.phone),
          address: str(raw.defaultAddress)?.replace(/\s*[\r\n]+\s*/g, ', ') ?? null,
          notes: str(raw.comments),
        };
      }
      case 'item':
        return { name: str(raw.itemid), description: str(raw.description) ?? str(raw.displayname), active: raw.isinactive === 'T' || raw.isinactive === true ? 'inactive' : 'active' };
      case 'account':
        return { code: str(raw.acctNumber), name: str(raw.acctName), active: raw.isInactive === true ? 'inactive' : 'active' };
    }
  },
  toPayload(e: SimpleEntity, values: Canon, ctx, create): RawRecord {
    const p: RawRecord = {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(values, k);
    const sub = ctx.defaults.subsidiaryId ? { id: ctx.defaults.subsidiaryId } : null;
    switch (e) {
      case 'customer':
        if (has('name') && values.name) {
          p.companyName = String(values.name).slice(0, 83);
          if (create) {
            p.entityId = String(values.name).slice(0, 83);
            p.isPerson = false;
          }
        }
        if (has('email')) p.email = values.email ? String(values.email) : null;
        if (has('phone')) p.phone = values.phone ? String(values.phone).slice(0, 32) : null;
        if (has('notes')) p.comments = values.notes ? String(values.notes).slice(0, 4000) : null;
        if (create && sub) p.subsidiary = sub;
        return p;
      case 'item':
        if (has('name') && values.name) p.itemId = String(values.name).slice(0, 60);
        if (has('description')) p.description = values.description ? String(values.description).slice(0, 4000) : null;
        if (has('active')) p.isInactive = values.active === 'inactive';
        if (create) {
          if (ctx.defaults.incomeAccountId) p.incomeAccount = { id: ctx.defaults.incomeAccountId };
          if (sub) p.subsidiary = [sub];
        } else if (ctx.existing?.itemtype) p.__rt = ctx.existing.itemtype;
        return p;
      case 'account':
        if (has('name') && values.name) p.acctName = String(values.name).slice(0, 60);
        if (has('code') && values.code) p.acctNumber = String(values.code).slice(0, 60);
        if (has('active')) p.isInactive = values.active === 'inactive';
        if (create) {
          if (ctx.accountType) p.acctType = { id: ctx.accountType };
          if (sub) p.subsidiary = [sub];
        }
        return p;
    }
  },
  accountTypeOf: (raw): VireekAccountType | null => accountTypeFromClassification(ACCOUNT_CLASS[String(obj(raw.acctType).id ?? '')] ?? null),
  suggestAccountType(type, code) {
    switch (type) {
      case 'asset': return 'OthCurrAsset';
      case 'liability': return 'OthCurrLiab';
      case 'equity': return 'Equity';
      case 'revenue': return 'Income';
      case 'expense': return (code ?? '').startsWith('5') ? 'COGS' : 'Expense';
    }
  },
  itemIncomeRef: (raw) => str(raw.incomeaccount) ?? refId(raw.incomeAccount),

  parseInvoice,
  buildInvoice(inv, customerId, ctx, existing) {
    const items = inv.lines.map((l) => {
      const exact = Math.abs(l.qty * l.unitPriceCents - l.amountCents) < 0.5;
      return {
        item: { id: l.itemId },
        description: l.description.slice(0, 4000),
        quantity: exact ? l.qty : 1,
        rate: fromCents(exact ? l.unitPriceCents : l.amountCents),
        amount: fromCents(l.amountCents),
        ...(ctx.defaults.taxCodeId ? { taxCode: { id: ctx.defaults.taxCodeId } } : {}),
      };
    });
    const p: RawRecord = { tranDate: inv.issueDate, dueDate: inv.dueDate, item: { items } };
    if (existing) return p;
    p.entity = { id: customerId };
    if (ctx.defaults.subsidiaryId) p.subsidiary = { id: ctx.defaults.subsidiaryId };
    if (ctx.defaults.sendDocNumber) p.tranId = inv.invoiceNumber.slice(0, 45);
    return p;
  },
  voidInvoice: () => null,
  markSent: () => null,

  parsePayment,
  createPayment: (c, i, key) => ({
    method: 'POST',
    url: `${nsBase(c.tenantId)}/record/v1/invoice/${i.invoiceId}/!transform/customerPayment`,
    headers: { 'X-NetSuite-Idempotency-Key': key.slice(0, 100) },
    body: { ...(i.depositAccountId ? { account: { id: i.depositAccountId } } : {}), payment: fromCents(i.amountCents), tranDate: i.date, memo: i.note.slice(0, 999) },
  }),

  options(c): OptionsSpec[] {
    const rows = (json: unknown) => arr(obj(json).items);
    const cls = (t: string): OptionRow['classification'] => ACCOUNT_CLASS[t] ?? '';
    return [
      {
        key: 'accounts',
        req: suiteql(c, "SELECT id, acctnumber, accountsearchdisplayname AS name, accttype FROM account WHERE isinactive = 'F' ORDER BY acctnumber", 0, 1000),
        parse: (json): OptionRow[] => rows(json).map((a) => ({ id: String(a.id), name: `${str(a.acctnumber) ? `${String(a.acctnumber)} · ` : ''}${String(a.name ?? a.id)}`.slice(0, 120), type: String(a.accttype ?? ''), classification: cls(String(a.accttype ?? '')) })),
      },
      {
        key: 'items',
        req: suiteql(c, "SELECT id, itemid, itemtype FROM item WHERE isinactive = 'F' AND itemtype IN ('Service', 'NonInvtPart') ORDER BY itemid", 0, 1000),
        parse: (json): OptionRow[] => rows(json).map((i) => ({ id: String(i.id), name: String(i.itemid ?? i.id).slice(0, 120), type: String(i.itemtype ?? ''), classification: '' })),
      },
      {
        key: 'taxCodes',
        req: suiteql(c, "SELECT id, itemid FROM salestaxitem WHERE isinactive = 'F' ORDER BY itemid", 0, 500),
        parse: (json): OptionRow[] => rows(json).map((t) => ({ id: String(t.id), name: String(t.itemid ?? t.id).slice(0, 120), type: 'tax', classification: '' })),
      },
      {
        key: 'subsidiaries',
        req: suiteql(c, "SELECT id, name FROM subsidiary WHERE isinactive = 'F' ORDER BY name", 0, 200),
        parse: (json): OptionRow[] => rows(json).map((s) => ({ id: String(s.id), name: String(s.name ?? s.id).slice(0, 120), type: 'subsidiary', classification: '' })),
      },
    ];
  },
};

// ============================================================
// OAUTH 2.0 CLIENT CREDENTIALS (JWT client assertion)
// ============================================================

const pemToDer = (pem: string): Uint8Array => {
  const body = pem.replace(/\\n/g, '\n').replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
};

export type NsAlg = 'ES256' | 'PS256';
/** Signed client assertion NetSuite exchanges for an access token. `kid` is the Certificate ID of the M2M setup record. */
export async function buildClientAssertion(p: { accountId: string; clientId: string; certificateId: string; privateKeyPem: string; alg?: NsAlg; now?: number }): Promise<string> {
  const alg: NsAlg = p.alg === 'PS256' ? 'PS256' : 'ES256';
  const iat = Math.floor((p.now ?? Date.now()) / 1000);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg, typ: 'JWT', kid: p.certificateId });
  const body = enc({ iss: p.clientId, scope: ['rest_webservices'], aud: nsTokenUrl(p.accountId), iat, exp: iat + 55 * 60 });
  const data = new TextEncoder().encode(`${head}.${body}`);
  const der = pemToDer(p.privateKeyPem) as unknown as BufferSource;
  const sig =
    alg === 'ES256'
      ? await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']), data)
      : await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, await crypto.subtle.importKey('pkcs8', der, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']), data);
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const auth: AuthAdapter = {
  envPrefix: 'NETSUITE',
  async tokenRequest(_kind, p) {
    const c = p.c;
    if (!c || !p.certificateId || !p.privateKeyPem) throw new Error('NetSuite credentials are incomplete.');
    const assertion = await buildClientAssertion({ accountId: c.tenantId, clientId: p.clientId, certificateId: p.certificateId, privateKeyPem: p.privateKeyPem, alg: p.alg === 'PS256' ? 'PS256' : 'ES256' });
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    });
    return { url: nsTokenUrl(c.tenantId), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() };
  },
  isAllowedTokenUrl: (u, c) => !!c && u === nsTokenUrl(c.tenantId),
};

export const netsuiteProvider: Provider = { adapter, auth };
export { parseTokenResponse as parseNetsuiteTokens };
export type { ConnInfo, HttpReq };
