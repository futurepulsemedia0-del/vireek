// supabase/functions/_shared/accounting/xero.ts
//
// Xero Accounting API 2.0 adapter: pure request builders, response parsers and record mappers.
//
//   Auth     : OAuth 2.0 authorization code. 30-minute access tokens, ROTATING single-use refresh tokens
//              (always keep the newest). Granular scopes (accounting.invoices / accounting.payments) are
//              required for apps created on or after 2 March 2026; older apps may override XERO_SCOPES.
//   Tenant   : every call carries `Xero-Tenant-Id`; the tenant comes from GET /connections.
//   Paging   : Contacts / Invoices / Payments use `page` + `pageSize` (100); Accounts / Items return everything.
//   Changes  : `If-Modified-Since` header + UpdatedDateUTC ("/Date(ms+0000)/") as the change marker.
//   Limits   : 60 calls / minute / tenant (the sync paces itself with caps.minGapMs).
//   Writes   : PUT creates, POST updates; `Idempotency-Key` makes creates safe to retry.
//   Tax      : lines are sent with an explicit TaxAmount so the Xero total always equals the Vireek total.

import {
  GUID,
  accountTypeFromClassification,
  allocateTax,
  arr,
  dateOnly,
  fromCents,
  joinAddress,
  num,
  obj,
  parseTokenResponse,
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

export const XERO_API = 'https://api.xero.com/api.xro/2.0';
export const XERO_AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
export const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
export const XERO_REVOKE_URL = 'https://identity.xero.com/connect/revocation';
export const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
export const XERO_DEFAULT_SCOPES = 'offline_access accounting.contacts accounting.settings accounting.invoices accounting.payments';
export const XERO_PAGE = 100;

const EP: Record<AcctEntity, string> = { account: 'Accounts', customer: 'Contacts', item: 'Items', invoice: 'Invoices', payment: 'Payments' };
const ID: Record<AcctEntity, string> = { account: 'AccountID', customer: 'ContactID', item: 'ItemID', invoice: 'InvoiceID', payment: 'PaymentID' };
const PAGED: Record<AcctEntity, boolean> = { account: false, customer: true, item: false, invoice: true, payment: true };
const hasZone = (v: string) => /(Z|[+-]\d{2}:?\d{2})$/.test(v);

/** Xero timestamps: "/Date(1573639200000+0000)/" or an ISO string without a zone (UTC). */
export function xeroTime(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const m = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(v);
  if (m) return Number(m[1]);
  const t = Date.parse(hasZone(v) ? v : `${v}Z`);
  return Number.isFinite(t) ? t : null;
}
const isoDay = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString().slice(0, 10));
const xeroDay = (rec: RawRecord, stringKey: string, key: string): string | null => dateOnly(rec[stringKey]) ?? isoDay(xeroTime(rec[key]));

function meta(e: AcctEntity, raw: RawRecord): { id: string; version: string; modifiedAt: number | null } {
  const modifiedAt = xeroTime(raw.UpdatedDateUTC) ?? xeroTime(raw.UpdatedDateUTCString);
  return { id: String(raw[ID[e]] ?? ''), version: modifiedAt === null ? '' : String(modifiedAt), modifiedAt };
}

const path = (e: AcctEntity, id?: string) => `${XERO_API}/${EP[e]}${id ? `/${id}` : ''}`;
const q = (e: AcctEntity, params: Record<string, string>) => `${XERO_API}/${EP[e]}?${new URLSearchParams(params).toString()}`;

function composeAddress(contact: RawRecord): string | null {
  const list = arr(contact.Addresses);
  const a = list.find((x) => x.AddressType === 'POBOX') ?? list.find((x) => x.AddressType === 'STREET');
  if (!a) return null;
  return joinAddress([a.AddressLine1, a.AddressLine2, a.AddressLine3, a.AddressLine4, a.City, joinAddress([a.Region, a.PostalCode])?.replace(', ', ' '), a.Country]);
}
function composePhone(contact: RawRecord): string | null {
  const list = arr(contact.Phones).filter((p) => str(p.PhoneNumber));
  const p = list.find((x) => x.PhoneType === 'DEFAULT') ?? list.find((x) => x.PhoneType === 'MOBILE') ?? list[0];
  if (!p) return null;
  const cc = str(p.PhoneCountryCode);
  return [cc ? `+${cc}` : null, str(p.PhoneAreaCode), str(p.PhoneNumber)].filter(Boolean).join(' ');
}

function classifyResponse(status: number, json: unknown) {
  const j = obj(json);
  const msgs: string[] = [];
  for (const el of arr(j.Elements)) for (const v of arr(el.ValidationErrors)) if (str(v.Message)) msgs.push(String(str(v.Message)));
  const message = (msgs.join('; ') || str(j.Message) || str(j.Detail) || str(j.Title) || `HTTP ${status}`).slice(0, 300);
  if (status >= 200 && status < 300) return { kind: 'ok' as const, message: '' };
  if (status === 401 || status === 403) return { kind: 'auth' as const, message };
  if (status === 429) return { kind: 'throttle' as const, message };
  if (status === 404) return { kind: 'notfound' as const, message };
  if (status === 400) return { kind: /already exists|must be unique|duplicate/i.test(message) ? ('duplicate' as const) : ('validation' as const), message };
  return { kind: 'error' as const, message };
}

function parseInvoice(raw: RawRecord, currency: string): InvoiceParse {
  const m = meta('invoice', raw);
  if (!m.id) return { ok: false, reason: 'Invoice has no id.' };
  if (raw.Type !== 'ACCREC') return { ok: false, reason: 'Not a sales invoice.', silent: true };
  const status = String(raw.Status ?? '');
  if (status === 'DRAFT' || status === 'SUBMITTED' || status === 'DELETED') return { ok: false, reason: 'Invoice is not authorised yet.', silent: true };
  const cur = str(raw.CurrencyCode);
  if (cur && cur !== currency) return { ok: false, reason: `Currency ${cur} is not supported (Vireek books are in ${currency}).` };
  const base = {
    id: m.id,
    version: m.version,
    docNumber: str(raw.InvoiceNumber),
    customerId: str(obj(raw.Contact).ContactID),
    txnDate: xeroDay(raw, 'DateString', 'Date'),
    dueDate: xeroDay(raw, 'DueDateString', 'DueDate'),
    modifiedAt: m.modifiedAt,
  };
  if (status === 'VOIDED') return { ok: true, doc: { ...base, lines: [], subtotalCents: 0, taxCents: 0, totalCents: 0, balanceCents: 0, voided: true } };
  const inclusive = raw.LineAmountTypes === 'Inclusive';
  const lines: InvoiceLine[] = [];
  for (const l of arr(raw.LineItems)) {
    const qty = num(l.Quantity) ?? 1;
    let amountCents = l.LineAmount !== undefined ? toCents(l.LineAmount) : Math.round(qty * toCents(l.UnitAmount ?? 0));
    if (inclusive) amountCents -= toCents(l.TaxAmount ?? 0);
    const unit = l.UnitAmount !== undefined ? toCents(l.UnitAmount) : null;
    lines.push({
      description: (str(l.Description) ?? str(l.ItemCode) ?? 'Item').slice(0, 1000),
      qty,
      unitPriceCents: unit !== null && !inclusive && Math.abs(qty * unit - amountCents) < 1 ? unit : qty ? Math.round(amountCents / qty) : amountCents,
      amountCents,
      itemId: null,
    });
  }
  if (lines.length === 0) return { ok: false, reason: 'Invoice has no lines.' };
  if (lines.some((l) => l.amountCents < 0)) return { ok: false, reason: 'Negative lines (discounts) are not supported.' };
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const taxCents = raw.LineAmountTypes === 'NoTax' ? 0 : toCents(raw.TotalTax ?? 0);
  const totalCents = toCents(raw.Total);
  if (subtotalCents + taxCents !== totalCents) return { ok: false, reason: 'Totals do not add up (rounding, discount or tax setup on the Xero side).' };
  const doc: ExtInvoiceDoc = { ...base, lines, subtotalCents, taxCents, totalCents, balanceCents: toCents(raw.AmountDue ?? 0), voided: false };
  return { ok: true, doc };
}

function parsePayment(raw: RawRecord): ExtPaymentDoc | null {
  if (raw.PaymentType && raw.PaymentType !== 'ACCRECPAYMENT') return null;
  const m = meta('payment', raw);
  if (!m.id) return null;
  const inv = obj(raw.Invoice);
  const invoiceId = str(inv.InvoiceID);
  const totalCents = toCents(raw.Amount);
  return {
    id: m.id,
    customerId: str(obj(inv.Contact).ContactID),
    totalCents,
    txnDate: xeroDay(raw, 'DateString', 'Date'),
    depositAccountId: str(obj(raw.Account).AccountID),
    methodName: null,
    applications: invoiceId && totalCents > 0 ? [{ invoiceId, amountCents: totalCents }] : [],
    voided: raw.Status === 'DELETED',
    modifiedAt: m.modifiedAt,
  };
}

const adapter: Adapter = {
  provider: 'xero',
  caps: { canVoid: true, lineNeedsItem: false, markSentAfterCreate: false, refetchAfterWrite: false, minGapMs: 1100, hasWebhook: true, pullOverlapMs: 2 * 60 * 1000 },

  isAllowedUrl: (url) => url.startsWith('https://api.xero.com/'),
  authHeaders: (token, c) => ({ Authorization: `Bearer ${token}`, 'Xero-Tenant-Id': c.tenantId, Accept: 'application/json' }),

  list(_c, e, since, pos) {
    const p: Record<string, string> = {};
    if (PAGED[e]) {
      p.page = String(Math.max(1, Math.floor(pos)));
      p.pageSize = String(XERO_PAGE);
    }
    if (e === 'customer') p.includeArchived = 'true';
    if (e === 'invoice') {
      p.Statuses = 'AUTHORISED,PAID,VOIDED';
      p.where = 'Type=="ACCREC"';
      p.order = 'UpdatedDateUTC ASC';
    }
    if (e === 'payment') p.where = 'PaymentType=="ACCRECPAYMENT"';
    const headers: Record<string, string> = {};
    if (since) headers['If-Modified-Since'] = since.replace(/\.\d{3}Z$/, '').replace(/Z$/, '');
    return { method: 'GET', url: Object.keys(p).length ? q(e, p) : path(e), headers };
  },
  parseList(e, json) {
    const rows = arr(obj(json)[EP[e]]);
    const records = rows.map((raw) => ({ ...meta(e, raw), raw })).filter((r) => r.id).map((r) => ({ id: r.id, version: r.version, modifiedAt: r.modifiedAt, raw: r.raw }));
    return { records, more: PAGED[e] && rows.length >= XERO_PAGE };
  },
  get(_c, e, id) {
    if (!GUID.test(id)) throw new Error('Invalid Xero id.');
    return { method: 'GET', url: path(e, id) };
  },
  parseOne: (e, json) => arr(obj(json)[EP[e]])[0] ?? null,

  find(_c, e, field, value) {
    if (/["\\\r\n]/.test(value)) return null; // cannot be expressed safely in a Xero `where` filter
    const prop = e === 'invoice' ? 'InvoiceNumber' : e === 'customer' ? 'Name' : e === 'item' ? (field === 'code' ? 'Code' : 'Name') : field === 'code' ? 'Code' : 'Name';
    return { method: 'GET', url: q(e, { where: `${prop}=="${value}"` }) };
  },
  parseFind(e, json, field, value) {
    const prop = e === 'invoice' ? 'InvoiceNumber' : e === 'customer' ? 'Name' : field === 'code' ? 'Code' : 'Name';
    const want = value.trim().toLowerCase();
    return arr(obj(json)[EP[e]]).filter((r) => String(r[prop] ?? '').trim().toLowerCase() === want);
  },

  create: (_c, e, payload, key) => ({ method: 'PUT', url: path(e), headers: { 'Idempotency-Key': key.slice(0, 128) }, body: { [EP[e]]: [payload] } }),
  update: (_c, e, id, payload) => ({ method: 'POST', url: path(e, id), body: { [EP[e]]: [{ ...payload, [ID[e]]: id }] } }),
  parseWrite(e, json) {
    const rec = arr(obj(json)[EP[e]])[0] ?? null;
    return { record: rec, id: rec ? String(rec[ID[e]] ?? '') || null : null };
  },
  classify: classifyResponse,
  meta,
  isSyncable(e, raw) {
    if (e === 'item') return raw.IsSold !== false && raw.IsTrackedAsInventory !== true;
    if (e === 'customer') return raw.ContactStatus !== 'GDPRREQUEST';
    return true;
  },
  isCustomerRecord: (raw) => !(raw.IsSupplier === true && raw.IsCustomer !== true),

  toCanon(e: SimpleEntity, raw: RawRecord): Canon {
    switch (e) {
      case 'customer':
        return { name: str(raw.Name), email: str(raw.EmailAddress), phone: composePhone(raw), address: composeAddress(raw) };
      case 'item':
        return { name: str(raw.Name), description: str(raw.Description), price: num(obj(raw.SalesDetails).UnitPrice) };
      case 'account':
        return { code: str(raw.Code), name: str(raw.Name), active: raw.Status === 'ARCHIVED' ? 'inactive' : 'active' };
    }
  },
  toPayload(e: SimpleEntity, values: Canon, ctx, create): RawRecord {
    const p: RawRecord = {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(values, k);
    switch (e) {
      case 'customer':
        if (has('name') && values.name) p.Name = String(values.name).slice(0, 255);
        if (has('email')) p.EmailAddress = values.email ? String(values.email).slice(0, 255) : '';
        if (has('phone') && values.phone) p.Phones = [{ PhoneType: 'DEFAULT', PhoneNumber: String(values.phone).slice(0, 50) }];
        if (has('address') && values.address) p.Addresses = [{ AddressType: 'POBOX', AddressLine1: String(values.address).slice(0, 500) }];
        return p;
      case 'item': {
        const ex = ctx.existing ?? null;
        if (create) p.Code = `VK-${(ctx.vireekId ?? '').replace(/-/g, '').slice(0, 12).toUpperCase()}`;
        else if (ex?.Code) p.Code = ex.Code; // Xero requires the Code on every item update
        if (has('name') && values.name) p.Name = String(values.name).slice(0, 50);
        if (has('description')) p.Description = values.description ? String(values.description).slice(0, 4000) : '';
        if (create) p.IsSold = true;
        if (has('price') || create) {
          const sd: RawRecord = { ...obj(ex?.SalesDetails) };
          if (has('price') && values.price !== null && values.price !== undefined) sd.UnitPrice = Number(values.price);
          if (create && ctx.defaults.incomeAccountId) sd.AccountCode = ctx.defaults.incomeAccountId;
          if (create && ctx.defaults.taxCodeId) sd.TaxType = ctx.defaults.taxCodeId;
          if (Object.keys(sd).length) p.SalesDetails = sd;
        }
        return p;
      }
      case 'account':
        if (has('code') && values.code) p.Code = String(values.code).slice(0, 10);
        if (has('name') && values.name) p.Name = String(values.name).slice(0, 150);
        if (has('active')) p.Status = values.active === 'inactive' ? 'ARCHIVED' : 'ACTIVE';
        if (create && ctx.accountType) p.Type = ctx.accountType;
        return p;
    }
  },
  accountTypeOf: (raw): VireekAccountType | null => accountTypeFromClassification(raw.Class),
  suggestAccountType(type, code) {
    switch (type) {
      case 'asset': return 'CURRENT';
      case 'liability': return 'CURRLIAB';
      case 'equity': return 'EQUITY';
      case 'revenue': return 'REVENUE';
      case 'expense': return (code ?? '').startsWith('5') ? 'DIRECTCOSTS' : 'EXPENSE';
    }
  },
  itemIncomeRef: (raw) => str(obj(raw.SalesDetails).AccountCode),

  parseInvoice,
  buildInvoice(inv, customerId, ctx, existing) {
    const tax = allocateTax(inv.lines, inv.taxCents);
    const items = inv.lines.map((l, i) => {
      const exact = Math.abs(l.qty * l.unitPriceCents - l.amountCents) < 0.5;
      return {
        Description: l.description,
        Quantity: exact ? l.qty : 1,
        UnitAmount: fromCents(exact ? l.unitPriceCents : l.amountCents),
        ...(ctx.defaults.incomeAccountId ? { AccountCode: ctx.defaults.incomeAccountId } : {}),
        ...(ctx.defaults.taxCodeId ? { TaxType: ctx.defaults.taxCodeId } : {}),
        TaxAmount: fromCents(tax[i]),
      };
    });
    const p: RawRecord = { Date: inv.issueDate, DueDate: inv.dueDate, LineAmountTypes: 'Exclusive', LineItems: items };
    if (existing) {
      p.InvoiceID = existing.id;
      return p;
    }
    p.Type = 'ACCREC';
    p.Contact = { ContactID: customerId };
    p.Status = 'AUTHORISED';
    if (ctx.defaults.sendDocNumber) p.InvoiceNumber = inv.invoiceNumber.slice(0, 255);
    return p;
  },
  voidInvoice: (_c, id) => ({ method: 'POST', url: path('invoice', id), body: { Invoices: [{ InvoiceID: id, Status: 'VOIDED' }] } }),
  markSent: () => null,

  parsePayment,
  createPayment: (_c, i, key) => ({
    method: 'PUT',
    url: path('payment'),
    headers: { 'Idempotency-Key': key.slice(0, 128) },
    body: {
      Payments: [
        {
          Invoice: { InvoiceID: i.invoiceId },
          Account: i.depositAccountId && GUID.test(i.depositAccountId) ? { AccountID: i.depositAccountId } : { Code: i.depositAccountId },
          Date: i.date,
          Amount: fromCents(i.amountCents),
          Reference: i.note.slice(0, 255),
        },
      ],
    },
  }),

  options(): OptionsSpec[] {
    return [
      {
        key: 'accounts',
        req: { method: 'GET', url: q('account', { where: 'Status=="ACTIVE"' }) },
        parse: (json): OptionRow[] =>
          arr(obj(json).Accounts)
            .filter((a) => str(a.Code))
            .map((a) => ({
              id: String(a.Code),
              name: `${String(a.Code)} · ${String(a.Name ?? '')}`.slice(0, 120),
              type: String(a.Type ?? ''),
              classification: (['revenue', 'asset', 'liability', 'equity', 'expense'].includes(String(a.Class ?? '').toLowerCase()) ? String(a.Class).toLowerCase() : '') as OptionRow['classification'],
            })),
      },
      {
        key: 'taxCodes',
        req: { method: 'GET', url: `${XERO_API}/TaxRates` },
        parse: (json): OptionRow[] =>
          arr(obj(json).TaxRates)
            .filter((t) => t.Status === 'ACTIVE' && t.CanApplyToRevenue !== false && str(t.TaxType))
            .map((t) => ({ id: String(t.TaxType), name: String(t.Name ?? t.TaxType).slice(0, 120), type: 'tax', classification: '' })),
      },
    ];
  },
};

// ============================================================
// OAUTH + TENANTS + WEBHOOKS
// ============================================================

const auth: AuthAdapter = {
  envPrefix: 'XERO',
  authorizeUrl(p) {
    const u = new URL(XERO_AUTH_URL);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', p.clientId);
    u.searchParams.set('redirect_uri', p.redirectUri);
    u.searchParams.set('scope', p.scopes || XERO_DEFAULT_SCOPES);
    u.searchParams.set('state', p.state);
    return u.toString();
  },
  async tokenRequest(kind, p) {
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
  },
  isAllowedTokenUrl: (url) => url === XERO_TOKEN_URL || url === XERO_REVOKE_URL,
};

/** Claims of an (unverified) JWT: only used to read the authentication event id of a token Xero just issued to us. */
export function jwtClaims(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1] ?? '';
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return obj(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))));
  } catch {
    return {};
  }
}

/** Organisation tenants from GET /connections (newest authorisation first). */
export function parseConnections(json: unknown): { connectionId: string; tenantId: string; name: string | null }[] {
  return (Array.isArray(json) ? (json as RawRecord[]) : [])
    .filter((c) => c.tenantType === 'ORGANISATION' && GUID.test(String(c.tenantId ?? '')) && GUID.test(String(c.id ?? '')))
    .sort((a, b) => (xeroTime(b.updatedDateUtc) ?? 0) - (xeroTime(a.updatedDateUtc) ?? 0))
    .map((c) => ({ connectionId: String(c.id), tenantId: String(c.tenantId), name: str(c.tenantName) }));
}

/** Tenant ids named in a Xero webhook payload. */
export function xeroWebhookTenants(payload: unknown): string[] {
  const events = arr(obj(payload).events);
  return [...new Set(events.map((e) => String(e.tenantId ?? '')).filter((t) => GUID.test(t)))];
}

export const xeroProvider: Provider = { adapter, auth };
export { parseTokenResponse as parseXeroTokens };
export type { ConnInfo, HttpReq };
