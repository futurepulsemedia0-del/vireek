import { describe, expect, it } from 'vitest';
import { computeNext, currencyMask, dateMask, decimalMask, licenseMask, patternMask, postalMask } from './masks';
import { parseTabular, sanitizeIdPaste, sanitizeOtpPaste, sanitizePhonePaste, tablePastePatches } from './paste';
import { createDraftStore, localStorageBackend, memoryBackend, sanitizeForDraft } from './draftStore';
import { createSubmitGuard, isNetworkError } from './submitGuard';
import { flattenFieldErrors, msg, parseMsg } from './errors';
import { toLatinDigits } from './text';

describe('text + messages', () => {
  it('normalizes Persian/Arabic digits', () => expect(toLatinDigits('۰۱۲۳۴۵۶۷۸۹ ٠١٢')).toBe('0123456789 012'));
  it('round-trips message params', () => expect(parseMsg(msg('k', { min: 3 }))).toEqual({ key: 'k', params: { min: 3 } }));
  it('flattens nested RHF errors', () =>
    expect(flattenFieldErrors({ a: { message: 'x', type: 't' }, b: { c: { message: 'y', type: 't' } } })).toEqual([
      { name: 'a', message: 'x' },
      { name: 'b.c', message: 'y' },
    ]));
});

describe('masks', () => {
  it('postal codes per country', () => {
    expect(postalMask('US').format('902101234').display).toBe('90210-1234');
    expect(postalMask('US').format('90210').display).toBe('90210'); // no trailing literal
    expect(postalMask('US').format('9a0b2').display).toBe('902');
    expect(postalMask('CA').format('k1a0b1').display).toBe('K1A 0B1');
    expect(postalMask('GB').format('sw1a1aa').display).toBe('SW1A 1AA');
    expect(postalMask('GB').format('m11aa').display).toBe('M1 1AA');
  });
  it.each([
    ['en-US', '1234567.891', '1,234,567.89'],
    ['de-DE', '1234567,5', '1.234.567,5'],
  ])('decimal display %s', (loc, input, out) => expect(decimalMask(loc, { maxFractionDigits: 2 }).format(input).display).toBe(out));
  it('accepts Persian digits', () => expect(decimalMask('fa-IR', { maxFractionDigits: 2 }).format('۱۲۳۴').value).toBe('1234'));
  it('currency pads on blur and respects JPY', () => {
    expect(currencyMask('en-US', 'USD').finalize?.('1,234.5').value).toBe('1234.50');
    expect(currencyMask('ja-JP', 'JPY').format('1234.5').display).toBe('12,345');
  });
  it('paste heuristic only on paste, never while typing', () => {
    const en = decimalMask('en-US', { maxFractionDigits: 2 });
    expect(en.format(en.normalizePaste?.('12,5') ?? '').value).toBe('12.5');
    expect(en.format(en.normalizePaste?.('1,234') ?? '').value).toBe('1234');
    const n = computeNext(en, { prevDisplay: '1,234', rawInput: '1,23', caret: 4, deleting: 'backward' });
    expect(n.value).toBe('123');
  });
  it('dates by locale, ISO once complete and real', () => {
    expect(dateMask('en-US').format('03152024')).toEqual({ display: '03/15/2024', value: '2024-03-15' });
    expect(dateMask('de-DE').format('15032024').display).toBe('15.03.2024');
    expect(dateMask('ja-JP').format('20240315').display).toBe('2024/03/15');
    expect(dateMask('en-US').format('02302024').value).toBe('02/30/2024'); // not a real date: stays partial
    expect(dateMask('de-DE').fromValue('2024-03-15')).toBe('15.03.2024');
  });
  it('license numbers', () => expect(licenseMask().format('ab 12-cd').display).toBe('AB12-CD'));
});

describe('caret never fights the user', () => {
  const ph = patternMask('(###) ###-####', { canonical: 'raw' });
  const en = decimalMask('en-US', { maxFractionDigits: 2 });
  it('keeps caret after an inserted digit inside a grouped number', () => {
    const n = computeNext(en, { prevDisplay: '1,234', rawInput: '1,2534', caret: 4 });
    expect([n.display, n.caret]).toEqual(['12,534', 4]);
  });
  it('backspace over a literal removes the previous digit', () => {
    const n = computeNext(ph, { prevDisplay: '(555) 123', rawInput: '(555)123', caret: 5, deleting: 'backward' });
    expect([n.display, n.caret]).toEqual(['(551) 23', 3]);
  });
  it('forward delete over a literal', () =>
    expect(computeNext(ph, { prevDisplay: '(555) 123', rawInput: '(555)123', caret: 5, deleting: 'forward' }).display).toBe('(555) 23'));
  it('first typed char', () => expect(computeNext(ph, { prevDisplay: '', rawInput: '5', caret: 1 })).toMatchObject({ display: '(5', caret: 2 }));
});

describe('paste', () => {
  it('phone / otp / id', () => {
    expect(sanitizePhonePaste(' +1 (555) 123‑4567\u200E ')).toBe('+15551234567');
    expect(sanitizePhonePaste('0044 20 7946 0958')).toBe('+442079460958');
    expect(sanitizePhonePaste('۰۹۱۲ ۱۲۳ ۴۵۶۷')).toBe('09121234567');
    expect(sanitizeOtpPaste('123 456-789', 6)).toBe('123456');
    expect(sanitizeIdPaste(' ab 12\u200B-cd\n')).toBe('AB12-CD');
  });
  it('parses TSV, quoted CSV, semicolon CSV', () => {
    expect(parseTabular('a\tb\n1\t2\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseTabular('a,"b,1","c ""q"""\n')).toEqual([['a', 'b,1', 'c "q"']]);
    expect(parseTabular('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('multi-cell paste maps onto rows/cols and clips', () => {
    expect(tablePastePatches(parseTabular('hello'), { row: 0, col: 0 }, { rows: 3, cols: 3 })).toEqual([]);
    expect(tablePastePatches([['a', 'b', 'c'], ['d', 'e', 'f']], { row: 2, col: 1 }, { rows: 3, cols: 3 })).toEqual([
      { row: 2, col: 1, value: 'a' },
      { row: 2, col: 2, value: 'b' },
    ]);
  });
});

describe('draft store', () => {
  const key = { userId: 'u1', formId: 'job' };
  it('strips sensitive keys at any depth, keeps the rest', () =>
    expect(sanitizeForDraft({ name: 'A', password: 'x', n: { cardNumber: '4', ok: 1 }, l: [{ token: 't', v: 2 }] })).toEqual({ name: 'A', n: { ok: 1 }, l: [{ v: 2 }] }));
  it('round-trips, versions, expires, purges per user', async () => {
    let t = 1000;
    const s = createDraftStore(memoryBackend(), { now: () => t, ttlMs: 500 });
    await s.save(key, 1, { title: 'x', password: 'p' });
    expect((await s.load(key, 1))?.data).toEqual({ title: 'x' });
    expect(await s.load(key, 2)).toBeNull();
    await s.save(key, 1, { title: 'x' });
    t += 600;
    expect(await s.load(key, 1)).toBeNull();
    await s.save({ userId: 'u1', formId: 'a' }, 1, { q: 1 });
    await s.save({ userId: 'u2', formId: 'a' }, 1, { q: 2 });
    await s.purge({ userId: 'u1', allForUser: true });
    expect(await s.load({ userId: 'u1', formId: 'a' }, 1)).toBeNull();
    expect((await s.load({ userId: 'u2', formId: 'a' }, 1))?.data).toEqual({ q: 2 });
  });
  it('writes nothing when every field is sensitive', async () => {
    const s = createDraftStore(memoryBackend());
    await s.save(key, 1, { password: 'only' });
    expect(await s.load(key, 1)).toBeNull();
  });
  it('localStorage fallback backend works', async () => {
    const s = createDraftStore(localStorageBackend(window.localStorage));
    await s.save(key, 1, { a: 1 });
    expect((await s.load(key, 1))?.data).toEqual({ a: 1 });
  });
});

describe('submit guard', () => {
  const mk = (failTimes: { n: number }, keys: string[], calls: { n: number }) =>
    createSubmitGuard(
      async (a: { n: number }, ctx) => {
        calls.n++;
        keys.push(ctx.idempotencyKey);
        if (failTimes.n-- > 0) throw new TypeError('Failed to fetch');
        return a.n;
      },
      { sleep: async () => undefined, isOnline: () => true },
    );
  it('double submit makes exactly one call', async () => {
    const calls = { n: 0 };
    const g = mk({ n: 0 }, [], calls);
    const [a, b] = await Promise.all([g.run({ n: 1 }), g.run({ n: 1 })]);
    expect([a.status, b.status, calls.n]).toEqual(['success', 'ignored', 1]);
  });
  it('retries network errors with the SAME idempotency key', async () => {
    const keys: string[] = [];
    const calls = { n: 0 };
    const r = await mk({ n: 2 }, keys, calls).run({ n: 2 });
    expect([r.status, calls.n, new Set(keys).size]).toEqual(['success', 3, 1]);
  });
  it('gives up after maxRetries and reuses the key on re-click of the same payload', async () => {
    const keys: string[] = [];
    const g = mk({ n: 99 }, keys, { n: 0 });
    expect((await g.run({ n: 3 })).status).toBe('error');
    await g.run({ n: 3 });
    expect(new Set(keys).size).toBe(1);
  });
  it('does not retry offline or 4xx', async () => {
    const off = await createSubmitGuard(async () => { throw new TypeError('x'); }, { isOnline: () => false, sleep: async () => undefined }).run(1);
    expect(off).toMatchObject({ status: 'error', offline: true });
    let c = 0;
    await createSubmitGuard(async () => { c++; throw Object.assign(new Error('bad'), { status: 400 }); }, { sleep: async () => undefined }).run(1);
    expect(c).toBe(1);
    expect(isNetworkError({ status: 503 })).toBe(true);
  });
});
