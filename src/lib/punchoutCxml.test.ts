import { describe, expect, it } from 'vitest';
import {
  assertSafeSupplierUrl,
  buildOrderMessageForTest,
  buildSetupRequest,
  decimalToCents,
  mapUom,
  parseOrderMessage,
  parseSetupResponse,
  parseXml,
} from '../../supabase/functions/_shared/punchout/cxml';

describe('decimalToCents', () => {
  it('parses clean decimals and rounds half-up', () => {
    expect(decimalToCents('12.5')).toBe(1250);
    expect(decimalToCents('1,234.567')).toBe(123457);
    expect(decimalToCents('0')).toBe(0);
    expect(decimalToCents('9.995')).toBe(1000);
  });
  it('rejects anything else', () => {
    for (const bad of ['', 'abc', '-1', '1e3', '1.2.3', null, undefined]) expect(decimalToCents(bad as string)).toBeNull();
  });
});

describe('parseXml', () => {
  it('decodes entities, CDATA and ignores comments/DOCTYPE', () => {
    const n = parseXml('<?xml version="1.0"?><!DOCTYPE a SYSTEM "x.dtd"><a k="1 &amp; 2"><!-- c --><b>x &lt; y</b><c><![CDATA[<raw>]]></c></a>');
    expect(n.attrs.k).toBe('1 & 2');
    expect(n.children[0].text).toBe('x < y');
    expect(n.children[1].text).toBe('<raw>');
  });
  it('rejects entity declarations (XXE / billion laughs)', () => {
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')).toThrow();
  });
  it('rejects malformed, mismatched and multi-root documents', () => {
    expect(() => parseXml('<a><b></a>')).toThrow();
    expect(() => parseXml('<a>')).toThrow();
    expect(() => parseXml('<a/><b/>')).toThrow();
    expect(() => parseXml('')).toThrow();
  });
  it('caps depth', () => {
    expect(() => parseXml('<a>'.repeat(60) + '</a>'.repeat(60))).toThrow();
  });
});

describe('buildSetupRequest / parseSetupResponse', () => {
  const xml = buildSetupRequest({
    payloadId: 'p1',
    timestamp: '2026-01-01T00:00:00+00:00',
    buyer: { domain: 'NetworkID', identity: 'BUYER&CO' },
    sender: { domain: 'NetworkID', identity: 'S', sharedSecret: 's<3cret', userAgent: 'Vireek' },
    supplier: { domain: 'DUNS', identity: '123' },
    buyerCookie: 'abc',
    returnUrl: 'https://x.supabase.co/functions/v1/punchout-return',
    deploymentMode: 'test',
    userEmail: 'a@b.co',
  });
  it('builds well-formed escaped cXML', () => {
    const root = parseXml(xml);
    expect(root.name).toBe('cXML');
    expect(xml).toContain('BUYER&amp;CO');
    expect(xml).toContain('s&lt;3cret');
    expect(xml).toContain('deploymentMode="test"');
    expect(xml).toContain('<BuyerCookie>abc</BuyerCookie>');
  });
  it('reads a success response with an https start page', () => {
    const r = parseSetupResponse('<cXML><Response><Status code="200" text="OK"/><PunchOutSetupResponse><StartPage><URL>https://shop.example.com/s?id=1&amp;t=2</URL></StartPage></PunchOutSetupResponse></Response></cXML>');
    expect(r).toMatchObject({ ok: true, code: 200, startUrl: 'https://shop.example.com/s?id=1&t=2' });
  });
  it('refuses a non-https or missing start page and reports refusals', () => {
    expect(parseSetupResponse('<cXML><Response><Status code="200" text="OK"/><PunchOutSetupResponse><StartPage><URL>http://x.com</URL></StartPage></PunchOutSetupResponse></Response></cXML>').ok).toBe(false);
    const bad = parseSetupResponse('<cXML><Response><Status code="401" text="Unauthorized"/></Response></cXML>');
    expect(bad).toMatchObject({ ok: false, code: 401, text: 'Unauthorized' });
    expect(() => parseSetupResponse('<cXML/>')).toThrow();
  });
});

describe('parseOrderMessage', () => {
  it('parses lines, prices, units and lead time', () => {
    const m = parseOrderMessage(buildOrderMessageForTest('cookie1', 'USD', [{ sku: 'CAP-45', qty: '2', price: '12.50', desc: '45/5 capacitor' }, { sku: 'CON-30', qty: '1', price: '24' }]));
    expect(m.buyerCookie).toBe('cookie1');
    expect(m.currency).toBe('USD');
    expect(m.lines).toHaveLength(2);
    expect(m.lines[0]).toMatchObject({ line_no: 1, sku: 'CAP-45', quantity: 2, unit_price_cents: 1250, uom: 'each', name: '45/5 capacitor' });
    expect(m.lines[1].unit_price_cents).toBe(2400);
  });
  it('merges duplicate SKUs with the same price and rejects conflicting prices', () => {
    const m = parseOrderMessage(buildOrderMessageForTest('c', 'USD', [{ sku: 'A', qty: '1', price: '5' }, { sku: 'a', qty: '2', price: '5' }]));
    expect(m.lines).toHaveLength(1);
    expect(m.lines[0].quantity).toBe(3);
    expect(() => parseOrderMessage(buildOrderMessageForTest('c', 'USD', [{ sku: 'A', qty: '1', price: '5' }, { sku: 'A', qty: '1', price: '6' }]))).toThrow(/different prices/);
  });
  it('rejects empty carts, fractional or zero quantities, bad prices, and missing cookies', () => {
    expect(() => parseOrderMessage(buildOrderMessageForTest('c', 'USD', []))).toThrow();
    expect(() => parseOrderMessage(buildOrderMessageForTest('c', 'USD', [{ sku: 'A', qty: '1.5', price: '5' }]))).toThrow();
    expect(() => parseOrderMessage(buildOrderMessageForTest('c', 'USD', [{ sku: 'A', qty: '0', price: '5' }]))).toThrow();
    expect(() => parseOrderMessage(buildOrderMessageForTest('c', 'USD', [{ sku: 'A', qty: '1', price: 'x' }]))).toThrow();
    expect(() => parseOrderMessage(buildOrderMessageForTest('', 'USD', [{ sku: 'A', qty: '1', price: '5' }]))).toThrow();
  });
});

describe('assertSafeSupplierUrl', () => {
  it('accepts normal https supplier hosts', () => {
    expect(assertSafeSupplierUrl('https://punchout.grainger.com/cxml')).toBe('https://punchout.grainger.com/cxml');
  });
  it('blocks http, credentials, ports, IPs and internal hosts', () => {
    for (const bad of ['http://a.com', 'https://u:p@a.com', 'https://a.com:8443', 'https://127.0.0.1', 'https://10.0.0.5/x', 'https://localhost', 'https://db.internal', 'https://abc.supabase.co/functions/v1/x', 'https://singlelabel', 'not a url', 'https://[::1]/']) {
      expect(() => assertSafeSupplierUrl(bad), bad).toThrow();
    }
  });
});

describe('mapUom', () => {
  it('maps known cXML units and passes others through', () => {
    expect(mapUom('EA')).toBe('each');
    expect(mapUom('BX')).toBe('box');
    expect(mapUom('')).toBe('each');
    expect(mapUom('FOO')).toBe('foo');
  });
});
