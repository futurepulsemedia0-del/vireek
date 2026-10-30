// supabase/functions/_shared/intacct/mockGateway.ts
//
// In-memory fake of the Sage Intacct XML gateway, used ONLY by tests ("mock-test only; not live-verified").
// It implements the request shapes engine.ts emits, so it proves the engine, client and ops agree with
// each other: it is NOT evidence about the real Intacct API.
// Supports: getAPISession, query (filter/orderby/pagesize), create/update customer, glaccount, invoice,
// create_arpayment, session expiry, and fault injection (throttle, 5xx, network loss, lost write responses).

import { iaTimestamp, parseIaTimestamp, parseXml, childOf, childrenOf, textOf, xmlEscape, type XNode } from './engine.ts';

type Rec = Record<string, string>;
export type MockFault = 'http429' | 'http503' | 'network' | 'badxml' | 'throttleFault' | 'writeThenNetworkError';
export interface MockConfig { senderId: string; senderPassword: string; companyId: string; userId: string; password: string; now?: () => number }

const TABLE: Record<string, string> = { GLACCOUNT: 'account', CUSTOMER: 'customer', ARINVOICE: 'invoice', ARINVOICEITEM: 'invoiceLine', ARPYMT: 'payment', ARPYMTDETAIL: 'paymentLine', CHECKINGACCOUNT: 'bank' };
const WRITES = new Set(['create_customer', 'update_customer', 'create_glaccount', 'update_glaccount', 'create_invoice', 'update_invoice', 'create_arpayment']);

const errXml = (code: string, msg: string, extra = '') => `<errormessage><error><errorno>${code}</errorno><description>${xmlEscape(msg)}</description><description2>${xmlEscape(msg)}</description2><correction>${xmlEscape(extra)}</correction></error></errormessage>`;
const dmy = (n: XNode | null) => (n ? `${textOf(n, 'month')}/${textOf(n, 'day')}/${textOf(n, 'year')}` : '');

export class MockIntacct {
  db: Record<string, Rec[]> = { account: [], customer: [], invoice: [], invoiceLine: [], payment: [], paymentLine: [], bank: [] };
  calls: { fn: string; write: boolean; session: string }[] = [];
  requests = 0;
  private seq = 1000;
  private sessions = new Map<string, number>();
  private faults: { kind: MockFault; left: number; onlyWrites: boolean }[] = [];
  now: () => number;
  cfg: MockConfig;
  constructor(cfg: MockConfig) { this.cfg = cfg; this.now = cfg.now ?? (() => Date.now()); }

  inject(kind: MockFault, times = 1, opts: { onlyWrites?: boolean } = {}) { this.faults.push({ kind, left: times, onlyWrites: !!opts.onlyWrites || kind === 'writeThenNetworkError' }); }
  expireSessions() { this.sessions.clear(); }
  count(fn: string) { return this.calls.filter((c) => c.fn === fn).length; }

  /** Simulate an edit made inside Sage Intacct itself. */
  edit(table: string, recordNo: string, patch: Rec) {
    const r = this.db[table].find((x) => x.RECORDNO === recordNo);
    if (!r) throw new Error('mock: no such record');
    Object.assign(r, patch, { WHENMODIFIED: iaTimestamp(this.now()) });
  }
  seed(table: string, rec: Rec): Rec {
    const r = { RECORDNO: String(++this.seq), WHENMODIFIED: iaTimestamp(this.now()), ...rec };
    this.db[table].push(r);
    return r;
  }

  fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.requests++;
    const body = String(init?.body ?? '');
    const doc = parseXml(body);
    const control = childOf(doc, 'control');
    const op = childOf(doc, 'operation');
    const authN = childOf(op, 'authentication');
    const fns = childrenOf(childOf(op, 'content'), 'function');
    const wrap = (inner: string, authOk = true, authErr = '') =>
      `<?xml version="1.0"?><response><control><status>success</status></control><operation><authentication><status>${authOk ? 'success' : 'failure'}</status>${authErr}</authentication>${inner}</operation></response>`;
    const ok = (text: string) => new Response(text, { status: 200 });

    if (textOf(control, 'senderid') !== this.cfg.senderId || textOf(control, 'password') !== this.cfg.senderPassword) {
      return ok(`<response><control><status>failure</status></control>${errXml('XL03000006', 'Sender ID is not authorized')}</response>`);
    }
    const login = childOf(authN, 'login');
    const isSessionReq = fns.length === 1 && childOf(fns[0], 'getAPISession');
    if (login) {
      if (textOf(login, 'companyid') !== this.cfg.companyId || textOf(login, 'userid') !== this.cfg.userId || textOf(login, 'password') !== this.cfg.password) {
        return ok(wrap('', false, errXml('XL03000009', 'Sign-in information is incorrect')));
      }
      if (!isSessionReq) return ok(wrap('', false, errXml('XL03000009', 'Only getAPISession may use login in the mock')));
      const id = `sess-${++this.seq}`;
      this.sessions.set(id, this.now() + 3_600_000);
      this.calls.push({ fn: 'getAPISession', write: false, session: 'login' });
      return ok(wrap(`<result><status>success</status><function>getAPISession</function><controlid>${xmlEscape(fns[0].attrs.controlid ?? '')}</controlid><data><api><sessionid>${id}</sessionid><endpoint>https://api.intacct.com/ia/xml/xmlgw.phtml</endpoint></api></data></result>`));
    }
    const sid = textOf(authN, 'sessionid');
    const exp = this.sessions.get(sid);
    if (!exp || exp < this.now()) return ok(wrap('', false, errXml('XL03000006', 'Invalid session', 'Sign in again')));

    const names = fns.map((f) => f.children[0]?.name ?? '');
    const isWrite = names.some((n) => WRITES.has(n));
    const f = this.faults.find((x) => x.left > 0 && (!x.onlyWrites || isWrite));
    if (f) {
      f.left--;
      if (f.kind === 'http429') return new Response('slow down', { status: 429 });
      if (f.kind === 'http503') return new Response('unavailable', { status: 503 });
      if (f.kind === 'network') throw new TypeError('socket hang up');
      if (f.kind === 'badxml') return new Response('<html>gateway timeout', { status: 200 });
      if (f.kind === 'throttleFault') return ok(wrap(fns.map((x) => `<result><status>failure</status><function>${x.children[0]?.name}</function><controlid>${xmlEscape(x.attrs.controlid ?? '')}</controlid>${errXml('XL03000010', 'Too many requests, slow down')}</result>`).join('')));
    }
    const out = fns.map((fnNode) => this.run(fnNode, sid)).join('');
    if (f?.kind === 'writeThenNetworkError') throw new TypeError('connection reset after write');
    return ok(wrap(out));
  };

  private run(fnNode: XNode, sid: string): string {
    const cid = xmlEscape(fnNode.attrs.controlid ?? '');
    const body = fnNode.children[0];
    const name = body?.name ?? '';
    this.calls.push({ fn: name, write: WRITES.has(name), session: sid });
    const fail = (code: string, msg: string) => `<result><status>failure</status><function>${name}</function><controlid>${cid}</controlid>${errXml(code, msg)}</result>`;
    const success = (data = '') => `<result><status>success</status><function>${name}</function><controlid>${cid}</controlid>${data}</result>`;
    const stamp = () => iaTimestamp(this.now());
    const nextNo = () => String(++this.seq);

    switch (name) {
      case 'query': return this.query(body, cid, fail);
      case 'create_customer': {
        const id = textOf(body, 'customerid');
        if (this.db.customer.some((c) => c.CUSTOMERID === id)) return fail('BL01001973', `Another Customer with the same ID ${id} already exists`);
        const dc = childOf(body, 'displaycontact');
        this.db.customer.push({ RECORDNO: nextNo(), CUSTOMERID: id, NAME: textOf(body, 'name'), STATUS: textOf(body, 'status') || 'active', COMMENTS: textOf(body, 'comments'), 'DISPLAYCONTACT.EMAIL1': textOf(dc, 'email1'), 'DISPLAYCONTACT.PHONE1': textOf(dc, 'phone1'), 'DISPLAYCONTACT.MAILADDRESS.ADDRESS1': textOf(childOf(dc, 'mailaddress'), 'address1'), WHENMODIFIED: stamp() });
        return success();
      }
      case 'update_customer': {
        const c = this.db.customer.find((x) => x.CUSTOMERID === textOf(body, 'customerid'));
        if (!c) return fail('BL01001973', 'Customer does not exist');
        const dc = childOf(body, 'displaycontact');
        if (childOf(body, 'name')) c.NAME = textOf(body, 'name');
        if (childOf(body, 'comments')) c.COMMENTS = textOf(body, 'comments');
        if (childOf(dc, 'email1')) c['DISPLAYCONTACT.EMAIL1'] = textOf(dc, 'email1');
        if (childOf(dc, 'phone1')) c['DISPLAYCONTACT.PHONE1'] = textOf(dc, 'phone1');
        if (childOf(dc, 'mailaddress')) c['DISPLAYCONTACT.MAILADDRESS.ADDRESS1'] = textOf(childOf(dc, 'mailaddress'), 'address1');
        c.WHENMODIFIED = stamp();
        return success();
      }
      case 'create_glaccount': {
        const no = textOf(body, 'glaccountno');
        if (this.db.account.some((a) => a.ACCOUNTNO === no)) return fail('BL01001973', `Account ${no} already exists`);
        this.db.account.push({ RECORDNO: nextNo(), ACCOUNTNO: no, TITLE: textOf(body, 'title'), ACCOUNTTYPE: textOf(body, 'accounttype'), NORMALBALANCE: textOf(body, 'normalbalance'), STATUS: textOf(body, 'status') || 'active', WHENMODIFIED: stamp() });
        return success();
      }
      case 'update_glaccount': {
        const a = this.db.account.find((x) => x.ACCOUNTNO === textOf(body, 'glaccountno'));
        if (!a) return fail('BL01001973', 'Account does not exist');
        if (childOf(body, 'title')) a.TITLE = textOf(body, 'title');
        if (childOf(body, 'status')) a.STATUS = textOf(body, 'status');
        a.WHENMODIFIED = stamp();
        return success();
      }
      case 'create_invoice': {
        const number = textOf(body, 'invoiceno');
        const cust = textOf(body, 'customerid');
        if (!this.db.customer.some((c) => c.CUSTOMERID === cust)) return fail('BL01001973', 'Customer does not exist');
        if (this.db.invoice.some((i) => i.RECORDID === number && i.CUSTOMERID === cust)) return fail('BL01001973', `Invoice ${number} already exists`);
        const no = nextNo();
        let total = 0;
        childrenOf(childOf(body, 'invoiceitems'), 'lineitem').forEach((l, idx) => {
          const amt = Number(textOf(l, 'amount'));
          total += amt;
          this.db.invoiceLine.push({ RECORDNO: nextNo(), RECORDKEY: no, LINE_NO: String(idx + 1), ACCOUNTNO: textOf(l, 'glaccountno'), ENTRYDESCRIPTION: textOf(l, 'memo'), TRX_AMOUNT: amt.toFixed(2) });
        });
        this.db.invoice.push({ RECORDNO: no, RECORDID: number, DOCNUMBER: textOf(body, 'ponumber'), CUSTOMERID: cust, WHENCREATED: dmy(childOf(body, 'datecreated')), WHENDUE: dmy(childOf(body, 'datedue')), TOTALENTERED: total.toFixed(2), TOTALPAID: '0.00', TOTALDUE: total.toFixed(2), STATE: 'Posted', CURRENCY: 'USD', WHENMODIFIED: stamp() });
        return success();
      }
      case 'update_invoice': {
        const inv = this.db.invoice.find((i) => i.RECORDNO === body.attrs.key);
        if (!inv) return fail('BL01001973', 'Invoice does not exist');
        if (childOf(body, 'datedue')) inv.WHENDUE = dmy(childOf(body, 'datedue'));
        inv.WHENMODIFIED = stamp();
        return success();
      }
      case 'create_arpayment': {
        const doc = textOf(body, 'documentnumber');
        if (this.db.payment.some((p) => p.DOCNUMBER === doc)) return fail('BL01001973', `Payment ${doc} already exists`);
        const item = childOf(body, 'arpaymentitem');
        const inv = this.db.invoice.find((i) => i.RECORDNO === textOf(item, 'invoicekey'));
        if (!inv) return fail('BL01001973', 'Invoice does not exist');
        const amt = Number(textOf(item, 'amount'));
        if (amt > Number(inv.TOTALDUE) + 0.001) return fail('BL01001973', 'Payment exceeds the amount due');
        const no = nextNo();
        this.db.payment.push({ RECORDNO: no, CUSTOMERID: textOf(body, 'customerid'), PAYMENTMETHOD: textOf(body, 'paymentmethod'), RECEIPTDATE: dmy(childOf(body, 'receiptdate')), TRX_TOTALENTERED: amt.toFixed(2), DOCNUMBER: doc, FINANCIALENTITY: textOf(body, 'bankaccountid'), STATE: 'Paid', CURRENCY: 'USD', WHENMODIFIED: stamp() });
        this.db.paymentLine.push({ RECORDNO: nextNo(), PAYMENTKEY: no, RECORDKEY: inv.RECORDNO, TRX_PAYMENTAMOUNT: amt.toFixed(2) });
        inv.TOTALPAID = (Number(inv.TOTALPAID) + amt).toFixed(2);
        inv.TOTALDUE = (Number(inv.TOTALDUE) - amt).toFixed(2);
        inv.WHENMODIFIED = stamp();
        return success();
      }
      default: return fail('XL03000006', `Unsupported function ${name}`);
    }
  }

  private cmp(field: string, a: string | undefined, b: string): number {
    if (field === 'WHENMODIFIED') return (parseIaTimestamp(a) ?? 0) - (parseIaTimestamp(b) ?? 0);
    const na = Number(a), nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb) && a !== '' ? na - nb : String(a ?? '').localeCompare(b);
  }
  private test(n: XNode, r: Rec): boolean {
    const nm = n.name.toLowerCase();
    const f = textOf(n, 'field');
    if (nm === 'and') return n.children.every((c) => this.test(c, r));
    if (nm === 'or') return n.children.some((c) => this.test(c, r));
    if (nm === 'equalto') return (r[f] ?? '') === textOf(n, 'value');
    if (nm === 'greaterthan') return this.cmp(f, r[f], textOf(n, 'value')) > 0;
    if (nm === 'greaterthanorequalto') return this.cmp(f, r[f], textOf(n, 'value')) >= 0;
    if (nm === 'in') return childrenOf(n, 'value').some((v) => (r[f] ?? '') === v.text.trim());
    throw new Error(`mock: unsupported filter ${nm}`);
  }
  private query(body: XNode, cid: string, fail: (c: string, m: string) => string): string {
    const obj = textOf(body, 'object');
    const table = TABLE[obj];
    if (!table) return fail('BL01001973', `Unknown object ${obj}`);
    const filter = childOf(body, 'filter')?.children[0];
    let rows = this.db[table].filter((r) => (filter ? this.test(filter, r) : true));
    if (childOf(body, 'orderby')) rows = [...rows].sort((a, b) => Number(a.RECORDNO) - Number(b.RECORDNO));
    const size = Number(textOf(body, 'pagesize') || 100);
    const offset = Number(textOf(body, 'offset') || 0);
    const page = rows.slice(offset, offset + size);
    const sel = new Set(childrenOf(childOf(body, 'select'), 'field').map((x) => x.text.trim()));
    const xml = page.map((r) => `<${obj}>${Object.entries(r).filter(([k]) => !sel.size || sel.has(k)).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('')}</${obj}>`).join('');
    return `<result><status>success</status><function>query</function><controlid>${cid}</controlid><data listtype="objects" count="${page.length}" totalcount="${rows.length}" numremaining="${Math.max(0, rows.length - offset - page.length)}">${xml}</data></result>`;
  }
}
