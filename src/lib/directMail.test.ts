// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET, GEOMETRY, addressKey, buildBackHtml, buildFrontHtml, buildLobPostcardPayload, campaignUtm, escapeHtml,
  formatTrackingCode, generateTrackingCode, hmacSha256Hex, isRetryableHttpStatus, isValidTrackingCode, landingRedirectPath,
  mapProviderEvent, normalizeAddress, normalizeTrackingCode, parseProviderPriceCents, parseSingleLineAddress, scanUrl,
  shouldAdvance, validateAddress, verifyLobSignature, trackingCodeToUtm, type PieceStatus,
} from '../../supabase/functions/_shared/direct-mail/engine';
import {
  chunk, computeMetrics, customersToRecipients, directMailErrorMessage, dollarsToCents, formatCents, formatPercent, maskToken,
  parseRecipientsCsv, parseReport, splitCsvLine, totalReport, validateDraft, webhookUrl, withTrackingCodes, EMPTY_DRAFT,
  type CampaignReportRow,
} from '@/lib/directMail';

const bytes = (...n: number[]) => Uint8Array.from([...n, ...Array(8).fill(0)].slice(0, 8));

describe('tracking codes', () => {
  it('generates 9 symbols from the safe alphabet with a valid check symbol', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateTrackingCode();
      expect(code).toHaveLength(9);
      expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
      expect(isValidTrackingCode(code)).toBe(true);
    }
  });

  it('is deterministic for given random bytes and never uses look-alike letters', () => {
    expect(generateTrackingCode(bytes(0, 1, 2, 3, 4, 5, 6, 7))).toBe(generateTrackingCode(bytes(0, 1, 2, 3, 4, 5, 6, 7)));
    expect(CODE_ALPHABET).toHaveLength(32);
    for (const bad of 'ILOU') expect(CODE_ALPHABET.includes(bad)).toBe(false);
  });

  it('rejects every single-symbol typo', () => {
    const code = generateTrackingCode(bytes(9, 17, 3, 30, 12, 25, 1, 7));
    for (let pos = 0; pos < 9; pos++) {
      for (const ch of CODE_ALPHABET) {
        if (ch === code[pos]) continue;
        expect(isValidTrackingCode(code.slice(0, pos) + ch + code.slice(pos + 1))).toBe(false);
      }
    }
  });

  it('normalizes spacing, case and look-alikes', () => {
    const code = generateTrackingCode(bytes(0, 0, 0, 0, 0, 0, 0, 0));
    expect(normalizeTrackingCode(` ${code.slice(0, 4).toLowerCase()}-${code.slice(4, 8)} ${code[8]} `)).toBe(code);
    expect(normalizeTrackingCode('oIl0')).toBe('0110');
    expect(isValidTrackingCode(formatTrackingCode(code))).toBe(true);
    expect(isValidTrackingCode('')).toBe(false);
    expect(isValidTrackingCode('ABC')).toBe(false);
    expect(formatTrackingCode(code)).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]$/);
  });

  it('builds the attribution contract used by the landing analytics', () => {
    const code = generateTrackingCode(bytes(1, 2, 3, 4, 5, 6, 7, 8));
    const id = '0a1b2c3d-1111-2222-3333-444455556666';
    expect(campaignUtm(id)).toBe('dm-0a1b2c3d');
    expect(scanUrl('https://vireek.com/', code)).toBe(`https://vireek.com/m/${code}`);
    const path = landingRedirectPath('spring-tuneup', id, code);
    const q = new URLSearchParams(path.split('?')[1]);
    expect(path.startsWith('/lp/spring-tuneup?')).toBe(true);
    expect(q.get('utm_source')).toBe('direct_mail');
    expect(q.get('utm_medium')).toBe('postcard');
    expect(q.get('utm_campaign')).toBe('dm-0a1b2c3d');
    expect(q.get('utm_content')).toBe(trackingCodeToUtm(code));
    expect(q.get('utm_content')).toBe(code.toLowerCase());
  });
});

describe('addresses', () => {
  const good = { name: 'Ana Silva', line1: '12 Oak St', line2: '', city: 'Austin', state: 'tx', zip: '78701' };

  it('normalizes and validates', () => {
    expect(normalizeAddress({ ...good, name: '  Ana   Silva ' }).name).toBe('Ana Silva');
    expect(normalizeAddress(good).state).toBe('TX');
    expect(normalizeAddress({ ...good, zip: '787011234' }).zip).toBe('78701-1234');
    expect(validateAddress(good)).toEqual([]);
    expect(validateAddress({ ...good, state: 'ZZ' })).toContain('state_invalid');
    expect(validateAddress({ ...good, zip: '7870' })).toContain('zip_invalid');
    expect(validateAddress({ ...good, name: '' })).toContain('name_required');
    expect(validateAddress({})).toHaveLength(5);
  });

  it('builds a stable de-duplication key (mirrors the SQL function)', () => {
    expect(addressKey({ line1: '12 Oak St.', line2: 'Apt 4', zip: '78701-1234' })).toBe('12oakstapt4|78701');
    expect(addressKey({ line1: '12  OAK st', line2: '', zip: '78701' })).toBe('12oakst|78701');
  });

  it('parses single-line addresses only when they clearly parse', () => {
    expect(parseSingleLineAddress('123 Main St, Austin, TX 78701')).toEqual({ line1: '123 Main St', line2: '', city: 'Austin', state: 'TX', zip: '78701' });
    expect(parseSingleLineAddress('123 Main St, Apt 4, Austin, TX 78701-1234, USA')).toEqual({ line1: '123 Main St', line2: 'Apt 4', city: 'Austin', state: 'TX', zip: '78701-1234' });
    expect(parseSingleLineAddress('Main Street, Austin, TX 78701')).toBeNull(); // no street number
    expect(parseSingleLineAddress('123 Main St Austin TX')).toBeNull();
    expect(parseSingleLineAddress('123 Main St, Austin, ZZ 78701')).toBeNull();
  });
});

describe('postcard artwork', () => {
  const art = {
    size: '6x9' as const, brand: 'Acme <HVAC>', headline: 'Beat the heat', offer: '$79 tune-up', cta: 'Scan to book',
    phone: '(512) 555-0100', accent: '#0F62FE', code: generateTrackingCode(bytes(1, 1, 1, 1, 1, 1, 1, 1)), scanUrl: 'https://x/m/A',
    qrSvg: '<svg viewBox="0 0 1 1"></svg>',
  };

  it('escapes user text and embeds the code, QR and phone', () => {
    const back = buildBackHtml(art);
    const front = buildFrontHtml(art);
    expect(front).toContain('Acme &lt;HVAC&gt;');
    expect(front).not.toContain('<HVAC>');
    expect(back).toContain(formatTrackingCode(art.code));
    expect(back).toContain(art.qrSvg);
    expect(back).toContain('(512) 555-0100');
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('uses the print size (with bleed) and falls back to a safe color', () => {
    for (const size of ['4x6', '6x9', '6x11'] as const) {
      expect(buildFrontHtml({ ...art, size })).toContain(`width:${GEOMETRY[size].widthIn}in`);
    }
    expect(buildFrontHtml({ ...art, accent: 'red;}</style><script>' })).toContain('#0F62FE');
  });

  it('builds the Lob request', () => {
    const to = normalizeAddress({ name: 'Ana', line1: '12 Oak St', line2: 'Apt 2', city: 'Austin', state: 'TX', zip: '78701' });
    const from = normalizeAddress({ name: 'Acme', line1: '1 Main', city: 'Austin', state: 'TX', zip: '78702' });
    const p = buildLobPostcardPayload({ size: '4x6', mailType: 'usps_standard', front: 'F', back: 'B', to, from, description: 'x'.repeat(400), metadata: { piece_id: 'p' } });
    expect(p.description).toHaveLength(255);
    expect(p.to.address_line2).toBe('Apt 2');
    expect('address_line2' in p.from).toBe(false);
    expect(p).toMatchObject({ size: '4x6', mail_type: 'usps_standard', use_type: 'marketing', front: 'F', back: 'B' });
    expect(p.to.address_country).toBe('US');
  });
});

describe('provider helpers', () => {
  it('parses prices to cents', () => {
    expect(parseProviderPriceCents('0.85')).toBe(85);
    expect(parseProviderPriceCents('1.250')).toBe(125);
    expect(parseProviderPriceCents(2)).toBe(200);
    expect(parseProviderPriceCents('$0.74')).toBe(74);
    expect(parseProviderPriceCents(null)).toBeNull();
    expect(parseProviderPriceCents('')).toBeNull();
    expect(parseProviderPriceCents('abc')).toBeNull();
  });

  it('classifies retryable statuses', () => {
    for (const s of [408, 429, 500, 503]) expect(isRetryableHttpStatus(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 422]) expect(isRetryableHttpStatus(s)).toBe(false);
  });

  it('maps provider events and only moves status forward', () => {
    expect(mapProviderEvent('postcard.delivered')).toBe('delivered');
    expect(mapProviderEvent('postcard.in_local_area')).toBe('in_transit');
    expect(mapProviderEvent('postcard.rendered_pdf')).toBeNull();
    expect(mapProviderEvent('something.else')).toBeNull();
    const s = (c: PieceStatus, n: PieceStatus) => shouldAdvance(c, n);
    expect(s('submitted', 'in_transit')).toBe(true);
    expect(s('delivered', 'in_transit')).toBe(false);
    expect(s('in_transit', 'in_transit')).toBe(false);
    expect(s('in_transit', 'delivered')).toBe(true);
    expect(s('delivered', 'returned')).toBe(true);
    expect(s('in_transit', 'failed')).toBe(true);
    expect(s('delivered', 'failed')).toBe(false);
    expect(s('failed', 'in_transit')).toBe(false);
    expect(s('cancelled', 'delivered')).toBe(false);
  });
});

describe('webhook signature', () => {
  const secret = 'whsec_test_secret';
  const body = '{"id":"evt_1","event_type":{"id":"postcard.delivered"}}';
  const now = 1_800_000_000_000;

  it('accepts a correct signature (ms or seconds timestamp)', async () => {
    const sig = await hmacSha256Hex(secret, `${now}.${body}`);
    expect(await verifyLobSignature({ secret, timestamp: String(now), signature: sig, rawBody: body, nowMs: now + 1000 })).toBe(true);
    const secs = String(Math.floor(now / 1000));
    const sig2 = await hmacSha256Hex(secret, `${secs}.${body}`);
    expect(await verifyLobSignature({ secret, timestamp: secs, signature: sig2.toUpperCase(), rawBody: body, nowMs: now })).toBe(true);
  });

  it('fails closed on tampering, staleness, wrong secret and missing parts', async () => {
    const sig = await hmacSha256Hex(secret, `${now}.${body}`);
    const base = { secret, timestamp: String(now), signature: sig, rawBody: body, nowMs: now };
    expect(await verifyLobSignature({ ...base, rawBody: body + ' ' })).toBe(false);
    expect(await verifyLobSignature({ ...base, nowMs: now + 6 * 60 * 1000 })).toBe(false);
    expect(await verifyLobSignature({ ...base, secret: 'other' })).toBe(false);
    expect(await verifyLobSignature({ ...base, secret: null })).toBe(false);
    expect(await verifyLobSignature({ ...base, signature: null })).toBe(false);
    expect(await verifyLobSignature({ ...base, timestamp: 'abc' })).toBe(false);
  });
});

describe('recipient import', () => {
  const csv = [
    'Name,Address,Address 2,City,State,Zip',
    'Ana Silva,12 Oak St,,Austin,TX,78701',
    '"Smith, Bob",5 Elm Ave,Apt 3,Dallas,tx,75001-1234',
    'Ana Silva,12 oak st.,,Austin,TX,78701',
    'No State,1 Road,,Town,,12345',
    ',2 Road,,Town,TX,12345',
  ].join('\n');

  it('parses, validates and de-duplicates', () => {
    const r = parseRecipientsCsv(csv);
    expect(r.recipients).toHaveLength(2);
    expect(r.recipients[1].name).toBe('Smith, Bob');
    expect(r.recipients[1].state).toBe('TX');
    expect(r.duplicates).toBe(1);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0].line).toBe(5);
    expect(r.errors[0].reason).toContain('invalid state');
    expect(r.errors[1].reason).toContain('missing name');
  });

  it('reports missing headers and empty input', () => {
    expect(parseRecipientsCsv('name,city\nA,B').errors[0].reason).toContain('missing column');
    expect(parseRecipientsCsv('').errors).toHaveLength(1);
    expect(parseRecipientsCsv('name,street,city,st,postal\nA,1 B St,C,tx,12345').recipients).toHaveLength(1);
    expect(parseRecipientsCsv('name\taddress\tcity\tstate\tzip\nA\t1 B St\tC\ttx\t12345').recipients).toHaveLength(1);
  });

  it('splits quoted CSV cells', () => {
    expect(splitCsvLine('a,"b,c","d ""e"""', ',')).toEqual(['a', 'b,c', 'd "e"']);
  });

  it('imports mailable customers only', () => {
    const r = customersToRecipients([
      { name: 'Ana', address: '12 Oak St, Austin, TX 78701' },
      { name: 'Ana Again', address: '12 oak st, Austin, TX 78701' },
      { name: 'Bad', address: 'somewhere nice' },
      { name: null, address: '1 A St, Austin, TX 78701' },
    ]);
    expect(r.recipients).toHaveLength(1);
    expect(r.duplicates).toBe(1);
    expect(r.errors).toHaveLength(2);
  });

  it('attaches unique valid tracking codes', () => {
    const list = withTrackingCodes(Array.from({ length: 300 }, (_, i) => ({ name: `N${i}`, line1: `${i} A St`, line2: '', city: 'C', state: 'TX', zip: '78701' })));
    expect(new Set(list.map((r) => r.tracking_code)).size).toBe(300);
    expect(list.every((r) => isValidTrackingCode(r.tracking_code))).toBe(true);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('report maths', () => {
  const row = (o: Partial<CampaignReportRow> = {}): CampaignReportRow => ({
    campaign_id: 'c1', name: 'Spring', status: 'completed', size: '6x9', created_at: '2027-03-01', sent_at: null,
    pieces_total: 1000, queued: 0, in_mail: 0, delivered: 950, returned: 10, failed: 0, mailed: 1000, cost_cents: 85000,
    cost_estimated_pieces: 0, scanned_pieces: 60, scans: 80, landing_views: 70, landing_visitors: 55, leads: 25, responders: 30,
    booked_jobs: 17, completed_jobs: 12, revenue: 5400, ...o,
  });

  it('computes cost per booked job, response rate and ROAS', () => {
    const m = computeMetrics(row());
    expect(m.costPerBookedJob).toBe(5000);
    expect(m.responseRate).toBeCloseTo(0.03, 5);
    expect(m.scanRate).toBeCloseTo(0.06, 5);
    expect(m.costPerLead).toBe(3400);
    expect(m.costPerResponse).toBe(2833);
    expect(m.roas).toBeCloseTo(5400 / 850, 5);
    expect(m.costIsEstimate).toBe(false);
  });

  it('never divides by zero and flags estimated costs', () => {
    const m = computeMetrics(row({ mailed: 0, booked_jobs: 0, leads: 0, responders: 0, cost_cents: 0, cost_estimated_pieces: 3 }));
    expect(m.costPerBookedJob).toBeNull();
    expect(m.responseRate).toBeNull();
    expect(m.roas).toBeNull();
    expect(m.costIsEstimate).toBe(true);
  });

  it('totals campaigns and parses raw RPC output defensively', () => {
    const t = totalReport([row(), row({ campaign_id: 'c2', booked_jobs: 3, cost_cents: 15000, mailed: 200 })]);
    expect(t.booked_jobs).toBe(20);
    expect(t.cost_cents).toBe(100000);
    expect(t.mailed).toBe(1200);
    expect(parseReport(null)).toEqual([]);
    expect(parseReport([{ campaign_id: 'x', name: 'n', cost_cents: '1250', revenue: '99.5' }])[0].cost_cents).toBe(1250);
    expect(parseReport([{ campaign_id: 'x' }])[0].leads).toBe(0);
  });

  it('formats money and percentages', () => {
    expect(formatCents(5000)).toBe('$50');
    expect(formatCents(85)).toBe('$0.85');
    expect(formatCents(null)).toBe('—');
    expect(formatPercent(0.03)).toBe('3.0%');
    expect(formatPercent(0.25)).toBe('25%');
    expect(formatPercent(null)).toBe('—');
    expect(dollarsToCents('$1,250.50')).toBe(125050);
    expect(dollarsToCents('')).toBeNull();
    expect(dollarsToCents('abc')).toBeNull();
  });
});

describe('campaign draft validation', () => {
  const ok = { ...EMPTY_DRAFT, name: 'Spring', landing_page_id: 'lp', headline: 'Hi', offer: 'Deal', est_unit_cost: '0.85' };

  it('accepts a complete draft', () => {
    expect(validateDraft(ok)).toEqual({});
    expect(validateDraft({ ...ok, budget_cap: '500' })).toEqual({});
  });

  it('flags each problem', () => {
    const e = validateDraft({ ...EMPTY_DRAFT, accent_color: 'blue', est_unit_cost: '', budget_cap: '0' });
    for (const k of ['name', 'landing_page_id', 'headline', 'offer', 'accent_color', 'est_unit_cost', 'budget_cap']) expect(e).toHaveProperty(k);
    expect(validateDraft({ ...ok, budget_cap: '0.5' }).budget_cap).toContain('lower than one mailer');
    expect(validateDraft({ ...ok, headline: 'x'.repeat(81) }).headline).toContain('80');
  });
});

describe('errors and urls', () => {
  it('maps server error codes to friendly copy', () => {
    expect(directMailErrorMessage({ message: 'campaign_locked' }, 'x')).toContain('can no longer be edited');
    expect(directMailErrorMessage('landing_page_not_published', 'x')).toContain('Publish the landing page');
    expect(directMailErrorMessage({ code: '42501', message: 'boom' }, 'x')).toContain('permission');
    expect(directMailErrorMessage({ message: 'weird' }, 'fallback')).toBe('fallback');
  });

  it('builds and masks the webhook URL', () => {
    const token = 'a1b2c3'.padEnd(64, '0');
    const url = webhookUrl('https://p.supabase.co/', token);
    expect(url).toBe(`https://p.supabase.co/functions/v1/direct-mail-webhook/${token}`);
    expect(maskToken(url)).toContain('••••');
    expect(maskToken(url)).not.toContain(token);
    expect(webhookUrl('https://p.supabase.co', null)).toBe('');
  });
});
