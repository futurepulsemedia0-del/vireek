import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  LIVE_SESSION_MAX_SECONDS, NANP_UNLISTED_CLEARANCE,
  assertOneWayForkTwiml, buildOneWayForkTwiml, consentSnapshot, evaluateLiveListenGate, last4,
  sessionPurgeAfter, shouldContinueStreaming, type LiveGateInput,
} from './liveListen.ts';
import type { ConsentConfig } from './logic.ts';

const NOW = '2026-11-19T12:00:00.000Z';
const OK_CONSENT: ConsentConfig = {
  replayAttested: true, callerDisclosureConfigured: true, staffNotified: true, telephonySupportsFork: true,
  counselClearedStates: ['CA', NANP_UNLISTED_CLEARANCE],
};
const CA_NUMBER = '+14155550123';   // 415 -> CA (all-party heuristic list)
const OTHER_NUMBER = '+12145550123'; // 214 -> not on the list
const base = (over: Partial<LiveGateInput> = {}): LiveGateInput => ({
  killSwitchStopped: false, flagOn: true,
  trial: { status: 'active', endsAt: '2026-11-25T00:00:00.000Z' },
  nowIso: NOW, direction: 'inbound', callerPhone: CA_NUMBER, consent: OK_CONSENT, ...over,
});

describe('live-listen gate', () => {
  it('allows only when every condition holds, and records the jurisdiction', () => {
    expect(evaluateLiveListenGate(base())).toMatchObject({ allowed: true, reason: 'ok', jurisdiction: 'CA' });
    expect(evaluateLiveListenGate(base({ callerPhone: OTHER_NUMBER }))).toMatchObject({ allowed: true, jurisdiction: NANP_UNLISTED_CLEARANCE });
  });

  it('is OFF when the flag is off (the shipped default)', () => {
    expect(evaluateLiveListenGate(base({ flagOn: false }))).toMatchObject({ allowed: false, reason: 'flag_off' });
  });

  it('a stopped kill switch wins over everything, even a fully consented call', () => {
    expect(evaluateLiveListenGate(base({ killSwitchStopped: true }))).toMatchObject({ allowed: false, reason: 'kill_switch' });
    expect(evaluateLiveListenGate(base({ killSwitchStopped: true, flagOn: false }))).toMatchObject({ reason: 'kill_switch' });
  });

  it('requires an active, unexpired trial', () => {
    expect(evaluateLiveListenGate(base({ trial: null })).reason).toBe('trial_inactive');
    expect(evaluateLiveListenGate(base({ trial: { status: 'cancelled', endsAt: '2026-11-25T00:00:00Z' } })).reason).toBe('trial_inactive');
    expect(evaluateLiveListenGate(base({ trial: { status: 'active', endsAt: NOW } })).reason).toBe('trial_expired');
    expect(evaluateLiveListenGate(base({ trial: { status: 'active', endsAt: 'garbage' } })).reason).toBe('trial_expired');
    expect(evaluateLiveListenGate(base({ nowIso: 'garbage' })).reason).toBe('trial_expired');
  });

  it('never listens to outbound calls', () => {
    expect(evaluateLiveListenGate(base({ direction: 'outbound' })).reason).toBe('outbound_unsupported');
  });

  it.each([
    ['replayAttested', 'replay_not_attested'],
    ['callerDisclosureConfigured', 'disclosure_missing'],
    ['staffNotified', 'staff_not_notified'],
    ['telephonySupportsFork', 'fork_unsupported'],
  ] as const)('blocks when %s is false', (key, reason) => {
    const d = evaluateLiveListenGate(base({ consent: { ...OK_CONSENT, [key]: false } }));
    expect(d).toMatchObject({ allowed: false, reason });
  });

  it('blocks an all-party state that counsel has not cleared (fail closed) and flags legal review', () => {
    const d = evaluateLiveListenGate(base({ consent: { ...OK_CONSENT, counselClearedStates: [NANP_UNLISTED_CLEARANCE] } }));
    expect(d).toMatchObject({ allowed: false, reason: 'all_party_state_not_cleared', needsLegalReview: true });
  });

  it('blocks NANP numbers outside the all-party list unless the platform cleared NANP_UNLISTED', () => {
    const d = evaluateLiveListenGate(base({ callerPhone: OTHER_NUMBER, consent: { ...OK_CONSENT, counselClearedStates: ['CA'] } }));
    expect(d).toMatchObject({ allowed: false, reason: 'nanp_unlisted_not_cleared' });
  });

  it('blocks unknown jurisdiction: missing, short and non-NANP numbers', () => {
    for (const phone of [null, '', '123', '+442071234567']) {
      expect(evaluateLiveListenGate(base({ callerPhone: phone })).reason).toBe('jurisdiction_unknown');
    }
  });

  it('the clearance marker alone never authorizes a non-NANP number', () => {
    const d = evaluateLiveListenGate(base({ callerPhone: '+442071234567', consent: { ...OK_CONSENT, counselClearedStates: [NANP_UNLISTED_CLEARANCE, 'CA'] } }));
    expect(d.allowed).toBe(false);
  });

  it('is deterministic', () => {
    expect(evaluateLiveListenGate(base())).toEqual(evaluateLiveListenGate(base()));
  });
});

describe('ledger helpers', () => {
  it('stores booleans only, and the last 4 digits only', () => {
    expect(consentSnapshot(OK_CONSENT)).toEqual({
      replay_attested: true, caller_disclosure_configured: true, staff_notified: true, telephony_supports_fork: true,
    });
    expect(last4('+1 (415) 555-0123')).toBe('0123');
    expect(last4('12')).toBeNull();
    expect(last4(null)).toBeNull();
  });
  it('clamps retention to 1..90 days', () => {
    const t = '2026-11-19T00:00:00.000Z';
    expect(sessionPurgeAfter(t, 30)).toBe('2026-12-19T00:00:00.000Z');
    expect(sessionPurgeAfter(t, 0)).toBe('2026-11-20T00:00:00.000Z');
    expect(sessionPurgeAfter(t, 9999)).toBe('2027-02-17T00:00:00.000Z');
    expect(() => sessionPurgeAfter('nope', 30)).toThrow();
  });
});

describe('open-stream rule', () => {
  it('stops on kill switch, flag off, max duration and bad clocks', () => {
    expect(shouldContinueStreaming({ killSwitchStopped: false, flagOn: true, elapsedSeconds: 10 })).toEqual({ continue: true, reason: 'ok' });
    expect(shouldContinueStreaming({ killSwitchStopped: true, flagOn: true, elapsedSeconds: 10 }).reason).toBe('kill_switch');
    expect(shouldContinueStreaming({ killSwitchStopped: false, flagOn: false, elapsedSeconds: 10 }).reason).toBe('flag_off');
    expect(shouldContinueStreaming({ killSwitchStopped: false, flagOn: true, elapsedSeconds: LIVE_SESSION_MAX_SECONDS }).reason).toBe('max_duration');
    expect(shouldContinueStreaming({ killSwitchStopped: false, flagOn: true, elapsedSeconds: -1 }).reason).toBe('bad_clock');
    expect(shouldContinueStreaming({ killSwitchStopped: false, flagOn: true, elapsedSeconds: NaN }).continue).toBe(false);
  });
});

describe('one-way fork directive', () => {
  const sid = '123e4567-e89b-12d3-a456-426614174000';
  const opts = { streamUrl: 'wss://live.example.com/shadow', allowedHosts: ['live.example.com'], sessionId: sid };

  it('is unidirectional and inbound-only', () => {
    const xml = buildOneWayForkTwiml(opts);
    expect(xml).toContain('<Start><Stream');
    expect(xml).toContain('track="inbound_track"');
    expect(xml).not.toMatch(/<Connect|<Say|<Play|<Dial|outbound_track|both_tracks/);
    expect(() => assertOneWayForkTwiml(xml)).not.toThrow();
  });

  it('rejects insecure, credentialed, query-carrying and non-allow-listed receivers', () => {
    expect(() => buildOneWayForkTwiml({ ...opts, streamUrl: 'ws://live.example.com/x' })).toThrow();
    expect(() => buildOneWayForkTwiml({ ...opts, streamUrl: 'wss://u:p@live.example.com/x' })).toThrow();
    expect(() => buildOneWayForkTwiml({ ...opts, streamUrl: 'wss://live.example.com/x?token=1' })).toThrow();
    expect(() => buildOneWayForkTwiml({ ...opts, streamUrl: 'wss://evil.example.net/x' })).toThrow();
    expect(() => buildOneWayForkTwiml({ ...opts, streamUrl: 'not a url' })).toThrow();
    expect(() => buildOneWayForkTwiml({ ...opts, allowedHosts: [] })).toThrow();
    expect(() => buildOneWayForkTwiml({ ...opts, sessionId: '"><Say>hi</Say>' })).toThrow();
  });

  it('the asserter refuses anything that could speak, act or send audio back', () => {
    const good = buildOneWayForkTwiml(opts);
    const bad = [
      good.replace('inbound_track', 'both_tracks'),
      good.replace('inbound_track', 'outbound_track'),
      good.replace('<Start>', '<Connect>').replace('</Start>', '</Connect>'),
      `${good}<Say>hello</Say>`,
      `<Response>${good}</Response>`,
      good.replace('wss://', 'ws://'),
      good.replace('</Stream>', '<Play>x</Play></Stream>'),
    ];
    for (const x of bad) expect(() => assertOneWayForkTwiml(x)).toThrow();
  });
});

describe('static guarantees', () => {
  const root = process.cwd();
  const read = (p: string) => readFileSync(`${root}/${p}`, 'utf8');
  const FILES = ['supabase/functions/_shared/shadow/liveListen.ts', 'supabase/functions/shadow-live-authorize/index.ts'];
  const FORBIDDEN_IMPORT = /(notify\/deliver|\/dispatch\/|\/booking\/|vapi|\/pbx\/|twilio|sms-send|email-send|outbound|dialer|call-bridge|live-calls|speed-to-lead|followup|rich-send|whatsapp|messenger)/i;
  const importsOf = (src: string) => [...src.matchAll(/(?:import|from)\s*(?:[^'"]*?\s)?["']([^"']+)["']/g)].map((m) => m[1]);

  for (const f of FILES) {
    it(`${f} imports no messaging, telephony, booking or dispatch module`, () => {
      expect(importsOf(read(f)).filter((i) => FORBIDDEN_IMPORT.test(i))).toEqual([]);
    });
  }

  it('the edge function is secret-protected, fails closed without a strong secret, and checks flag/kill switch before reading tenant data', () => {
    const src = read('supabase/functions/shadow-live-authorize/index.ts');
    expect(src).toMatch(/timingSafeEqualStr/);
    expect(src).toMatch(/expected\.length < 24/);
    expect(src.indexOf('isStopped(LIVE_KILL_SWITCH')).toBeGreaterThan(0);
    expect(src.indexOf('isStopped(LIVE_KILL_SWITCH')).toBeLessThan(src.indexOf('.from("shadow_trials")'));
    expect(src).not.toMatch(/console\.(log|info|debug)/); // no phone numbers in logs
  });

  it('the migration is default-off, service-role-only for writes, and keeps trials in replay mode', () => {
    const sql = read('supabase/migrations/20290307000000_shadow_live_listen.sql');
    expect(sql).toMatch(/'shadow_live_listen'[\s\S]{0,500}false, 0, 'critical'/);
    expect(sql).toMatch(/GRANT SELECT ON public\.shadow_live_sessions, public\.shadow_live_events TO authenticated/);
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO authenticated/);
    expect(sql).toMatch(/shadow_live_sessions_consent_gate/);
    expect(sql).not.toMatch(/ALTER TABLE public\.shadow_trials/);
    const code = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
    expect(code).not.toMatch(/\bDROP TABLE\b/i); // rollback lives in comments only
  });
});
