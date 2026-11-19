import { describe, expect, it, vi } from 'vitest';
import en from '@/locales/en/numberHealth.json';
import fa from '@/locales/fa/numberHealth.json';
import enHeat from '@/locales/en/safetyHeat.json';
import faHeat from '@/locales/fa/safetyHeat.json';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  ATTESTATION_LEVELS,
  BATCH_SIZE,
  EMPTY_ROW,
  MIN_RECHECK_MINUTES,
  REMEDIATION_STEP_IDS,
  SCHEDULED_RECHECK_HOURS,
  SPAM_LABELS,
  applyOutcome,
  buildRemediation,
  chunk,
  createStubAdapter,
  indexResults,
  isE164,
  isStale,
  normalizeAttestation,
  normalizeSpamLabel,
  remediationProgress,
  resolveAdapter,
  sanitizeSources,
  selectDue,
  severityOf,
  type Candidate,
  type HealthRowState,
} from '../../supabase/functions/_shared/number-health/core';
import { viewOf, type NumberHealthRow } from './numberHealth';

const NOW = new Date('2030-03-01T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const ok = (over: Partial<HealthRowState> = {}): HealthRowState => ({ ...EMPTY_ROW, status: 'ok', spamLabel: 'clean', attestation: 'A', checkedAt: hoursAgo(6), lastAttemptAt: hoursAgo(6), ...over });

describe('stub adapter and registry', () => {
  it('never invents a label or attestation', async () => {
    const out = await createStubAdapter().lookup(['+15125550123']);
    expect(out).toEqual({ ok: true, results: [{ e164: '+15125550123', spamLabel: 'unknown', attestation: 'unknown', labelSources: [] }] });
  });
  it('is not live', () => expect(createStubAdapter().isLive).toBe(false));
  it('serves fixtures only when explicitly given (tests/demos)', async () => {
    const out = await createStubAdapter({ '+15125550123': { spamLabel: 'flagged', attestation: 'C', labelSources: ['Carrier X'] } }).lookup(['+15125550123', '+15125550999']);
    expect(out.ok && out.results.map((r) => r.spamLabel)).toEqual(['flagged', 'unknown']);
  });
  it('falls back to the stub for an unknown provider id, and says so', () => {
    expect(resolveAdapter('acme', {})).toMatchObject({ fellBack: true, adapter: { id: 'stub' } });
    expect(resolveAdapter(undefined, {}).fellBack).toBe(false);
  });
  it('uses a registered factory and is not fooled by prototype names', () => {
    const live = { id: 'acme', isLive: true, lookup: async () => ({ ok: true as const, results: [] }) };
    expect(resolveAdapter(' ACME ', { acme: () => live }).adapter.id).toBe('acme');
    expect(resolveAdapter('constructor', {}).adapter.id).toBe('stub');
  });
});

describe('normalisation', () => {
  it('maps provider vocabulary to ours and defaults to unknown', () => {
    expect(normalizeSpamLabel('Spam Likely')).toBe('suspected');
    expect(normalizeSpamLabel('SCAM')).toBe('flagged');
    expect(normalizeSpamLabel('no-label')).toBe('clean');
    expect(normalizeSpamLabel('???')).toBe('unknown');
    expect(normalizeSpamLabel(42)).toBe('unknown');
    expect(normalizeAttestation('Full')).toBe('A');
    expect(normalizeAttestation('partial attestation')).toBe('B');
    expect(normalizeAttestation('Gateway')).toBe('C');
    expect(normalizeAttestation(null)).toBe('unknown');
  });
  it('bounds and cleans third-party source names', () => {
    expect(sanitizeSources(['A<script>', 'A<script>', 'x'.repeat(100), 5, 'b', 'c', 'd', 'e', 'f']).length).toBe(5);
    expect(sanitizeSources(['Carrier\n\tName'])[0]).toBe('Carrier Name');
    expect(sanitizeSources('nope')).toEqual([]);
    expect(sanitizeSources(['x'.repeat(100)])[0]?.length).toBe(40);
  });
  it('validates E.164', () => {
    expect(isE164('+15125550123')).toBe(true);
    for (const s of ['15125550123', '+0123456789', '+1 512 555 0123', '', null, '+1234']) expect(isE164(s)).toBe(false);
  });
});

describe('severity and staleness', () => {
  it('ranks flagged > suspected/B/C > clean', () => {
    expect(severityOf({ spamLabel: 'flagged', attestation: 'A' })).toBe('action');
    expect(severityOf({ spamLabel: 'suspected', attestation: 'A' })).toBe('watch');
    expect(severityOf({ spamLabel: 'clean', attestation: 'B' })).toBe('watch');
    expect(severityOf({ spamLabel: 'clean', attestation: 'C' })).toBe('watch');
    expect(severityOf({ spamLabel: 'clean', attestation: 'A' })).toBe('ok');
    expect(severityOf({ spamLabel: 'clean', attestation: 'unknown' })).toBe('ok');
    expect(severityOf({ spamLabel: 'unknown', attestation: 'unknown' })).toBe('unknown');
  });
  it('flags results older than 36h; never-checked is not stale', () => {
    expect(isStale(hoursAgo(35), NOW)).toBe(false);
    expect(isStale(hoursAgo(37), NOW)).toBe(true);
    expect(isStale(null, NOW)).toBe(false);
  });
});

describe('remediation', () => {
  it('only emits known step ids, each of which the SQL shape check accepts', () => {
    for (const s of REMEDIATION_STEP_IDS) expect(s).toMatch(/^[a-z_]{3,40}$/);
    for (const label of SPAM_LABELS) for (const att of ATTESTATION_LEVELS) for (const live of [true, false]) {
      for (const s of buildRemediation({ spamLabel: label, attestation: att, providerLive: live })) expect(REMEDIATION_STEP_IDS).toContain(s);
    }
  });
  it('flagged numbers start with pausing bulk calling', () => {
    expect(buildRemediation({ spamLabel: 'flagged', attestation: 'A', providerLive: true })[0]).toBe('pause_outbound');
  });
  it('partial attestation adds the carrier-verification step, no duplicates', () => {
    const s = buildRemediation({ spamLabel: 'suspected', attestation: 'B', providerLive: true });
    expect(s).toContain('verify_attestation');
    expect(new Set(s).size).toBe(s.length);
  });
  it('with no provider, tells the owner to connect one rather than implying a clean result', () => {
    expect(buildRemediation({ spamLabel: 'unknown', attestation: 'unknown', providerLive: false })[0]).toBe('connect_provider');
  });
  it('a clean, fully signed number only needs monitoring', () => {
    expect(buildRemediation({ spamLabel: 'clean', attestation: 'A', providerLive: true })).toEqual(['keep_monitoring']);
  });
  it('counts progress and ignores unknown ids', () => {
    expect(remediationProgress(['pause_outbound', 'ask_relabel'], { pause_outbound: true, bogus: true })).toEqual({ done: 1, total: 2 });
    expect(remediationProgress(['ask_relabel'], null)).toEqual({ done: 0, total: 1 });
  });
});

describe('selectDue (polling schedule)', () => {
  const c = (id: string, e164: string, prev: HealthRowState | null): Candidate => ({ id, e164, prev });
  it('checks never-seen numbers first, then the longest-waiting', () => {
    const { due } = selectDue([c('b', '+15125550102', ok({ lastAttemptAt: hoursAgo(8) })), c('a', '+15125550101', null), c('d', '+15125550104', ok({ lastAttemptAt: hoursAgo(20) }))], NOW, false);
    expect(due.map((x) => x.id)).toEqual(['a', 'd', 'b']);
  });
  it('scheduled runs skip numbers attempted in the last 5 hours', () => {
    const r = selectDue([c('x', '+15125550101', ok({ lastAttemptAt: hoursAgo(SCHEDULED_RECHECK_HOURS - 0.1) })), c('y', '+15125550102', ok({ lastAttemptAt: hoursAgo(SCHEDULED_RECHECK_HOURS + 0.1) }))], NOW, false);
    expect(r.due.map((x) => x.id)).toEqual(['y']);
    expect(r.skippedRecent).toBe(1);
  });
  it('a manual check still obeys the 10 minute floor', () => {
    const recent = ok({ lastAttemptAt: new Date(NOW.getTime() - (MIN_RECHECK_MINUTES - 1) * 60_000) });
    const older = ok({ lastAttemptAt: new Date(NOW.getTime() - (MIN_RECHECK_MINUTES + 1) * 60_000) });
    expect(selectDue([c('x', '+15125550101', recent)], NOW, true).due).toEqual([]);
    expect(selectDue([c('x', '+15125550101', older)], NOW, true).due.length).toBe(1);
  });
  it('never sends an invalid number to a provider', () => {
    const r = selectDue([c('x', 'not-a-number', null)], NOW, false);
    expect(r.due).toEqual([]);
    expect(r.skippedInvalid).toBe(1);
  });
  it('chunks into provider-sized batches', () => {
    const items = Array.from({ length: BATCH_SIZE * 2 + 1 }, (_, i) => i);
    expect(chunk(items, BATCH_SIZE).map((g) => g.length)).toEqual([BATCH_SIZE, BATCH_SIZE, 1]);
  });
});

describe('applyOutcome', () => {
  const answer = (o: Partial<{ spamLabel: 'clean' | 'suspected' | 'flagged' | 'unknown'; attestation: 'A' | 'B' | 'C' | 'unknown' }> = {}) => ({ e164: '+15125550123', spamLabel: 'clean' as const, attestation: 'A' as const, labelSources: [], ...o });

  it('the first result is stored but is not reported as a change', () => {
    const r = applyOutcome(null, answer(), NOW);
    expect(r.changes).toEqual([]);
    expect(r.next).toMatchObject({ status: 'ok', spamLabel: 'clean', consecutiveFailures: 0, checkedAt: NOW });
  });
  it('records label and attestation transitions', () => {
    const r = applyOutcome(ok(), answer({ spamLabel: 'flagged', attestation: 'B' }), NOW);
    expect(r.changes).toEqual([{ kind: 'label_changed', from: 'clean', to: 'flagged' }, { kind: 'attestation_changed', from: 'A', to: 'B' }]);
  });
  it('records nothing when nothing changed', () => {
    expect(applyOutcome(ok(), answer(), NOW).changes).toEqual([]);
  });
  it('a provider failure keeps the last known label, bumps the counter and does not move checkedAt', () => {
    const prev = ok({ spamLabel: 'flagged', consecutiveFailures: 2 });
    const r = applyOutcome(prev, null, NOW);
    expect(r.next).toMatchObject({ spamLabel: 'flagged', status: 'error', consecutiveFailures: 3, lastAttemptAt: NOW });
    expect(r.next.checkedAt).toEqual(prev.checkedAt);
    expect(r.changes).toEqual([]);
  });
  it('a success after failures resets the counter', () => {
    expect(applyOutcome(ok({ status: 'error', consecutiveFailures: 4 }), answer(), NOW).next.consecutiveFailures).toBe(0);
  });
  it('a failure on a never-checked number stays unknown, not clean', () => {
    expect(applyOutcome(null, null, NOW).next).toMatchObject({ spamLabel: 'unknown', status: 'error', checkedAt: null });
  });
});

describe('indexResults', () => {
  it('ignores numbers that were not asked about, duplicates, and malformed values', () => {
    const m = indexResults(['+15125550123'], [
      { e164: '+19998887777', spamLabel: 'flagged', attestation: 'A', labelSources: [] },
      { e164: '+15125550123', spamLabel: 'bogus' as never, attestation: 'Z' as never, labelSources: ['<b>x</b>'] },
      { e164: '+15125550123', spamLabel: 'flagged', attestation: 'A', labelSources: [] },
    ]);
    expect([...m.keys()]).toEqual(['+15125550123']);
    expect(m.get('+15125550123')).toMatchObject({ spamLabel: 'unknown', attestation: 'unknown' });
  });
});

describe('viewOf (dashboard)', () => {
  const row = (o: Partial<NumberHealthRow> = {}): NumberHealthRow => ({ phone_number_id: 'n1', provider: 'stub', provider_live: false, spam_label: 'unknown', attestation: 'unknown', label_sources: [], status: 'never', checked_at: null, last_attempt_at: null, consecutive_failures: 0, last_error_code: null, remediation_done: {}, ...o });
  it('shows "unknown" with connect-provider guidance when there is no row at all', () => {
    const v = viewOf(null, NOW);
    expect(v.severity).toBe('unknown');
    expect(v.steps[0]).toBe('connect_provider');
  });
  it('computes severity, staleness and progress from a live row', () => {
    const v = viewOf(row({ provider: 'acme', provider_live: true, spam_label: 'flagged', status: 'ok', checked_at: hoursAgo(50).toISOString(), remediation_done: { pause_outbound: true } }), NOW);
    expect(v).toMatchObject({ severity: 'action', stale: true });
    expect(v.progress).toEqual({ done: 1, total: v.steps.length });
  });
});

describe('i18n', () => {
  const keys = (o: unknown, p = ''): string[] => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k)) : [p]);
  it('English and Persian have identical keys (numberHealth)', () => expect(keys(fa).sort()).toEqual(keys(en).sort()));
  it('English and Persian have identical keys (safetyHeat)', () => expect(keys(faHeat).sort()).toEqual(keys(enHeat).sort()));
  it('every remediation step has a title and detail in both languages', () => {
    for (const s of REMEDIATION_STEP_IDS) for (const l of [en, fa] as const) {
      const step = (l.steps as Record<string, { title?: string; detail?: string }>)[s];
      expect(step?.title).toBeTruthy();
      expect(step?.detail).toBeTruthy();
    }
  });
  it('the heat copy makes no medical claim', () => {
    const all = JSON.stringify(enHeat);
    expect(all).not.toMatch(/diagnos|heat stroke|prevent|treat|cure|safe to work/i);
  });
});
