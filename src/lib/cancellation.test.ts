import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();
const fromMock = vi.fn();
const exportToCsv = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) }, from: (...a: unknown[]) => fromMock(...a) },
}));
vi.mock('@/lib/csvExport', () => ({ exportToCsv: (...a: unknown[]) => exportToCsv(...a) }));

import {
  acceptWinBackOffer,
  daysUntil,
  exportAccountData,
  extractFunctionError,
  fetchCancellationContext,
  fetchUsageStats,
  formatLongDate,
  formatPrice,
  hasMeaningfulUsage,
  pauseSubscription,
  previewResumeDate,
  reasonSkipsAlternatives,
  resumeSubscription,
  scheduleCancellation,
} from './cancellation';

function query(result: { count?: number | null; data?: unknown[]; error?: unknown }) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'order', 'range']) q[m] = () => q;
  q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve({ count: result.count ?? 0, data: result.data ?? [], error: result.error ?? null }).then(res, rej);
  return q;
}

beforeEach(() => {
  invoke.mockReset();
  fromMock.mockReset();
  exportToCsv.mockReset();
});

describe('extractFunctionError', () => {
  it('reads the JSON body of a non-2xx response', async () => {
    const err = { context: { json: async () => ({ error: 'Nope', code: 'forbidden' }) } };
    expect(await extractFunctionError(err)).toEqual({ message: 'Nope', code: 'forbidden' });
  });

  it('falls back safely on anything unexpected', async () => {
    expect((await extractFunctionError(null)).code).toBe('unknown');
    expect((await extractFunctionError({ context: { json: async () => { throw new Error('bad'); } } })).code).toBe('unknown');
    expect((await extractFunctionError({ context: { json: async () => ({}) } })).code).toBe('unknown');
  });
});

describe('edge function wrappers', () => {
  const ctx = { plan: 'professional', status: 'active', current_period_end: null, cancel_at_period_end: false, paused_until: null, price_cents: 1, currency: 'USD', offer: null };

  it('sends the right action payloads', async () => {
    invoke.mockResolvedValue({ data: ctx, error: null });
    await fetchCancellationContext();
    await scheduleCancellation('too_expensive', 'x');
    await pauseSubscription(2, null, '');
    await acceptWinBackOffer('other', 'y');
    await resumeSubscription();
    const bodies = invoke.mock.calls.map((c) => c[1].body);
    expect(bodies).toEqual([
      { action: 'context' },
      { action: 'cancel', reason: 'too_expensive', detail: 'x' },
      { action: 'pause', months: 2, reason: null, detail: '' },
      { action: 'accept_offer', reason: 'other', detail: 'y' },
      { action: 'resume' },
    ]);
    expect(invoke.mock.calls.every((c) => c[0] === 'manage-subscription-cancellation')).toBe(true);
  });

  it('returns ok data on success', async () => {
    invoke.mockResolvedValue({ data: ctx, error: null });
    expect(await fetchCancellationContext()).toEqual({ ok: true, data: ctx });
  });

  it('surfaces server error code and message', async () => {
    invoke.mockResolvedValue({ data: null, error: { context: { json: async () => ({ error: 'Already scheduled', code: 'already_scheduled' }) } } });
    expect(await scheduleCancellation('other', '')).toEqual({ ok: false, error: 'Already scheduled', code: 'already_scheduled' });
  });

  it('handles error payloads inside a 200 and network failures', async () => {
    invoke.mockResolvedValue({ data: { error: 'Boom', code: 'server_error' }, error: null });
    expect(await resumeSubscription()).toMatchObject({ ok: false, code: 'server_error' });
    invoke.mockRejectedValue(new Error('offline'));
    expect(await resumeSubscription()).toMatchObject({ ok: false, code: 'network' });
  });
});

describe('usage stats', () => {
  it('counts the last 90 days from real tables', async () => {
    fromMock.mockReturnValueOnce(query({ count: 120 })).mockReturnValueOnce(query({ count: 31 })).mockReturnValueOnce(query({ count: 18 }));
    expect(await fetchUsageStats()).toEqual({ callsAnswered: 120, appointmentsBooked: 31, jobsCompleted: 18 });
  });

  it('returns null if any query fails', async () => {
    fromMock.mockReturnValue(query({ error: { message: 'rls' } }));
    expect(await fetchUsageStats()).toBeNull();
  });

  it('hasMeaningfulUsage hides empty or missing stats', () => {
    expect(hasMeaningfulUsage(null)).toBe(false);
    expect(hasMeaningfulUsage({ callsAnswered: 0, appointmentsBooked: 0, jobsCompleted: 0 })).toBe(false);
    expect(hasMeaningfulUsage({ callsAnswered: 1, appointmentsBooked: 0, jobsCompleted: 0 })).toBe(true);
  });
});

describe('exportAccountData', () => {
  it('downloads a CSV and returns the row count', async () => {
    fromMock.mockReturnValue(query({ data: [{ name: 'A' }, { name: 'B' }] }));
    expect(await exportAccountData('customers')).toBe(2);
    expect(fromMock).toHaveBeenCalledWith('customers');
    expect(exportToCsv).toHaveBeenCalledTimes(1);
    expect(exportToCsv.mock.calls[0][2]).toBe('vireek-customers');
  });

  it('does not download an empty file', async () => {
    fromMock.mockReturnValue(query({ data: [] }));
    expect(await exportAccountData('jobs')).toBe(0);
    expect(exportToCsv).not.toHaveBeenCalled();
  });

  it('throws when the query fails so the UI can report it', async () => {
    fromMock.mockReturnValue(query({ error: { message: 'denied' } }));
    await expect(exportAccountData('calls')).rejects.toThrow('denied');
  });
});

describe('helpers', () => {
  it('flags the closing-business reason as skipping alternatives', () => {
    expect(reasonSkipsAlternatives('closing_business')).toBe(true);
    expect(reasonSkipsAlternatives('too_expensive')).toBe(false);
    expect(reasonSkipsAlternatives(null)).toBe(false);
  });

  it('formats dates and prices with safe fallbacks', () => {
    expect(formatLongDate('2026-11-08T12:00:00Z')).toBe('November 8, 2026');
    expect(formatLongDate(null)).toBe('the end of your billing period');
    expect(formatLongDate('garbage', 'n/a')).toBe('n/a');
    expect(formatPrice(19900, 'USD')).toBe('$199.00');
    expect(formatPrice(null, 'USD')).toBeNull();
  });

  it('counts days until a date, never negative', () => {
    const now = new Date('2026-10-08T00:00:00Z');
    expect(daysUntil('2026-10-18T00:00:00Z', now)).toBe(10);
    expect(daysUntil('2026-10-01T00:00:00Z', now)).toBe(0);
    expect(daysUntil(null, now)).toBeNull();
  });

  it('previews pause resume dates with month-end clamping', () => {
    expect(previewResumeDate(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(previewResumeDate(new Date('2026-11-15T00:00:00Z'), 3).toISOString()).toBe('2027-02-15T00:00:00.000Z');
  });
});
