// Mock-only tests for the Sage Intacct sync layer. NOT live-verified: they prove the engine, client and
// idempotent ops agree with each other and with the in-memory gateway, nothing more.
import { describe, it, expect } from 'vitest';
import {
  IA_ENTITIES, accountTypeFromIntacct, buildRequest, classifyFault, composeAddress, decryptSecret, defaultSettings, effectiveDirection, encryptSecret,
  fnCreateCustomer, fnPull, iaCustomerId, iaTimestamp, invoiceAmountSig, isAllowedGateway, mergeEntity, parseIaDate, parseIaInvoice, parseIaPayment,
  parseIaTimestamp, parseResponse, parseXml, paymentMethodFromName, renderFilter, validateSettings, xmlEscape, intacctToCanon, field, IaXmlError,
} from '../../supabase/functions/_shared/intacct/engine';
import { IntacctClient, IaAuthError, IaThrottleError, IaTransportError } from '../../supabase/functions/_shared/intacct/client';
import { MockIntacct } from '../../supabase/functions/_shared/intacct/mockGateway';
import { ensureAccount, ensureCustomer, ensureInvoice, ensurePayment, fetchLines, getRecord, listOptions, pullPage, updateCustomer, updateInvoiceDue } from '../../supabase/functions/_shared/intacct/ops';

const CFG = { senderId: 'vireek', senderPassword: 'sp', companyId: 'ACME', userId: 'api.user', password: 'pw<&>"\'' };
const VID = '3f2b8d1e-9c4a-4e6b-8a11-0123456789ab';

function rig(mockOpts: { now?: () => number } = {}) {
  const mock = new MockIntacct({ ...CFG, ...mockOpts });
  const sleeps: number[] = [];
  const client = new IntacctClient({
    senderId: CFG.senderId, senderPassword: CFG.senderPassword,
    credentials: { companyId: CFG.companyId, userId: CFG.userId, password: CFG.password },
    fetchFn: mock.fetch as unknown as typeof fetch, sleep: async (ms) => void sleeps.push(ms), random: () => 0, now: mockOpts.now,
  });
  return { mock, client, sleeps };
}

describe('xml', () => {
  it('escapes and round-trips hostile text', () => {
    const t = `a<b>&"'\u0001z`;
    const doc = parseXml(`<r><x>${xmlEscape(t)}</x></r>`);
    expect(doc.children[0].text).toBe('a<b>&"\'z');
  });
  it('rejects DTDs, mismatches and truncation', () => {
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x/>')).toThrow(IaXmlError);
    expect(() => parseXml('<a><b></a>')).toThrow(IaXmlError);
    expect(() => parseXml('<a><b>')).toThrow(IaXmlError);
    expect(() => parseXml('<a><b>' .repeat(60))).toThrow(IaXmlError);
  });
  it('handles CDATA, comments, entities and attributes containing ">"', () => {
    const n = parseXml('<?xml version="1.0"?><a k="x>y"><!-- c --><b><![CDATA[<raw>]]></b><c>&#65;&amp;</c><d/></a>');
    expect(n.attrs.k).toBe('x>y');
    expect(n.children[0].text).toBe('<raw>');
    expect(n.children[1].text).toBe('A&');
  });
  it('request builder escapes credentials and never lets values create elements', () => {
    const xml = buildRequest({ senderId: 's', senderPassword: 'p', controlId: 'c', auth: { kind: 'login', creds: { companyId: 'A</companyid><x/>', userId: 'u', password: CFG.password } }, fns: [] });
    expect(xml).not.toContain('<x/>');
    expect(parseXml(xml).name).toBe('request');
    expect(() => renderFilter({ op: 'eq', field: 'NAME</field><x>', value: 'v' })).toThrow();
    expect(renderFilter({ op: 'eq', field: 'NAME', value: `O'Brien <&>` })).toContain('O&apos;Brien &lt;&amp;&gt;');
  });
  it('gateway allow-list', () => {
    expect(isAllowedGateway('https://api.intacct.com/ia/xml/xmlgw.phtml')).toBe(true);
    expect(isAllowedGateway('https://eu.intacct.com/ia/xml/xmlgw.phtml')).toBe(true);
    for (const u of ['http://api.intacct.com/ia/xml/xmlgw.phtml', 'https://evil.com/ia/xml/xmlgw.phtml', 'https://intacct.com.evil.com/ia/xml/xmlgw.phtml', 'https://api.intacct.com:8443/ia/xml/xmlgw.phtml', 'https://u:p@api.intacct.com/ia/xml/xmlgw.phtml', 'https://api.intacct.com/other', null]) expect(isAllowedGateway(u)).toBe(false);
  });
});

describe('settings + merge', () => {
  it('defaults are safe: money documents never auto-resolve, accounts are read-only', () => {
    const d = defaultSettings();
    expect(d.entities.invoice.conflict).toBe('manual');
    expect(d.entities.payment.conflict).toBe('manual');
    expect(d.entities.account.direction).toBe('from_intacct');
    expect(IA_ENTITIES).toHaveLength(4);
  });
  it('validates input and refuses required fields turned off', () => {
    expect(validateSettings(null).ok).toBe(false);
    expect(validateSettings({ entities: { customer: { direction: 'x' } } }).ok).toBe(false);
    expect(validateSettings({ entities: { customer: { fields: { name: 'off' } } } }).ok).toBe(false);
    expect(validateSettings({ entities: { customer: { fields: { zzz: 'both' } } } }).ok).toBe(false);
    expect(validateSettings({ defaults: { taxAccountNo: '2100"><x/>' } }).ok).toBe(false);
    const ok = validateSettings({ defaults: { taxAccountNo: '2100', bankAccountId: 'BANK-1' } });
    expect(ok.ok && ok.settings.defaults.taxAccountNo).toBe('2100');
  });
  it('effective direction intersects entity and field', () => {
    expect(effectiveDirection('both', 'to_intacct')).toBe('to_intacct');
    expect(effectiveDirection('from_intacct', 'to_intacct')).toBe('off');
    expect(effectiveDirection('to_intacct', 'both')).toBe('to_intacct');
  });
  it('three-way merge: only a change on both sides conflicts', () => {
    const es = defaultSettings().entities.customer;
    const base = { name: 'A', email: 'a@x.com', phone: null, address: null, notes: null };
    const r1 = mergeEntity({ entity: 'customer', settings: es, base, vireek: { ...base, email: 'v@x.com' }, intacct: base, vireekTs: 2, intacctTs: 1 });
    expect(r1.toCrm.email).toBe('v@x.com');
    expect(r1.conflicts).toHaveLength(0);
    const manual = { ...es, conflict: 'manual' as const };
    const r2 = mergeEntity({ entity: 'customer', settings: manual, base, vireek: { ...base, name: 'V' }, intacct: { ...base, name: 'I' }, vireekTs: 2, intacctTs: 3 });
    expect(r2.conflicts.map((c) => c.field)).toEqual(['name']);
    const r3 = mergeEntity({ entity: 'customer', settings: manual, base, vireek: { ...base, name: 'V' }, intacct: { ...base, name: 'I' }, vireekTs: 2, intacctTs: 3, ruleOverride: 'intacct_wins' });
    expect(r3.toVireek.name).toBe('I');
  });
});

describe('parsers', () => {
  it('dates and timestamps', () => {
    expect(parseIaDate('10/28/2026')).toBe('2026-10-28');
    expect(parseIaDate('2026-10-28T10:00:00')).toBe('2026-10-28');
    expect(parseIaDate('nope')).toBeNull();
    const ms = Date.UTC(2026, 9, 28, 5, 6, 7);
    expect(parseIaTimestamp(iaTimestamp(ms))).toBe(ms);
    expect(iaTimestamp(ms)).toBe('10/28/2026 05:06:07');
  });
  it('ids are deterministic and within Intacct limits', () => {
    expect(iaCustomerId(VID)).toBe(iaCustomerId(VID.toUpperCase()));
    expect(iaCustomerId(VID).length).toBeLessThanOrEqual(20);
  });
  it('account type is derived deterministically', () => {
    const t = (no: string, kind: string, bal: string) => accountTypeFromIntacct({ ACCOUNTNO: no, ACCOUNTTYPE: kind, NORMALBALANCE: bal });
    expect(t('1000', 'balancesheet', 'debit')).toBe('asset');
    expect(t('2000', 'balancesheet', 'credit')).toBe('liability');
    expect(t('3000', 'balancesheet', 'credit')).toBe('equity');
    expect(t('4000', 'incomestatement', 'credit')).toBe('revenue');
    expect(t('5000', 'incomestatement', 'debit')).toBe('expense');
    expect(t('9', 'weird', 'debit')).toBeNull();
  });
  it('customer canon handles flat dotted and nested field shapes', () => {
    const flat = { NAME: 'N', 'DISPLAYCONTACT.EMAIL1': 'e@x.com', 'DISPLAYCONTACT.MAILADDRESS.CITY': 'Austin', 'DISPLAYCONTACT.MAILADDRESS.STATE': 'TX', 'DISPLAYCONTACT.MAILADDRESS.ZIP': '78701' };
    const nested = { NAME: 'N', DISPLAYCONTACT: { EMAIL1: 'e@x.com', MAILADDRESS: { CITY: 'Austin', STATE: 'TX', ZIP: '78701' } } };
    expect(intacctToCanon('customer', flat)).toEqual(intacctToCanon('customer', nested));
    expect(composeAddress(flat)).toBe('Austin, TX 78701');
    expect(field(nested, 'DISPLAYCONTACT.EMAIL1')).toBe('e@x.com');
  });
  it('invoice parser: tax split, totals check, reversal, currency, discounts, drafts', () => {
    const h = { RECORDNO: '9', RECORDID: 'INV-1', CUSTOMERID: 'C1', WHENCREATED: '10/01/2026', WHENDUE: '10/31/2026', TOTALENTERED: '108.00', TOTALPAID: '0', STATE: 'Posted', CURRENCY: 'USD' };
    const lines = [{ LINE_NO: '2', ACCOUNTNO: '2100', TRX_AMOUNT: '8.00' }, { LINE_NO: '1', ACCOUNTNO: '4000', ENTRYDESCRIPTION: 'Tune-up', TRX_AMOUNT: '100.00' }];
    const ok = parseIaInvoice(h, lines, { taxAccountNo: '2100' });
    expect(ok.ok && ok.doc.taxCents).toBe(800);
    expect(ok.ok && ok.doc.subtotalCents).toBe(10000);
    expect(ok.ok && ok.doc.dueDate).toBe('2026-10-31');
    const types = new Map([['4000', 'revenue'], ['2100', 'liability']]);
    expect(parseIaInvoice(h, lines, { taxAccountNo: null }, types).ok).toBe(false); // tax unmapped: a liability line is never booked as revenue
    expect(parseIaInvoice(h, lines, { taxAccountNo: '2100' }, types).ok).toBe(true);
    expect(parseIaInvoice({ ...h, STATE: 'Reversed' }, [], { taxAccountNo: null })).toMatchObject({ ok: true, doc: { voided: true } });
    expect(parseIaInvoice({ ...h, CURRENCY: 'EUR' }, lines, { taxAccountNo: '2100' }).ok).toBe(false);
    expect(parseIaInvoice({ ...h, STATE: 'Draft' }, lines, { taxAccountNo: '2100' }).ok).toBe(false);
    expect(parseIaInvoice(h, [{ ACCOUNTNO: '4000', TRX_AMOUNT: '-5' }], { taxAccountNo: null }).ok).toBe(false);
    expect(invoiceAmountSig({ lines: [{ amountCents: 1 }], taxCents: 2, totalCents: 3 })).toBe('3|2|1');
  });
  it('payment parser keeps only positive applications to numeric invoice keys', () => {
    const p = parseIaPayment({ RECORDNO: '5', CUSTOMERID: 'C', TRX_TOTALENTERED: '50', RECEIPTDATE: '10/02/2026', PAYMENTMETHOD: 'Credit Card', STATE: 'Paid' }, [{ RECORDKEY: '9', TRX_PAYMENTAMOUNT: '50' }, { RECORDKEY: 'x', TRX_PAYMENTAMOUNT: '1' }, { RECORDKEY: '8', TRX_PAYMENTAMOUNT: '0' }]);
    expect(p?.applications).toEqual([{ invoiceNo: '9', amountCents: 5000 }]);
    expect(paymentMethodFromName('Printed Check')).toBe('check');
    expect(paymentMethodFromName('Credit Card')).toBe('card');
    expect(paymentMethodFromName(null)).toBe('other');
  });
  it('faults classify by message', () => {
    const e = (message: string) => [{ code: 'X', message, detail: '', correction: '' }];
    expect(classifyFault([])).toBe('ok');
    expect(classifyFault(e('Sign-in information is incorrect'))).toBe('auth');
    expect(classifyFault(e('Too many requests'))).toBe('throttle');
    expect(classifyFault(e('Another Customer with the same ID already exists'))).toBe('duplicate');
    expect(classifyFault(e('Customer does not exist'))).toBe('notfound');
    expect(classifyFault(e('Amount is required'))).toBe('validation');
  });
  it('parseResponse reads data attributes and errors', () => {
    const r = parseResponse('<response><control><status>success</status></control><operation><authentication><status>success</status></authentication><result><status>failure</status><function>f</function><controlid>c</controlid><errormessage><error><errorno>E1</errorno><description>d</description><description2>d2</description2><correction>fix</correction></error></errormessage></result></operation></response>');
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].errors[0]).toMatchObject({ code: 'E1', message: 'd2', correction: 'fix' });
  });
  it('credentials round-trip through AES-GCM and are not stored in clear', async () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const enc = await encryptSecret(JSON.stringify({ u: 'x', p: CFG.password }), key);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain('api.user');
    expect(JSON.parse(await decryptSecret(enc, key)).p).toBe(CFG.password);
    await expect(decryptSecret(enc, btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))))).rejects.toBeTruthy();
  });
});

describe('client: sessions, retries, throttling', () => {
  it('logs in once and reuses the session', async () => {
    const { mock, client } = rig();
    await pullPage(client, 'customer', { since: null, afterRecordNo: 0 });
    await pullPage(client, 'customer', { since: null, afterRecordNo: 0 });
    expect(mock.count('getAPISession')).toBe(1);
  });
  it('wrong user password fails fast with IaAuthError and no retry loop', async () => {
    const { mock } = rig();
    const bad = new IntacctClient({ senderId: CFG.senderId, senderPassword: CFG.senderPassword, credentials: { companyId: 'ACME', userId: 'api.user', password: 'wrong' }, fetchFn: mock.fetch as unknown as typeof fetch, sleep: async () => {} });
    await expect(pullPage(bad, 'customer', { since: null, afterRecordNo: 0 })).rejects.toBeInstanceOf(IaAuthError);
    expect(mock.requests).toBe(1);
  });
  it('wrong sender id is an auth error too', async () => {
    const { mock } = rig();
    const bad = new IntacctClient({ senderId: 'nope', senderPassword: 'x', credentials: { companyId: 'ACME', userId: 'api.user', password: CFG.password }, fetchFn: mock.fetch as unknown as typeof fetch, sleep: async () => {} });
    await expect(pullPage(bad, 'customer', { since: null, afterRecordNo: 0 })).rejects.toBeInstanceOf(IaAuthError);
  });
  it('re-logs in transparently when the session expires, including for writes', async () => {
    const { mock, client } = rig();
    await pullPage(client, 'customer', { since: null, afterRecordNo: 0 });
    mock.expireSessions();
    const r = await ensureCustomer(client, { vireekId: VID, values: { name: 'Jane' } });
    expect(r.created).toBe(true);
    expect(mock.count('getAPISession')).toBe(2);
    expect(mock.db.customer).toHaveLength(1);
  });
  it('reads retry through 429, 503, network loss, bad XML and throttle faults', async () => {
    for (const k of ['http429', 'http503', 'network', 'badxml', 'throttleFault'] as const) {
      const { mock, client, sleeps } = rig();
      await pullPage(client, 'customer', { since: null, afterRecordNo: 0 });
      mock.inject(k, 2);
      const page = await pullPage(client, 'customer', { since: null, afterRecordNo: 0 });
      expect(page.records).toEqual([]);
      expect(sleeps).toHaveLength(2);
      expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
    }
  });
  it('gives up with IaThrottleError after max attempts', async () => {
    const { mock, client } = rig();
    mock.inject('http429', 10);
    await expect(pullPage(client, 'customer', { since: null, afterRecordNo: 0 })).rejects.toBeInstanceOf(IaThrottleError);
  });
  it('writes retry on 429 (provably not executed) but never on 503 or network loss', async () => {
    const a = rig();
    a.mock.inject('http429', 2, { onlyWrites: true });
    expect((await ensureCustomer(a.client, { vireekId: VID, values: { name: 'J' } })).created).toBe(true);
    expect(a.mock.db.customer).toHaveLength(1);
    const b = rig();
    await pullPage(b.client, 'customer', { since: null, afterRecordNo: 0 });
    b.mock.inject('http503', 1, { onlyWrites: true });
    await expect(ensureCustomer(b.client, { vireekId: VID, values: { name: 'J' } })).rejects.toMatchObject({ unknownOutcome: true });
    expect(b.mock.db.customer).toHaveLength(0);
  });
});

describe('ops: idempotency', () => {
  it('ensureCustomer twice creates one customer', async () => {
    const { mock, client } = rig();
    const a = await ensureCustomer(client, { vireekId: VID, values: { name: 'Jane', email: 'j@x.com', phone: '555', address: '1 Main', notes: 'vip' } });
    const b = await ensureCustomer(client, { vireekId: VID, values: { name: 'Jane' } });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(mock.db.customer).toHaveLength(1);
    expect(field(a.record, 'DISPLAYCONTACT.EMAIL1')).toBe('j@x.com');
    expect(mock.count('create_customer')).toBe(1);
  });
  it('a lost create response is recovered on the next attempt without a duplicate', async () => {
    const { mock, client } = rig();
    await pullPage(client, 'customer', { since: null, afterRecordNo: 0 });
    mock.inject('writeThenNetworkError');
    await expect(ensureCustomer(client, { vireekId: VID, values: { name: 'Jane' } })).rejects.toBeInstanceOf(IaTransportError);
    expect(mock.db.customer).toHaveLength(1); // the write DID land
    const again = await ensureCustomer(client, { vireekId: VID, values: { name: 'Jane' } });
    expect(again.created).toBe(false);
    expect(mock.db.customer).toHaveLength(1);
  });
  it('a duplicate fault from a racing replay is treated as success', async () => {
    const { mock, client } = rig();
    mock.seed('customer', { CUSTOMERID: iaCustomerId(VID), NAME: 'Raced', STATUS: 'active' });
    // Simulate the race: the find misses once (hide the row), the create then hits the duplicate.
    const hidden = mock.db.customer.splice(0);
    const origFetch = mock.fetch;
    let first = true;
    const racing = new IntacctClient({ senderId: CFG.senderId, senderPassword: CFG.senderPassword, credentials: { companyId: 'ACME', userId: 'api.user', password: CFG.password }, sleep: async () => {}, fetchFn: (async (u: string, i: RequestInit) => {
      const body = String(i.body);
      if (first && body.includes('<create_customer>')) { first = false; mock.db.customer.push(...hidden); }
      return origFetch(u, i);
    }) as unknown as typeof fetch });
    const r = await ensureCustomer(racing, { vireekId: VID, values: { name: 'Raced' } });
    expect(r.created).toBe(false);
    expect(mock.db.customer).toHaveLength(1);
  });
  it('ensureAccount links an existing GL account and creates a missing one once', async () => {
    const { mock, client } = rig();
    mock.seed('account', { ACCOUNTNO: '4000', TITLE: 'Revenue', ACCOUNTTYPE: 'incomestatement', NORMALBALANCE: 'credit', STATUS: 'active' });
    expect((await ensureAccount(client, { values: { code: '4000', name: 'Revenue' }, type: 'revenue' })).created).toBe(false);
    expect((await ensureAccount(client, { values: { code: '4100', name: 'Parts' }, type: 'revenue' })).created).toBe(true);
    expect((await ensureAccount(client, { values: { code: '4100', name: 'Parts' }, type: 'revenue' })).created).toBe(false);
    expect(mock.db.account).toHaveLength(2);
  });
  it('invoice + payment lifecycle, idempotent at every step', async () => {
    const { mock, client } = rig();
    const cust = await ensureCustomer(client, { vireekId: VID, values: { name: 'Jane' } });
    const cid = field(cust.record, 'CUSTOMERID')!;
    const inv = { invoiceNumber: 'INV-0001', issueDate: '2026-10-01', dueDate: '2026-10-31', taxCents: 800, lines: [{ description: 'Tune-up', qty: 2, unitPriceCents: 5000, amountCents: 10000, accountNo: '4000' }] };
    const defaults = { taxAccountNo: '2100', sendInvoiceNumber: true };
    const a = await ensureInvoice(client, { vireekId: 'aaaaaaaa-0000-4000-8000-000000000001', customerId: cid, inv, defaults });
    const b = await ensureInvoice(client, { vireekId: 'aaaaaaaa-0000-4000-8000-000000000001', customerId: cid, inv, defaults });
    expect('record' in a && a.created).toBe(true);
    expect('record' in b && b.created).toBe(false);
    expect(mock.db.invoice).toHaveLength(1);
    const rec = ('record' in a ? a.record : {}) as Record<string, unknown>;
    const lines = await fetchLines(client, 'invoiceLine', [field(rec, 'RECORDNO')!]);
    const parsed = parseIaInvoice(rec, lines.get(field(rec, 'RECORDNO')!) ?? [], defaults);
    expect(parsed.ok && parsed.doc.totalCents).toBe(10800);
    expect(parsed.ok && parsed.doc.taxCents).toBe(800);
    expect(parsed.ok && invoiceAmountSig(parsed.doc)).toBe('10800|800|10000');

    const pay = { vireekId: 'bbbbbbbb-0000-4000-8000-000000000001', customerId: cid, invoiceNo: field(rec, 'RECORDNO')!, amountCents: 5000, date: '2026-10-02', bankAccountId: 'BANK1', method: 'card' as const, memo: 'm' };
    expect((await ensurePayment(client, pay)).created).toBe(true);
    expect((await ensurePayment(client, pay)).created).toBe(false);
    expect(mock.db.payment).toHaveLength(1);
    expect(mock.db.invoice[0].TOTALPAID).toBe('50.00');
    await expect(ensurePayment(client, { ...pay, vireekId: 'bbbbbbbb-0000-4000-8000-000000000002', amountCents: 999_999 })).rejects.toMatchObject({ kind: 'validation' });

    const fresh = (await getRecord(client, 'invoice', field(rec, 'RECORDNO')!))!;
    const due = await updateInvoiceDue(client, field(fresh, 'RECORDNO')!, '2026-11-15');
    expect(parseIaDate(field(due, 'WHENDUE'))).toBe('2026-11-15');
  });
  it('invoice without a tax account or revenue account is refused before any write', async () => {
    const { mock, client } = rig();
    const inv = { invoiceNumber: 'INV-2', issueDate: '2026-10-01', dueDate: '2026-10-31', taxCents: 100, lines: [{ description: 'x', qty: 1, unitPriceCents: 1000, amountCents: 1000, accountNo: '4000' }] };
    const r = await ensureInvoice(client, { vireekId: VID, customerId: 'C', inv, defaults: { taxAccountNo: null, sendInvoiceNumber: true } });
    expect(r).toMatchObject({ error: expect.stringContaining('sales tax') });
    const r2 = await ensureInvoice(client, { vireekId: VID, customerId: 'C', inv: { ...inv, taxCents: 0, lines: [{ ...inv.lines[0], accountNo: null }] }, defaults: { taxAccountNo: null, sendInvoiceNumber: true } });
    expect(r2).toMatchObject({ error: expect.stringContaining('revenue account') });
    expect(mock.calls.filter((c) => c.write)).toHaveLength(0);
  });
  it('hostile names cannot break out of the XML', async () => {
    const { mock, client } = rig();
    const name = `Evil</name><status>inactive</status><x a="1">&amp;`;
    const r = await ensureCustomer(client, { vireekId: VID, values: { name, notes: ']]><!--' } });
    expect(field(r.record, 'NAME')).toBe(name);
    expect(mock.db.customer[0].STATUS).toBe('active');
    expect(fnCreateCustomer('c', 'VK-1', { name }).xml).not.toContain('<x a="1">');
  });
});

describe('ops: pulling', () => {
  it('keyset-pages in RECORDNO order, resumable, with a modified-since filter', async () => {
    let t = Date.UTC(2026, 9, 1, 12);
    const { mock, client } = rig({ now: () => t });
    for (let i = 0; i < 7; i++) { mock.seed('customer', { CUSTOMERID: `C${i}`, NAME: `N${i}`, STATUS: 'active' }); t += 3600_000; }
    const seen: string[] = [];
    let after = 0;
    for (;;) {
      const p = await pullPage(client, 'customer', { since: null, afterRecordNo: after, pageSize: 3 });
      seen.push(...p.records.map((r) => field(r, 'CUSTOMERID')!));
      if (!p.more) break;
      after = p.maxRecordNo;
    }
    expect(seen).toEqual(['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
    const recent = await pullPage(client, 'customer', { since: Date.UTC(2026, 9, 1, 17, 30), afterRecordNo: 0 });
    expect(recent.records.map((r) => field(r, 'CUSTOMERID'))).toEqual(['C6']);
  });
  it('an edit made inside Intacct is picked up by the next pull and applied by updateCustomer round trip', async () => {
    const { mock, client } = rig();
    const c = await ensureCustomer(client, { vireekId: VID, values: { name: 'Jane', email: 'a@x.com' } });
    mock.edit('customer', field(c.record, 'RECORDNO')!, { NAME: 'Jane Q' });
    const p = await pullPage(client, 'customer', { since: Date.now() - 60_000, afterRecordNo: 0 });
    expect(field(p.records[0], 'NAME')).toBe('Jane Q');
    const upd = await updateCustomer(client, p.records[0], { email: 'b@x.com' });
    expect(field(upd, 'DISPLAYCONTACT.EMAIL1')).toBe('b@x.com');
    expect(field(upd, 'NAME')).toBe('Jane Q'); // sparse update never touched the name
  });
  it('option lists for the mapping UI', async () => {
    const { mock, client } = rig();
    mock.seed('account', { ACCOUNTNO: '4000', TITLE: 'Revenue', ACCOUNTTYPE: 'incomestatement', NORMALBALANCE: 'credit', STATUS: 'active' });
    mock.seed('bank', { BANKACCOUNTID: 'BANK1', BANKNAME: 'Operating', STATUS: 'active' });
    const o = await listOptions(client);
    expect(o.accounts[0]).toMatchObject({ id: '4000', name: 'Revenue' });
    expect(o.banks[0]).toEqual({ id: 'BANK1', name: 'Operating' });
  });
  it('pull query is structured, ordered and bounded', () => {
    const x = fnPull({ controlId: 'c', entity: 'invoice', since: Date.UTC(2026, 0, 2), afterRecordNo: 5, pageSize: 99999 }).xml;
    expect(x).toContain('<pagesize>1000</pagesize>');
    expect(x).toContain('<orderby>');
    expect(x).toContain('01/02/2026 00:00:00');
  });
});
