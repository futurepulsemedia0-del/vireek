import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWarrantyPayload,
  emptyWarrantyForm,
  firstInvalidField,
  isEmail,
  isIsoDate,
  submitWarrantyRegistration,
  validateWarrantyForm,
  type WarrantyFormState,
} from '@/lib/warrantyRegistration';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const TODAY = '2027-04-16';

const valid = (extra: Partial<WarrantyFormState> = {}): WarrantyFormState => ({
  ...emptyWarrantyForm(),
  name: 'Maria Gomez',
  email: 'maria@example.com',
  equipmentType: 'Furnace',
  make: 'Carrier',
  serial: 'SN-48291-X',
  purchaseDate: '2027-03-01',
  terms: true,
  ...extra,
});

describe('helpers', () => {
  it('validates emails and calendar dates', () => {
    expect(isEmail('a@b.co')).toBe(true);
    expect(isEmail('a@b')).toBe(false);
    expect(isEmail('a b@c.com')).toBe(false);
    expect(isIsoDate('2027-02-28')).toBe(true);
    expect(isIsoDate('2027-02-30')).toBe(false);
    expect(isIsoDate('27-02-28')).toBe(false);
  });
});

describe('validateWarrantyForm', () => {
  it('accepts a complete form', () => {
    expect(validateWarrantyForm(valid(), TODAY)).toEqual({});
  });

  it('flags every missing required field', () => {
    const errors = validateWarrantyForm(emptyWarrantyForm(), TODAY);
    expect(Object.keys(errors).sort()).toEqual(['email', 'equipmentType', 'make', 'name', 'purchaseDate', 'serial', 'terms']);
  });

  it('checks serial format and length', () => {
    expect(validateWarrantyForm(valid({ serial: 'abc' }), TODAY).serial).toBeTruthy();
    expect(validateWarrantyForm(valid({ serial: '***###' }), TODAY).serial).toBeTruthy();
    expect(validateWarrantyForm(valid({ serial: 'A'.repeat(61) }), TODAY).serial).toBeTruthy();
    expect(validateWarrantyForm(valid({ serial: 'ab 12/34' }), TODAY).serial).toBeUndefined();
  });

  it('rejects future and impossible dates, and install before purchase', () => {
    expect(validateWarrantyForm(valid({ purchaseDate: '2027-04-17' }), TODAY).purchaseDate).toBeTruthy();
    expect(validateWarrantyForm(valid({ purchaseDate: '2027-02-30' }), TODAY).purchaseDate).toBeTruthy();
    expect(validateWarrantyForm(valid({ installDate: '2027-02-01' }), TODAY).installDate).toBeTruthy();
    expect(validateWarrantyForm(valid({ installDate: '2027-03-01' }), TODAY).installDate).toBeUndefined();
    expect(validateWarrantyForm(valid({ installDate: '' }), TODAY).installDate).toBeUndefined();
  });

  it('validates optional phone and passport code only when provided', () => {
    expect(validateWarrantyForm(valid({ phone: '12' }), TODAY).phone).toBeTruthy();
    expect(validateWarrantyForm(valid({ phone: '+1 (555) 010-2345' }), TODAY).phone).toBeUndefined();
    expect(validateWarrantyForm(valid({ passportCode: 'nope' }), TODAY).passportCode).toBeTruthy();
    expect(validateWarrantyForm(valid({ passportCode: 'veq-abcd-efgh-jkmn' }), TODAY).passportCode).toBeUndefined();
  });

  it('requires the terms checkbox', () => {
    expect(validateWarrantyForm(valid({ terms: false }), TODAY).terms).toBeTruthy();
  });

  it('reports the first invalid field in page order', () => {
    expect(firstInvalidField({ terms: 'x', email: 'y' })).toBe('email');
    expect(firstInvalidField({})).toBeNull();
  });
});

describe('buildWarrantyPayload', () => {
  it('trims, lowercases the email, normalizes the code and drops empty optionals', () => {
    const p = buildWarrantyPayload(valid({ name: '  Maria Gomez ', email: ' Maria@Example.COM ', passportCode: 'veq-abcd-efgh-jkmn', phone: '  ', model: '' }));
    expect(p).toMatchObject({ name: 'Maria Gomez', email: 'maria@example.com', passportCode: 'ABCDEFGHJKMN', termsAccepted: true, website: '' });
    expect(p.phone).toBeUndefined();
    expect(p.model).toBeUndefined();
    expect(p.installDate).toBeUndefined();
  });
});

describe('submitWarrantyRegistration', () => {
  const reply = (status: number, body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://x.supabase.co/');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('posts to the edge function and maps a success receipt', async () => {
    const fetchMock = reply(200, { ok: true, confirmationCode: 'WR-ABCD1234', passportCode: 'ABCDEFGHJKMN', linked: true, duplicate: false, emailSent: true });
    vi.stubGlobal('fetch', fetchMock);

    const res = await submitWarrantyRegistration(valid());
    expect(res).toEqual({ ok: true, confirmationCode: 'WR-ABCD1234', passportCode: 'ABCDEFGHJKMN', linked: true, duplicate: false, emailSent: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x.supabase.co/functions/v1/warranty-register');
    expect((init.headers as Record<string, string>).apikey).toBe('anon-key');
    expect(JSON.parse(init.body as string)).toMatchObject({ email: 'maria@example.com', serial: 'SN-48291-X', termsAccepted: true });
  });

  it('maps rate limiting, validation and unknown passport responses', async () => {
    vi.stubGlobal('fetch', reply(429, { error: 'rate_limited', message: 'Slow down' }));
    expect(await submitWarrantyRegistration(valid())).toMatchObject({ ok: false, kind: 'rate_limited', message: 'Slow down' });

    vi.stubGlobal('fetch', reply(400, { error: 'validation', message: 'Fix fields', fieldErrors: { email: 'Bad email' } }));
    expect(await submitWarrantyRegistration(valid())).toMatchObject({ ok: false, kind: 'validation', fieldErrors: { email: 'Bad email' } });

    vi.stubGlobal('fetch', reply(404, { error: 'passport_not_found', message: 'No such passport', fieldErrors: { passportCode: 'No such passport' } }));
    expect(await submitWarrantyRegistration(valid())).toMatchObject({ ok: false, kind: 'not_found', fieldErrors: { passportCode: 'No such passport' } });
  });

  it('degrades to a friendly error on network failure, bad bodies and missing config', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    expect(await submitWarrantyRegistration(valid())).toMatchObject({ ok: false, kind: 'network' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 })));
    expect(await submitWarrantyRegistration(valid())).toMatchObject({ ok: false, kind: 'server' });

    vi.stubEnv('VITE_SUPABASE_URL', '');
    expect(await submitWarrantyRegistration(valid())).toMatchObject({ ok: false, kind: 'server' });
  });
});
