import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
const orderMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: (...a: unknown[]) => invokeMock(...a) },
    from: () => ({ select: () => ({ order: (...a: unknown[]) => orderMock(...a) }) }),
  },
}));

import {
  EMPTY_FORM,
  describeStatus,
  deleteDestination,
  destinationTarget,
  fetchDestinations,
  formFromDestination,
  formatRelativeTime,
  isSiemEligible,
  saveDestination,
  testDestination,
  validateForm,
  type DestinationForm,
  type SiemDestination,
} from './siemStreaming';

const NOW = new Date('2027-12-31T12:00:00Z').getTime();
const form = (over: Partial<DestinationForm> = {}): DestinationForm => ({
  ...EMPTY_FORM,
  name: 'Prod Splunk',
  url: 'https://http-inputs-acme.splunkcloud.com:443',
  secret: 'abcd-1234-efgh',
  ...over,
});
const dest = (over: Partial<SiemDestination> = {}): SiemDestination => ({
  id: 'd1',
  name: 'Prod Splunk',
  provider: 'splunk_hec',
  endpoint_url: 'https://splunk.acme.com:8088/services/collector/event',
  datadog_site: null,
  splunk_index: 'security',
  splunk_sourcetype: null,
  min_severity: 'medium',
  enabled: true,
  status: 'active',
  next_attempt_at: null,
  consecutive_failures: 0,
  last_success_at: null,
  last_error: null,
  last_error_at: null,
  events_sent_total: 0,
  events_dropped_total: 0,
  created_at: '2027-12-30T00:00:00Z',
  updated_at: '2027-12-30T00:00:00Z',
  ...over,
});

beforeEach(() => {
  invokeMock.mockReset();
  orderMock.mockReset();
});

describe('isSiemEligible', () => {
  it('requires owner and a Business/Enterprise plan', () => {
    expect(isSiemEligible('business', true)).toBe(true);
    expect(isSiemEligible('enterprise', true)).toBe(true);
    expect(isSiemEligible('professional', true)).toBe(false);
    expect(isSiemEligible('enterprise', false)).toBe(false);
    expect(isSiemEligible(null, true)).toBe(false);
  });
});

describe('validateForm', () => {
  it('accepts a valid Splunk form', () => {
    expect(validateForm(form(), false)).toEqual({});
  });
  it('accepts a valid Datadog form', () => {
    expect(validateForm(form({ provider: 'datadog', url: '', site: 'datadoghq.eu' }), false)).toEqual({});
  });
  it('requires name, url and token on create', () => {
    const e = validateForm(form({ name: ' ', url: '', secret: '' }), false);
    expect(e.name).toBeTruthy();
    expect(e.url).toBeTruthy();
    expect(e.secret).toBeTruthy();
  });
  it('lets the token stay blank when editing', () => {
    expect(validateForm(form({ secret: '' }), true).secret).toBeUndefined();
  });
  it.each(['http://splunk.acme.com', 'https://user:pw@splunk.acme.com', 'https://127.0.0.1:8088', 'https://localhost', 'https://splunk.internal', 'https://splunk.acme.com:80', 'nonsense'])(
    'rejects unsafe URL %s',
    (url) => {
      expect(validateForm(form({ url }), false).url).toBeTruthy();
    },
  );
  it('rejects bad tokens, index and sourcetype', () => {
    expect(validateForm(form({ secret: 'short' }), false).secret).toBeTruthy();
    expect(validateForm(form({ secret: 'has spaces in it' }), false).secret).toBeTruthy();
    expect(validateForm(form({ index: 'bad index!' }), false).index).toBeTruthy();
    expect(validateForm(form({ sourcetype: 'bad type!' }), false).sourcetype).toBeTruthy();
  });
  it('rejects an unknown Datadog site', () => {
    expect(validateForm(form({ provider: 'datadog', site: 'evil.com' }), false).site).toBeTruthy();
  });
});

describe('presentation helpers', () => {
  it('formats relative times', () => {
    expect(formatRelativeTime(null, NOW)).toBe('never');
    expect(formatRelativeTime('2027-12-31T11:59:50Z', NOW)).toBe('just now');
    expect(formatRelativeTime('2027-12-31T11:55:00Z', NOW)).toBe('5 minutes ago');
    expect(formatRelativeTime('2027-12-31T10:00:00Z', NOW)).toBe('2 hours ago');
    expect(formatRelativeTime('2027-12-31T12:10:00Z', NOW)).toBe('in 10 minutes');
    expect(formatRelativeTime('2027-12-28T12:00:00Z', NOW)).toBe('3 days ago');
  });
  it('describes every status', () => {
    expect(describeStatus(dest({ enabled: false }), NOW).label).toBe('Paused');
    expect(describeStatus(dest(), NOW)).toMatchObject({ label: 'Waiting for events', tone: 'neutral' });
    expect(describeStatus(dest({ last_success_at: '2027-12-31T11:58:00Z' }), NOW)).toMatchObject({ label: 'Streaming', tone: 'success' });
    expect(describeStatus(dest({ status: 'degraded', next_attempt_at: '2027-12-31T12:05:00Z' }), NOW)).toMatchObject({ label: 'Retrying', tone: 'warning' });
    expect(describeStatus(dest({ status: 'failing' }), NOW).tone).toBe('danger');
    expect(describeStatus(dest({ status: 'auth_failed' }), NOW).label).toBe('Needs attention');
  });
  it('derives form and target from a destination', () => {
    expect(formFromDestination(dest())).toMatchObject({ provider: 'splunk_hec', index: 'security', secret: '', minSeverity: 'medium' });
    expect(destinationTarget(dest())).toBe('splunk.acme.com:8088');
    expect(destinationTarget(dest({ provider: 'datadog', endpoint_url: null, datadog_site: 'datadoghq.eu' }))).toBe('datadoghq.eu');
  });
});

describe('API', () => {
  it('fetchDestinations returns rows and throws on error', async () => {
    orderMock.mockResolvedValueOnce({ data: [dest()], error: null });
    expect(await fetchDestinations()).toHaveLength(1);
    orderMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(fetchDestinations()).rejects.toThrow('boom');
  });
  it('saveDestination sends only the fields for the chosen provider and never logs the token', async () => {
    invokeMock.mockResolvedValueOnce({ data: { ok: true, id: 'new-1' }, error: null });
    const id = await saveDestination(form({ provider: 'datadog', site: 'datadoghq.com', url: 'https://ignored.example.com' }));
    expect(id).toBe('new-1');
    const [fn, opts] = invokeMock.mock.calls[0];
    expect(fn).toBe('siem-stream');
    expect(opts.body).toMatchObject({ action: 'save', provider: 'datadog', site: 'datadoghq.com', secret: 'abcd-1234-efgh' });
    expect(opts.body.url).toBeUndefined();
  });
  it('surfaces the server error message from a non-2xx response', async () => {
    const body = { error: 'SIEM log streaming requires a Business or Enterprise plan.' };
    const ctx = { clone: () => ({ json: async () => body }) };
    invokeMock.mockResolvedValueOnce({ data: null, error: { context: ctx } });
    await expect(saveDestination(form())).rejects.toThrow('requires a Business or Enterprise plan');
  });
  it('falls back to a generic message when the error has no body', async () => {
    invokeMock.mockResolvedValueOnce({ data: null, error: new Error('FunctionsFetchError') });
    await expect(deleteDestination('d1')).rejects.toThrow('Something went wrong');
  });
  it('testDestination returns a failed result without throwing', async () => {
    invokeMock.mockResolvedValueOnce({ data: { ok: false, error: 'HTTP 403: Invalid token' }, error: null });
    expect(await testDestination('d1')).toEqual({ ok: false, error: 'HTTP 403: Invalid token' });
  });
});
