// supabase/functions/_shared/accounting/zoho.ts
//
// Zoho Books API v3 adapter: pure request builders, response parsers and record mappers.
//
//   Auth     : OAuth 2.0 authorization code (access_type=offline). Access tokens last 1 hour; the refresh
//              token is long-lived and is NOT rotated. Every data centre has its own accounts + API host,
//              so the data centre is stored on the connection and every host is allow-listed.
//   Tenant   : every call carries `organization_id` (from GET /organizations).
//   Paging   : `page` + `per_page` (max 200); the response says `has_more_page`.
//   Changes  : `last_modified_time` on every row is the change marker. Lists do not carry line items or
//              addresses, so changed records are read again with a detail GET.
//   Invoices : created as drafts, so they are marked "sent" right after creation (needed to take payments).

import {
  accountTypeFromClassification,
  arr,
  dateOnly,
  fromCents,
  num,
  obj,
  parseTimestamp,
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
  type VireekPaymentMethod,
} from './core.ts';

export const ZOHO_REGIONS = ['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'sa', 'com.cn'] as const;
export type ZohoRegion = (typeof ZOHO_REGIONS)[number];
export const isZohoRegion = (v: unknown): v is ZohoRegion => typeof v === 'string' && (ZOHO_REGIONS as readonly string[]).includes(v);
export const ZOHO_DEFAULT_SCOPES = 'ZohoBooks.contacts.ALL,ZohoBooks.invoices.ALL,ZohoBooks.customerpayments.ALL,ZohoBooks.settings.ALL,ZohoBooks.accountants.ALL';
export const ZOHO_PAGE = 200;

export const zohoAccountsHost = (region: string): string => `https://accounts.zoho.${isZohoRegion(region) ? region : 'com'}`;
export const zohoApiHost = (region: string): string => `https://www.zohoapis.${isZohoRegion(region) ? region : 'com'}`;
/** Region from the `accounts-server` URL Zoho appends to the redirect (it knows the user's real data centre). */
export function regionFromAccountsServer(url: string | null): ZohoRegion | null {
  const m = /^https:\/\/accounts\.zoho\.([a-z.]+)\/?$/.exec(url ?? '');
  return m && isZohoRegion(m[1]) ? m[1] : null;
}

const EP: Record<AcctEntity, string> = { account: 'chartofaccounts', customer: 'contacts', item: 'items', invoice: 'invoices', payment: 'customerpayments' };
const KEY: Record<AcctEntity, string> = { account: 'chartofaccounts', customer: 'contacts', item: 'items', invoice: 'invoices', payment: 'customerpayments' };
const ONE: Record<AcctEntity, string> = { account: 'chart_of_account', customer: 'contact', item: 'item', invoice: 'invoice', payment: 'payment' };
const ID: Record<AcctEntity, string> = { account: 'account_id', customer: 'contact_id', item: 'item_id', invoice: 'invoice_id', payment: 'payment_id' };

const base = (c: ConnInfo) => `${zohoApiHost(c.region ?? 'com')}/books/v3`;
const url = (c: ConnInfo, p: string, params: Record<string, string> = {}) => `${base(c)}/${p}?${new URLSearchParams({ ...params, organization_id: c.tenantId }).toString()}`;

/** Zoho timestamps look like 2026-10-18T10:15:30+0530; Date.parse needs a colon in the offset. */
export function zohoTime(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  return parseTimestamp(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}
const zohoSince = (iso: string) => iso.replace(/\.\d{3}Z$/, '+0000').replace(/Z$/, '+0000');

function meta(e: AcctEntity, raw: RawRecord): { id: string; version: string; modifiedAt: number | null } {
  const lm = str(raw.last_modified_time);
  return { id: String(raw[ID[e]] ?? ''), version: lm ?? '', modifiedAt: zohoTime(lm) };
}

function classifyResponse(status: number, json: unknown) {
  const j = obj(json);
  const code = num(j.code);
  const message = (str(j.message) ?? `HTTP ${status}`).slice(0, 300);
  if (status === 401 || code === 57 || code === 14) return { kind: 'auth' as const, message };
  if (status === 429 || code === 45) return { kind: 'throttle' as const, message };
  if (status === 404) return { kind: 'notfound' as const, message };
  if (status >= 200 && status < 300 && (code === 0 || code === null)) return { kind: 'ok' as const, message: '' };
  if (status === 400 || status === 422 || (code !== null && code !== 0)) return { kind: /already exist|duplicate/i.test(message) ? ('duplicate' as const) : ('validation' as const), message };
  return { kind: 'error' as const, message };
}

const MODE: Record<VireekPaymentMethod, string> = { card: 'creditcard', ach: 'banktransfer', check: 'check', cash: 'cash', other: 'others' };

function parseInvoice(raw: RawRecord, currency: string): InvoiceParse {
  const m = meta('invoice', raw);
  if (!m.id) return { ok: false, reason: 'Invoice has no id.' };
  const status = String(raw.status ?? '');
  if (status === 'draft') return { ok: false, reason: 'Invoice is still a draft.', silent: true };
  const cur = str(raw.currency_code);
  if (cur && cur !== currency) return { ok: false, reason: `Currency ${cur} is not supported (Vireek books are in ${currency}).` };
  const head = {
    id: m.id,
    version: m.version,
    docNumber: str(raw.invoice_number),
    customerId: str(raw.customer_id),
    txnDate: dateOnly(raw.date),
    dueDate: dateOnly(raw.due_date),
    modifiedAt: m.modifiedAt,
  };
  if (status === 'void') return { ok: true, doc: { ...head, lines: [], subtotalCents: 0, taxCents: 0, totalCents: 0, balanceCents: 0, voided: true } };
  const rows = arr(raw.line_items);
  if (rows.length === 0) return { ok: false, reason: 'Invoice has no line items (open it once in Zoho Books or check the connection scopes).' };
  if (toCents(raw.discount ?? 0) !== 0 || toCents(raw.adjustment ?? 0) !== 0 || toCents(raw.shipping_charge ?? 0) !== 0) {
    return { ok: false, reason: 'Invoice-level discounts, adjustments or shipping charges are not supported.' };
  }
  const lines: InvoiceLine[] = [];
  for (const l of rows) {
    const qty = num(l.quantity) ?? 1;
    const amountCents = toCents(l.item_total ?? (num(l.rate) ?? 0) * qty);
    lines.push({
      description: (str(l.description) ?? str(l.name) ?? 'Item').slice(0, 1000),
      qty,
      unitPriceCents: l.rate !== undefined && Math.abs(qty * toCents(l.rate) - amountCents) < 1 ? toCents(l.rate) : qty ? Math.round(amountCents / qty) : amountCents,
      amountCents,
      itemId: str(l.item_id),
    });
  }
  if (lines.some((l) => l.amountCents < 0)) return { ok: false, reason: 'Negative lines (discounts) are not supported.' };
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const taxCents = toCents(raw.tax_total ?? 0);
  const totalCents = toCents(raw.total);
  if (subtotalCents + taxCents !== totalCents) return { ok: false, reason: 'Totals do not add up (tax-inclusive pricing, line discounts or rounding on the Zoho side).' };
  const doc: ExtInvoiceDoc = { ...head, lines, subtotalCents, taxCents, totalCents, balanceCents: toCents(raw.balance ?? 0), voided: false };
  return { ok: true, doc };
}

function parsePayment(raw: RawRecord): ExtPaymentDoc | null {
  const m = meta('payment', raw);
  if (!m.id) return null;
  const applications = arr(raw.invoices)
    .map((i) => ({ invoiceId: String(i.invoice_id ?? ''), amountCents: toCents(i.amount_applied) }))
    .filter((a) => a.invoiceId && a.amountCents > 0);
  return {
    id: m.id,
    customerId: str(raw.customer_id),
    totalCents: toCents(raw.amount),
    txnDate: dateOnly(raw.date),
    depositAccountId: str(raw.account_id),
    methodName: str(raw.payment_mode),
    applications,
    voided: false,
    modifiedAt: m.modifiedAt,
  };
}

const ACCOUNT_TYPES: Record<string, 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'> = {
  bank: 'asset', cash: 'asset', accounts_receivable: 'asset', other_current_asset: 'asset', fixed_asset: 'asset', other_asset: 'asset', stock: 'asset', payment_clearing: 'asset',
  accounts_payable: 'liability', credit_card: 'liability', other_current_liability: 'liability', long_term_liability: 'liability', other_liability: 'liability',
  equity: 'equity', income: 'revenue', other_income: 'revenue', expense: 'expense', cost_of_goods_sold: 'expense', other_expense: 'expense',
};

const adapter: Adapter = {
  provider: 'zoho_books',
  caps: { canVoid: true, lineNeedsItem: false, markSentAfterCreate: true, refetchAfterWrite: false, minGapMs: 650, hasWebhook: false, pullOverlapMs: 2 * 60 * 1000 },

  isAllowedUrl: (u, c) => u.startsWith(`${zohoApiHost(c.region ?? 'com')}/`),
  authHeaders: (token) => ({ Authorization: `Zoho-oauthtoken ${token}`, Accept: 'application/json' }),

  list(c, e, since, pos) {
    const p: Record<string, string> = { page: String(Math.max(1, Math.floor(pos))), per_page: String(ZOHO_PAGE), sort_column: 'last_modified_time' };
    if (e === 'customer') p.contact_type = 'customer';
    if (e === 'customer' || e === 'item') p.filter_by = 'Status.All';
    if (e === 'account') {
      p.filter_by = 'AccountType.All';
      delete p.sort_column;
    }
    if (e === 'invoice') p.sort_order = 'A';
    if (since && e !== 'account') p.last_modified_time = zohoSince(since);
    return { method: 'GET', url: url(c, EP[e], p) };
  },
  parseList(e, json) {
    const j = obj(json);
    const rows = arr(j[KEY[e]]);
    // The list row is complete for the chart of accounts; every other entity needs its detail record.
    const out = rows
      .map((raw) => ({ ...meta(e, raw), raw: e === 'account' ? raw : (null as RawRecord | null) }))
      .filter((r) => r.id);
    const more = obj(j.page_context).has_more_page === true;
    return { records: out, more };
  },
  get(c, e, id) {
    if (!/^\d{1,24}$/.test(id)) throw new Error('Invalid Zoho id.');
    return { method: 'GET', url: url(c, `${EP[e]}/${id}`) };
  },
  parseOne(e, json) {
    const r = obj(obj(json)[ONE[e]]);
    return Object.keys(r).length ? r : (arr(obj(json)[KEY[e]])[0] ?? null);
  },

  find(c, e, field, value) {
    if (e === 'customer') return { method: 'GET', url: url(c, 'contacts', { contact_name: value, contact_type: 'customer', filter_by: 'Status.All' }) };
    if (e === 'item') return { method: 'GET', url: url(c, 'items', { name: value, filter_by: 'Status.All' }) };
    if (e === 'invoice') return { method: 'GET', url: url(c, 'invoices', { invoice_number: value }) };
    if (e === 'account') return { method: 'GET', url: url(c, 'chartofaccounts', { filter_by: 'AccountType.All', per_page: String(ZOHO_PAGE), }) };
    return null;
  },
  parseFind(e, json, field, value) {
    const want = value.trim().toLowerCase();
    const prop = e === 'customer' ? 'contact_name' : e === 'item' ? 'name' : e === 'invoice' ? 'invoice_number' : field === 'code' ? 'account_code' : 'account_name';
    return arr(obj(json)[KEY[e]]).filter((r) => String(r[prop] ?? '').trim().toLowerCase() === want);
  },

  create: (c, e, payload) => ({ method: 'POST', url: url(c, EP[e], e === 'invoice' ? { ignore_auto_number_generation: 'true' } : {}), body: payload }),
  update: (c, e, id, payload) => ({ method: 'PUT', url: url(c, `${EP[e]}/${id}`, e === 'invoice' ? { ignore_auto_number_generation: 'true' } : {}), body: payload }),
  parseWrite(e, json) {
    const rec = obj(obj(json)[ONE[e]]);
    const r = Object.keys(rec).length ? rec : null;
    return { record: r, id: r ? String(r[ID[e]] ?? '') || null : null };
  },
  classify: classifyResponse,
  meta,
  isSyncable(e, raw) {
    if (e === 'item') return raw.item_type !== 'inventory' && raw.item_type !== 'purchases' && raw.product_type !== 'goods';
    return true;
  },
  isCustomerRecord: (raw) => raw.contact_type === undefined || raw.contact_type === 'customer',

  toCanon(e: SimpleEntity, raw: RawRecord): Canon {
    switch (e) {
      case 'customer': {
        const a = obj(raw.billing_address);
        return {
          name: str(raw.contact_name) ?? str(raw.company_name),
          email: str(raw.email),
          phone: str(raw.phone) ?? str(raw.mobile),
          address: [str(a.address), str(a.street2), str(a.city), [str(a.state), str(a.zip)].filter(Boolean).join(' ') || null, str(a.country)].filter(Boolean).join(', ') || null,
          notes: str(raw.notes),
        };
      }
      case 'item':
        return { name: str(raw.name), description: str(raw.description), price: num(raw.rate), active: raw.status === 'inactive' ? 'inactive' : 'active' };
      case 'account':
        return { code: str(raw.account_code), name: str(raw.account_name), active: raw.is_active === false ? 'inactive' : 'active' };
    }
  },
  toPayload(e: SimpleEntity, values: Canon, ctx, create): RawRecord {
    const p: RawRecord = {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(values, k);
    switch (e) {
      case 'customer':
        if (has('name') && values.name) p.contact_name = String(values.name).slice(0, 200);
        if (create) p.contact_type = 'customer';
        if (has('notes')) p.notes = values.notes ? String(values.notes).slice(0, 2000) : '';
        if (has('address') && values.address) p.billing_address = { address: String(values.address).slice(0, 500) };
        // email / phone live on contact persons in Zoho Books: sent through the primary person below.
        if (create) {
          const person: RawRecord = { is_primary_contact: true };
          if (values.email) person.email = String(values.email).slice(0, 100);
          if (values.phone) person.phone = String(values.phone).slice(0, 50);
          if (Object.keys(person).length > 1) p.contact_persons = [person];
        } else {
          if (has('email') && values.email) p.email = String(values.email).slice(0, 100);
          if (has('phone') && values.phone) p.phone = String(values.phone).slice(0, 50);
        }
        return p;
      case 'item':
        if (has('name') && values.name) p.name = String(values.name).slice(0, 100);
        if (has('description')) p.description = values.description ? String(values.description).slice(0, 2000) : '';
        if (has('price') && values.price !== null && values.price !== undefined) p.rate = Number(values.price);
        if (create) {
          p.product_type = 'service';
          p.item_type = 'sales';
          if (ctx.defaults.incomeAccountId) p.account_id = ctx.defaults.incomeAccountId;
        }
        return p;
      case 'account':
        if (has('name') && values.name) p.account_name = String(values.name).slice(0, 100);
        if (has('code') && values.code) p.account_code = String(values.code).slice(0, 20);
        if (create && ctx.accountType) p.account_type = ctx.accountType;
        return p;
    }
  },
  accountTypeOf: (raw): VireekAccountType | null => accountTypeFromClassification(ACCOUNT_TYPES[String(raw.account_type ?? '')] ?? null),
  suggestAccountType(type, code) {
    switch (type) {
      case 'asset': return 'other_current_asset';
      case 'liability': return 'other_current_liability';
      case 'equity': return 'equity';
      case 'revenue': return 'income';
      case 'expense': return (code ?? '').startsWith('5') ? 'cost_of_goods_sold' : 'expense';
    }
  },
  itemIncomeRef: (raw) => str(raw.account_id),

  parseInvoice,
  buildInvoice(inv, customerId, ctx, existing) {
    const lines = inv.lines.map((l) => {
      const exact = Math.abs(l.qty * l.unitPriceCents - l.amountCents) < 0.5;
      return {
        name: l.description.slice(0, 100),
        description: l.description,
        rate: fromCents(exact ? l.unitPriceCents : l.amountCents),
        quantity: exact ? l.qty : 1,
        ...(l.itemId ? { item_id: l.itemId } : {}),
        ...(ctx.defaults.incomeAccountId ? { account_id: ctx.defaults.incomeAccountId } : {}),
        ...(inv.taxCents > 0 && ctx.defaults.taxCodeId ? { tax_id: ctx.defaults.taxCodeId } : {}),
      };
    });
    const p: RawRecord = { customer_id: customerId, date: inv.issueDate, due_date: inv.dueDate, line_items: lines };
    if (!existing && ctx.defaults.sendDocNumber) p.invoice_number = inv.invoiceNumber.slice(0, 50);
    return p;
  },
  voidInvoice: (c, id) => ({ method: 'POST', url: url(c, `invoices/${id}/status/void`) }),
  markSent: (c, id) => ({ method: 'POST', url: url(c, `invoices/${id}/status/sent`) }),

  parsePayment,
  createPayment: (c, i) => ({
    method: 'POST',
    url: url(c, 'customerpayments'),
    body: {
      customer_id: i.customerId,
      payment_mode: MODE[i.method],
      amount: fromCents(i.amountCents),
      date: i.date,
      ...(i.depositAccountId ? { account_id: i.depositAccountId } : {}),
      reference_number: i.note.slice(0, 100),
      invoices: [{ invoice_id: i.invoiceId, amount_applied: fromCents(i.amountCents) }],
    },
  }),

  options(c): OptionsSpec[] {
    const cls = (t: string): OptionRow['classification'] => ACCOUNT_TYPES[t] ?? '';
    return [
      {
        key: 'accounts',
        req: { method: 'GET', url: url(c, 'chartofaccounts', { filter_by: 'AccountType.Active', per_page: String(ZOHO_PAGE) }) },
        parse: (json): OptionRow[] =>
          arr(obj(json).chartofaccounts)
            .filter((a) => str(a.account_id))
            .map((a) => ({ id: String(a.account_id), name: String(a.account_name ?? a.account_id).slice(0, 120), type: String(a.account_type ?? ''), classification: cls(String(a.account_type ?? '')) === 'revenue' ? 'revenue' : ['bank', 'cash', 'other_current_asset', 'payment_clearing'].includes(String(a.account_type)) ? 'asset' : cls(String(a.account_type ?? '')) })),
      },
      {
        key: 'items',
        req: { method: 'GET', url: url(c, 'items', { filter_by: 'Status.Active', per_page: String(ZOHO_PAGE) }) },
        parse: (json): OptionRow[] =>
          arr(obj(json).items)
            .filter((i) => str(i.item_id) && i.item_type !== 'inventory' && i.item_type !== 'purchases')
            .map((i) => ({ id: String(i.item_id), name: String(i.name ?? i.item_id).slice(0, 120), type: String(i.product_type ?? ''), classification: '' })),
      },
      {
        key: 'taxCodes',
        req: { method: 'GET', url: url(c, 'settings/taxes') },
        parse: (json): OptionRow[] =>
          arr(obj(json).taxes)
            .filter((t) => str(t.tax_id))
            .map((t) => ({ id: String(t.tax_id), name: `${String(t.tax_name ?? t.tax_id)}${t.tax_percentage !== undefined ? ` (${String(t.tax_percentage)}%)` : ''}`.slice(0, 120), type: 'tax', classification: '' })),
      },
    ];
  },
};

// ============================================================
// OAUTH
// ============================================================

const auth: AuthAdapter = {
  envPrefix: 'ZOHO',
  authorizeUrl(p) {
    const u = new URL(`${zohoAccountsHost(p.region ?? 'com')}/oauth/v2/auth`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', p.clientId);
    u.searchParams.set('redirect_uri', p.redirectUri);
    u.searchParams.set('scope', p.scopes || ZOHO_DEFAULT_SCOPES);
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('state', p.state);
    return u.toString();
  },
  async tokenRequest(kind, p) {
    const body = new URLSearchParams();
    body.set('client_id', p.clientId);
    body.set('client_secret', p.clientSecret);
    if (kind === 'code') {
      body.set('grant_type', 'authorization_code');
      body.set('code', p.code ?? '');
      body.set('redirect_uri', p.redirectUri ?? '');
    } else {
      body.set('grant_type', 'refresh_token');
      body.set('refresh_token', p.refreshToken ?? '');
    }
    return { url: `${zohoAccountsHost(p.region ?? 'com')}/oauth/v2/token`, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() };
  },
  isAllowedTokenUrl: (u) => /^https:\/\/accounts\.zoho\.(com|eu|in|com\.au|jp|ca|sa|com\.cn)\/oauth\/v2\/(token|token\/revoke)(\?.*)?$/.test(u),
};

export const zohoRevokeUrl = (region: string, refreshToken: string): string => `${zohoAccountsHost(region)}/oauth/v2/token/revoke?token=${encodeURIComponent(refreshToken)}`;

/** Default organisation (id, name, base currency) from GET /organizations. */
export function parseOrganizations(json: unknown): { id: string; name: string | null; currency: string | null } | null {
  const orgs = arr(obj(json).organizations).filter((o) => /^\d{5,24}$/.test(String(o.organization_id ?? '')));
  const o = orgs.find((x) => x.is_default_org === true) ?? orgs[0];
  return o ? { id: String(o.organization_id), name: str(o.name), currency: str(o.currency_code) } : null;
}
export const zohoOrganizationsUrl = (region: string): string => `${zohoApiHost(region)}/books/v3/organizations`;

export const zohoProvider: Provider = { adapter, auth };
export { parseTokenResponse as parseZohoTokens };
export type { ConnInfo, HttpReq };
