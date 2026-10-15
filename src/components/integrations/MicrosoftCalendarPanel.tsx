// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl, buildEventPayload, canManageCalendars, classifyGraphFailure, classifyJob, clampDuration,
  createTransactionId, hashPayload, jobWindow, mapOAuthError, needsRebaseline, normalizeTenant, parseGraphDateTime,
  parseRemoteEvent, planInboundChanges, planPushActions, signMsState, tokenNeedsRefresh, toBusyBlock, toGraphDateTime,
  verifyMsState, type InboundMapEntry, type SyncJob,
} from '../../supabase/functions/_shared/microsoft-calendar/engine';
import {
  describeConnection, formatRelativeSync, oauthReasonMessage, sortConnections,
} from '@/lib/microsoftCalendar';

const USER = '11111111-2222-3333-4444-555555555555';
const TECH = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOW = new Date('2027-03-01T12:00:00.000Z');

const job = (o: Partial<SyncJob> = {}): SyncJob => ({
  id: 'job-1', customer_name: 'Ana Silva', customer_phone: '+1 555 0100', service_type: 'AC repair', address: '12 Oak St',
  scheduled_datetime: '2027-03-02T15:00:00.000Z', duration_minutes: 90, assigned_technician_id: TECH, job_status: 'scheduled', dispatch_note: null, ...o,
});

describe('OAuth state', () => {
  it('round-trips user and scope', async () => {
    const s = await signMsState(USER, 'technician', 'secret', 1000);
    expect(await verifyMsState(s, 'secret', 2000)).toEqual({ userId: USER, scope: 'technician' });
  });
  it('rejects tampering, wrong secret, expiry, future timestamps and bad scope', async () => {
    const s = await signMsState(USER, 'office', 'secret', 1000);
    expect(await verifyMsState(s.replace('.office.', '.technician.'), 'secret', 2000)).toBeNull();
    expect(await verifyMsState(s, 'other', 2000)).toBeNull();
    expect(await verifyMsState(s, 'secret', 1000 + 11 * 60 * 1000)).toBeNull();
    expect(await verifyMsState(s, 'secret', 1000 - 5 * 60 * 1000)).toBeNull();
    expect(await verifyMsState('garbage', 'secret')).toBeNull();
    expect(await verifyMsState(s, '')).toBeNull();
  });
  it('refuses to sign without a secret', async () => {
    await expect(signMsState(USER, 'office', '')).rejects.toThrow();
  });
});

describe('tenant + authorize URL', () => {
  it('accepts known tenants and falls back to common for unsafe values', () => {
    expect(normalizeTenant('Organizations')).toBe('organizations');
    expect(normalizeTenant('contoso.onmicrosoft.com')).toBe('contoso.onmicrosoft.com');
    expect(normalizeTenant('72f988bf-86f1-41af-91ab-2d7cd011db47')).toBe('72f988bf-86f1-41af-91ab-2d7cd011db47');
    expect(normalizeTenant('../evil?x=1')).toBe('common');
    expect(normalizeTenant(undefined)).toBe('common');
  });
  it('requests offline access and calendar scopes only (no mail)', () => {
    const u = new URL(buildAuthorizeUrl({ clientId: 'cid', tenant: 'common', redirectUri: 'https://x/cb', state: 's' }));
    expect(u.origin + u.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(u.searchParams.get('scope')).toBe('offline_access User.Read Calendars.ReadWrite');
    expect(u.searchParams.get('prompt')).toBe('select_account');
    expect(u.searchParams.get('state')).toBe('s');
  });
  it('maps provider errors to safe codes', () => {
    expect(mapOAuthError('access_denied', 'user cancelled')).toBe('access_denied');
    expect(mapOAuthError('access_denied', 'AADSTS65001: consent')).toBe('admin_consent_required');
    expect(mapOAuthError('interaction_required')).toBe('admin_consent_required');
    expect(mapOAuthError('server_error')).toBe('provider_error');
  });
});

describe('date handling', () => {
  it('parses UTC Graph timestamps incl. 7-digit fractions and rejects other zones', () => {
    expect(parseGraphDateTime({ dateTime: '2027-03-02T15:00:00.0000000', timeZone: 'UTC' })?.toISOString()).toBe('2027-03-02T15:00:00.000Z');
    expect(parseGraphDateTime({ dateTime: '2027-03-02T15:00:00', timeZone: 'utc' })?.toISOString()).toBe('2027-03-02T15:00:00.000Z');
    expect(parseGraphDateTime({ dateTime: '2027-03-02T15:00:00', timeZone: 'Pacific Standard Time' })).toBeNull();
    expect(parseGraphDateTime({ dateTime: 'nope', timeZone: 'UTC' })).toBeNull();
    expect(parseGraphDateTime(null)).toBeNull();
  });
  it('formats for Graph without a trailing Z', () => {
    expect(toGraphDateTime(new Date('2027-03-02T15:00:00Z'))).toBe('2027-03-02T15:00:00.000');
  });
  it('decides when to rebaseline the delta window', () => {
    expect(needsRebaseline({ deltaLink: null, windowEnd: null }, NOW)).toBe(true);
    expect(needsRebaseline({ deltaLink: 'x', windowEnd: '2027-03-10T00:00:00Z' }, NOW)).toBe(true);
    expect(needsRebaseline({ deltaLink: 'x', windowEnd: '2027-06-01T00:00:00Z' }, NOW)).toBe(false);
  });
  it('detects tokens that need refreshing', () => {
    expect(tokenNeedsRefresh(null)).toBe(true);
    expect(tokenNeedsRefresh(new Date(NOW.getTime() + 30_000).toISOString(), NOW.getTime())).toBe(true);
    expect(tokenNeedsRefresh(new Date(NOW.getTime() + 600_000).toISOString(), NOW.getTime())).toBe(false);
  });
});

describe('jobs -> events', () => {
  it('clamps durations and defaults to 60', () => {
    expect(clampDuration(null)).toBe(60);
    expect(clampDuration(5)).toBe(15);
    expect(clampDuration(99999)).toBe(720);
    expect(jobWindow(job({ duration_minutes: 90 }))?.end.toISOString()).toBe('2027-03-02T16:30:00.000Z');
    expect(jobWindow(job({ scheduled_datetime: null }))).toBeNull();
  });
  it('classifies jobs per connection', () => {
    const tech = { scope: 'technician' as const, teamMemberId: TECH };
    const office = { scope: 'office' as const, teamMemberId: null };
    expect(classifyJob(job(), tech, NOW)).toBe('sync');
    expect(classifyJob(job(), office, NOW)).toBe('sync');
    expect(classifyJob(job({ assigned_technician_id: 'other' }), tech, NOW)).toBe('remove');
    expect(classifyJob(job({ assigned_technician_id: null }), office, NOW)).toBe('sync');
    expect(classifyJob(job({ job_status: 'cancelled' }), office, NOW)).toBe('remove');
    expect(classifyJob(job({ job_status: 'no_show' }), office, NOW)).toBe('remove');
    expect(classifyJob(job({ scheduled_datetime: null }), office, NOW)).toBe('remove');
    expect(classifyJob(null, office, NOW)).toBe('remove');
    expect(classifyJob(job({ scheduled_datetime: '2027-01-01T10:00:00Z', job_status: 'completed' }), office, NOW)).toBe('ignore');
  });
  it('builds a tagged busy event with a deterministic hash', async () => {
    const p = buildEventPayload(job(), 'https://vireek.com/')!;
    expect(p.subject).toBe('AC repair — Ana Silva');
    expect(p.showAs).toBe('busy');
    expect(p.categories).toEqual(['Vireek']);
    expect(p.start).toEqual({ dateTime: '2027-03-02T15:00:00.000', timeZone: 'UTC' });
    expect(p.body.content).toContain('https://vireek.com/dashboard/jobs');
    const h1 = await hashPayload(p);
    expect(await hashPayload(buildEventPayload(job(), 'https://vireek.com/')!)).toBe(h1);
    expect(await hashPayload(buildEventPayload(job({ scheduled_datetime: '2027-03-02T16:00:00Z' }), 'https://vireek.com')!)).not.toBe(h1);
    expect(buildEventPayload(job({ scheduled_datetime: null }), 'x')).toBeNull();
    expect(createTransactionId('j', 'c')).toBe('vireek-j-c');
  });
});

describe('push planning', () => {
  const payload = buildEventPayload(job(), 'https://vireek.com')!;
  const d = (jobId: string, hash: string) => ({ jobId, hash, payload });
  it('creates, updates, skips unchanged and deletes removed jobs', () => {
    const actions = planPushActions({
      desired: [d('new', 'h'), d('chg', 'h2'), d('same', 'h')],
      removeJobIds: ['gone', 'never-mapped'],
      mapped: [
        { jobId: 'chg', msEventId: 'e1', hash: 'h', status: 'synced' },
        { jobId: 'same', msEventId: 'e2', hash: 'h', status: 'synced' },
        { jobId: 'gone', msEventId: 'e3', hash: 'h', status: 'synced' },
      ],
    });
    expect(actions.map((a) => `${a.kind}:${a.jobId}`)).toEqual(['update:chg', 'create:new', 'delete:gone']);
  });
  it('respects a deletion made in Outlook until the job changes', () => {
    const mapped = [{ jobId: 'j', msEventId: 'e', hash: 'h', status: 'remote_deleted' as const }];
    expect(planPushActions({ desired: [d('j', 'h')], removeJobIds: [], mapped })).toEqual([]);
    expect(planPushActions({ desired: [d('j', 'h2')], removeJobIds: [], mapped }).map((a) => a.kind)).toEqual(['create']);
    expect(planPushActions({ desired: [], removeJobIds: ['j'], mapped }).map((a) => a.kind)).toEqual(['forget']);
  });
  it('forces an update when Vireek must overwrite Outlook, and honors the limit', () => {
    const mapped = [{ jobId: 'j', msEventId: 'e', hash: 'h', status: 'synced' as const }];
    expect(planPushActions({ desired: [d('j', 'h')], removeJobIds: [], mapped, forceUpdate: new Set(['j']) }).map((a) => a.kind)).toEqual(['update']);
    expect(planPushActions({ desired: [d('a', 'h'), d('b', 'h'), d('c', 'h')], removeJobIds: [], mapped: [], limit: 2 })).toHaveLength(2);
  });
});

describe('inbound (Outlook -> Vireek)', () => {
  const raw = (o: Record<string, unknown> = {}) => ({
    id: 'ev1', isCancelled: false, isAllDay: false, showAs: 'busy', categories: [],
    start: { dateTime: '2027-03-02T15:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2027-03-02T16:30:00.0000000', timeZone: 'UTC' },
    lastModifiedDateTime: '2027-03-01T10:00:00Z', ...o,
  });
  it('parses removed, invalid and normal events', () => {
    expect(parseRemoteEvent({ id: 'x', '@removed': { reason: 'deleted' } })?.removed).toBe(true);
    expect(parseRemoteEvent(raw())?.start?.toISOString()).toBe('2027-03-02T15:00:00.000Z');
    expect(parseRemoteEvent({ id: 'x', start: { dateTime: 'bad', timeZone: 'UTC' } })).toBeNull();
    expect(parseRemoteEvent(null)).toBeNull();
  });
  it('turns external events into busy blocks but never Vireek events', () => {
    const ev = parseRemoteEvent(raw())!;
    expect(toBusyBlock(ev, new Set())).toMatchObject({ msEventId: 'ev1', blocking: true, startsAt: '2027-03-02T15:00:00.000Z' });
    expect(toBusyBlock(ev, new Set(['ev1']))).toBeNull();
    expect(toBusyBlock(parseRemoteEvent(raw({ categories: ['Vireek'] }))!, new Set())).toBeNull();
    expect(toBusyBlock(parseRemoteEvent(raw({ isCancelled: true }))!, new Set())).toBeNull();
    expect(toBusyBlock(parseRemoteEvent(raw({ showAs: 'free' }))!, new Set())?.blocking).toBe(false);
    expect(toBusyBlock(parseRemoteEvent(raw({ showAs: 'oof' }))!, new Set())?.blocking).toBe(true);
    expect(toBusyBlock(parseRemoteEvent(raw({ showAs: 'workingElsewhere' }))!, new Set())?.blocking).toBe(false);
  });
  const entry = (o: Partial<InboundMapEntry> = {}): InboundMapEntry => ({ jobId: 'job-1', status: 'synced', lastPushedAt: new Date('2027-03-01T09:00:00Z'), ...o });
  const run = (rawEvent: Record<string, unknown>, e = entry(), j = job()) =>
    planInboundChanges([parseRemoteEvent(rawEvent)!], new Map([['ev1', e]]), new Map([[j.id, j]]));

  it('ignores echoes of our own push (times match)', () => {
    expect(run(raw())).toEqual({ changes: [], forceUpdateJobIds: new Set() });
  });
  it('reschedules the job when the user moved the event after our last push', () => {
    const r = run(raw({ start: { dateTime: '2027-03-03T10:00:00', timeZone: 'UTC' }, end: { dateTime: '2027-03-03T11:00:00', timeZone: 'UTC' } }));
    expect(r.changes).toEqual([{ kind: 'reschedule', jobId: 'job-1', newStart: '2027-03-03T10:00:00.000Z', durationMinutes: 60, expectedStart: '2027-03-02T15:00:00.000Z' }]);
  });
  it('makes Vireek win when the event is stale, all-day, or the job is no longer scheduled', () => {
    const moved = { start: { dateTime: '2027-03-03T10:00:00', timeZone: 'UTC' }, end: { dateTime: '2027-03-03T11:00:00', timeZone: 'UTC' } };
    expect(run(raw({ ...moved, lastModifiedDateTime: '2027-03-01T08:00:00Z' })).forceUpdateJobIds.has('job-1')).toBe(true);
    expect(run(raw({ ...moved, isAllDay: true })).forceUpdateJobIds.has('job-1')).toBe(true);
    expect(run(raw(moved), entry(), job({ job_status: 'in_progress' })).forceUpdateJobIds.has('job-1')).toBe(true);
  });
  it('never cancels a job when its event is deleted; it only unlinks', () => {
    expect(run({ id: 'ev1', '@removed': { reason: 'deleted' } }).changes).toEqual([{ kind: 'remote_deleted', jobId: 'job-1' }]);
    expect(run({ id: 'ev1', '@removed': {} }, entry({ status: 'remote_deleted' })).changes).toEqual([]);
  });
});

describe('failures and roles', () => {
  it('classifies Graph failures', () => {
    expect(classifyGraphFailure(400, 'invalid_grant')).toMatchObject({ errorCode: 'token_revoked', recoverable: false });
    expect(classifyGraphFailure(401)).toMatchObject({ errorCode: 'provider_auth_failed', recoverable: false });
    expect(classifyGraphFailure(403)).toMatchObject({ errorCode: 'scope_missing', recoverable: false });
    expect(classifyGraphFailure(410)).toMatchObject({ recoverable: true, resetDelta: true });
    expect(classifyGraphFailure(429)).toMatchObject({ errorCode: 'rate_limited', recoverable: true });
    expect(classifyGraphFailure(503)).toMatchObject({ errorCode: 'provider_unreachable', recoverable: true });
    expect(classifyGraphFailure(0).recoverable).toBe(true);
  });
  it('lets only owners/admins/team managers manage the office calendar', () => {
    expect(canManageCalendars({ role: 'owner' })).toBe(true);
    expect(canManageCalendars({ role: 'admin' })).toBe(true);
    expect(canManageCalendars({ role: 'technician', permissions: { can_manage_team: true } })).toBe(true);
    expect(canManageCalendars({ role: 'technician', permissions: { can_manage_team: false } })).toBe(false);
    expect(canManageCalendars({ role: 'member' })).toBe(false);
  });
});

describe('client helpers', () => {
  const base = { status: 'connected' as const, last_synced_at: '2027-03-01T11:58:00Z', last_error_code: null, consecutive_failures: 0 };
  it('formats relative sync times', () => {
    expect(formatRelativeSync(null, NOW)).toBe('Not synced yet');
    expect(formatRelativeSync('2027-03-01T11:59:50Z', NOW)).toBe('Synced just now');
    expect(formatRelativeSync('2027-03-01T11:58:00Z', NOW)).toBe('Synced 2 min ago');
    expect(formatRelativeSync('2027-03-01T08:00:00Z', NOW)).toBe('Synced 4 h ago');
    expect(formatRelativeSync('2027-02-26T12:00:00Z', NOW)).toBe('Synced 3 d ago');
  });
  it('describes connection health', () => {
    expect(describeConnection(base, NOW)).toMatchObject({ tone: 'ok', label: 'Connected', detail: 'Synced 2 min ago' });
    expect(describeConnection({ ...base, consecutive_failures: 2 }, NOW)).toMatchObject({ tone: 'warn', label: 'Retrying' });
    expect(describeConnection({ ...base, status: 'error', last_error_code: 'token_revoked' }, NOW)).toMatchObject({ tone: 'error', label: 'Needs reconnect' });
    expect(describeConnection({ ...base, status: 'disconnected' }, NOW).tone).toBe('warn');
  });
  it('maps OAuth reasons to friendly copy and sorts office first', () => {
    expect(oauthReasonMessage('admin_consent_required')).toContain('administrator');
    expect(oauthReasonMessage('weird')).toContain('try again');
    expect(oauthReasonMessage(null)).toContain('try again');
    const sorted = sortConnections([
      { scope: 'technician' as const, team_member: { member_name: 'Zed', member_email: null } },
      { scope: 'technician' as const, team_member: { member_name: 'Amy', member_email: null } },
      { scope: 'office' as const, team_member: null },
    ]);
    expect(sorted.map((c) => c.scope)).toEqual(['office', 'technician', 'technician']);
    expect(sorted[1].team_member?.member_name).toBe('Amy');
  });
});
