import { describe, it, expect } from 'vitest';
import { parseThankYouParams, buildConversionEvents, sendConversionOnce, type ConversionDeps } from './thankYou';

const NOW = new Date('2026-10-08T12:00:00Z');

describe('parseThankYouParams', () => {
  it('accepts known sources and rejects everything else', () => {
    expect(parseThankYouParams('?source=signup', NOW).source).toBe('signup');
    expect(parseThankYouParams('?source=demo', NOW).source).toBe('demo');
    expect(parseThankYouParams('?source=<script>', NOW).source).toBeNull();
    expect(parseThankYouParams('', NOW).source).toBeNull();
  });

  it('only honours a sane demo start date', () => {
    const ok = parseThankYouParams('?source=demo&start=2026-10-10T15:00:00.000Z', NOW);
    expect(ok.demoStart?.toISOString()).toBe('2026-10-10T15:00:00.000Z');
    expect(parseThankYouParams('?source=demo&start=garbage', NOW).demoStart).toBeNull();
    expect(parseThankYouParams('?source=demo&start=2020-01-01T00:00:00Z', NOW).demoStart).toBeNull();
    expect(parseThankYouParams('?source=demo&start=2030-01-01T00:00:00Z', NOW).demoStart).toBeNull();
    expect(parseThankYouParams('?source=signup&start=2026-10-10T15:00:00Z', NOW).demoStart).toBeNull();
  });
});

describe('buildConversionEvents', () => {
  it('maps signup and demo to the right GA4 events', () => {
    expect(buildConversionEvents('signup', null, NOW).map((e) => e.name)).toEqual(['sign_up', 'generate_lead']);
    const demo = buildConversionEvents('demo', new Date('2026-10-11T12:00:00Z'), NOW);
    expect(demo.map((e) => e.name)).toEqual(['demo_booked', 'generate_lead']);
    expect(demo[0].params).toEqual({ days_until_demo: 3 });
    expect(demo[1].params).toEqual({ lead_source: 'demo' });
    expect(buildConversionEvents('demo', null, NOW)[0].params).toEqual({});
  });
});

function makeDeps(consent: boolean, store: Record<string, string> = {}) {
  const sent: string[] = [];
  let listener: (() => void) | null = null;
  const deps: ConversionDeps = {
    track: (name) => void sent.push(name),
    hasConsent: () => consent,
    onConsent: (cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    storage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => void (store[k] = v) },
  };
  return { deps, sent, grant: () => listener?.(), hasListener: () => listener !== null, store };
}

describe('sendConversionOnce', () => {
  it('fires immediately when consent exists, and only once per session', () => {
    const t = makeDeps(true);
    sendConversionOnce('signup', null, t.deps);
    expect(t.sent).toEqual(['sign_up', 'generate_lead']);
    sendConversionOnce('signup', null, t.deps);
    expect(t.sent.length).toBe(2);
  });

  it('waits for consent, then fires exactly once', () => {
    const t = makeDeps(false);
    sendConversionOnce('demo', null, t.deps);
    expect(t.sent).toEqual([]);
    t.grant();
    t.grant();
    expect(t.sent).toEqual(['demo_booked', 'generate_lead']);
  });

  it('cleanup unsubscribes a pending listener', () => {
    const t = makeDeps(false);
    const stop = sendConversionOnce('signup', null, t.deps);
    expect(t.hasListener()).toBe(true);
    stop();
    expect(t.hasListener()).toBe(false);
  });

  it('survives blocked storage', () => {
    const t = makeDeps(true);
    t.deps.storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    sendConversionOnce('signup', null, t.deps);
    expect(t.sent.length).toBe(2);
  });
});
