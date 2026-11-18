import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EVENT_REGISTRY,
  PII_PROPERTY_NAME_RE,
  isEventName,
  looksLikePii,
  sanitizePageUrl,
  clampPageTitle,
  sanitizeEvent,
  validateRegistry,
  type EventDef,
  type EventProblem,
} from '@/lib/analyticsEvents';
import { buildConversionEvents } from '@/lib/thankYou';
// @ts-ignore -- plain .mjs shared with scripts/check-analytics-registry.mjs (no type declarations)
import { eventsInPlan, scanAnalyticsCalls } from '../../scripts/lib/analyticsScan.mjs';

const ROOT = join(__dirname, '..', '..');
const scan = (files: Record<string, string>): string[] =>
  scanAnalyticsCalls({ root: ROOT, registry: EVENT_REGISTRY, piiNameRe: PII_PROPERTY_NAME_RE, files }).errors;

describe('registry', () => {
  it('is structurally valid', () => {
    expect(validateRegistry()).toEqual([]);
  });

  it('every event has an owner, a description, and only pii:false properties', () => {
    for (const [name, def] of Object.entries(EVENT_REGISTRY) as [string, EventDef][]) {
      expect(def.owner, name).toBeTruthy();
      expect(def.pii, name).toBe(false);
      for (const [k, p] of Object.entries(def.properties)) expect(p.pii, `${name}.${k}`).toBe(false);
    }
  });

  it('rejects a registry with PII properties, a bad name or a pii:true flag', () => {
    const bad = {
      Bad_Name: { owner: 'growth', description: 'x', pii: false, properties: {} },
      lead_created: {
        owner: 'growth',
        description: 'x',
        pii: false,
        properties: {
          email: { type: 'string', optional: false, pii: false, note: 'n' },
          customer_id: { type: 'string', optional: false, pii: false, note: 'n' },
          ok_prop: { type: 'string', optional: false, pii: true, note: 'n' },
        },
      },
    } as unknown as Record<string, EventDef>;
    const errors = validateRegistry(bad).join('\n');
    expect(errors).toMatch(/Bad_Name: event name must match/);
    expect(errors).toMatch(/lead_created\.email: property name looks like PII/);
    expect(errors).toMatch(/lead_created\.customer_id: property name looks like PII/);
    expect(errors).toMatch(/lead_created\.ok_prop: pii must be false/);
  });

  it('PII name pattern catches common personal-data names but not the registered ones', () => {
    for (const n of ['email', 'user_email', 'phone_number', 'first_name', 'query', 'search_text', 'user_id', 'transcript', 'ip']) {
      expect(PII_PROPERTY_NAME_RE.test(n), n).toBe(true);
    }
    for (const n of ['tour_id', 'step_id', 'post_slug', 'variant_id', 'experiment_id', 'ttfc_bucket', 'range_days']) {
      expect(PII_PROPERTY_NAME_RE.test(n), n).toBe(false);
    }
  });
});

describe('sanitizeEvent (runtime guard)', () => {
  it('drops unregistered events', () => {
    const problems: EventProblem[] = [];
    expect(sanitizeEvent('made_up_event', {}, problems)).toBeNull();
    expect(problems[0].detail).toMatch(/not in the registry/);
    expect(isEventName('toString')).toBe(false); // prototype keys are not events
  });

  it('keeps registered, correctly typed parameters', () => {
    expect(sanitizeEvent('csv_exported', { granularity: 'day', range_days: 30 })?.params).toEqual({ granularity: 'day', range_days: 30 });
  });

  it('strips unregistered, mistyped and PII-looking parameters but still sends the event', () => {
    const problems: EventProblem[] = [];
    const e = sanitizeEvent(
      'blog_share',
      { post_slug: 'ok', channel: 'jane@example.com', email: 'a@b.co', extra: 1 },
      problems,
    );
    expect(e?.params).toEqual({ post_slug: 'ok' });
    expect(problems.map((p) => p.detail).join('|')).toMatch(/"channel" looks like personal data/);
    expect(problems.map((p) => p.detail).join('|')).toMatch(/"email" is not registered/);
    expect(problems.map((p) => p.detail).join('|')).toMatch(/"extra" is not registered/);
  });

  it('rejects wrong types, NaN and prototype-key properties; reports missing required ones', () => {
    const problems: EventProblem[] = [];
    const e = sanitizeEvent('csv_exported', { granularity: 5, range_days: Number.NaN, constructor: 'x' }, problems);
    expect(e?.params).toEqual({});
    const text = problems.map((p) => p.detail).join('|');
    expect(text).toMatch(/"granularity" must be a finite string/);
    expect(text).toMatch(/"range_days" must be a finite number/);
    expect(text).toMatch(/"constructor" is not registered/);
    expect(text).toMatch(/required property "granularity" is missing/);
  });

  it('flags emails, phone-like numbers, JWTs and over-long strings', () => {
    expect(looksLikePii('a@b.co')).toBe(true);
    expect(looksLikePii('+1 (415) 555-0100')).toBe(true);
    expect(looksLikePii('eyJhbGciOi.eyJzdWIi.sig_abc')).toBe(true);
    expect(looksLikePii('x'.repeat(101))).toBe(true);
    expect(looksLikePii('blog-post-slug-2026')).toBe(false);
    expect(looksLikePii('day')).toBe(false);
  });
});

describe('static call-site scan', () => {
  const file = (body: string) => ({ 'src/example.ts': `import { trackEvent } from '@/lib/analytics';\n${body}\n` });

  it('accepts registered events with registered properties', () => {
    expect(scan(file(`trackEvent('palette_open');\ntrackEvent('csv_exported', { granularity: g, range_days: d });`))).toEqual([]);
    expect(scan(file(`trackEvent(a ? 'tour_completed' : 'tour_skipped', { tour_id: t, version: 1, step_index: 0, step_count: 3 });`))).toEqual([]);
  });

  it('fails on an unregistered event name', () => {
    expect(scan(file(`trackEvent('totally_new');`))).toEqual([expect.stringMatching(/event "totally_new" is not in the registry/)]);
  });

  it('fails on an unregistered property and on PII-looking keys', () => {
    const e = scan(file(`trackEvent('blog_share', { post_slug: s, channel: c, email: e, user_id });`)).join('\n');
    expect(e).toMatch(/property "email" looks like PII/);
    expect(e).toMatch(/property "user_id" looks like PII/);
    expect(e).toMatch(/property "email" is not registered for "blog_share"/);
  });

  it('fails on dynamic names unless annotated, and on spread or computed keys', () => {
    expect(scan(file(`trackEvent(name);`)).join()).toMatch(/not statically verifiable/);
    expect(scan(file(`// analytics-events: palette_open, tips_reset\ntrackEvent(name);`))).toEqual([]);
    expect(scan(file(`// analytics-events: nope\ntrackEvent(name);`)).join()).toMatch(/"nope" is not in the registry/);
    expect(scan(file(`trackEvent('blog_share', { ...rest });`)).join()).toMatch(/cannot be verified/);
    expect(scan(file(`trackEvent('blog_share', { [k]: 1 });`)).join()).toMatch(/cannot be verified/);
  });

  it('fails on uncalled references unless they declare their events', () => {
    expect(scan(file(`const t = trackEvent;`)).join()).toMatch(/passed around uncalled/);
    expect(scan(file(`run({ track: trackRegisteredEvent });`)).join()).toMatch(/passed around uncalled/);
    expect(scan(file(`// analytics-events: sign_up, generate_lead\nrun({ track: trackRegisteredEvent });`))).toEqual([]);
    expect(scan(file(`// analytics-events: nope\nrun({ track: trackRegisteredEvent });`)).join()).toMatch(/"nope" is not in the registry/);
    expect(scan(file(`analytics.trackEvent('palette_open');`))).toEqual([]);
  });

  it('fails on raw gtag events, ignores test files', () => {
    expect(scan(file(`window.gtag('event', 'x', {});`)).join()).toMatch(/raw gtag/);
    expect(scan({ 'src/example.test.ts': `trackEvent('totally_new');` })).toEqual([]);
  });

  it('the real source tree has no unregistered events or PII properties', () => {
    const result = scanAnalyticsCalls({ root: ROOT, registry: EVENT_REGISTRY, piiNameRe: PII_PROPERTY_NAME_RE });
    expect(result.errors).toEqual([]);
    expect(result.callCount).toBeGreaterThan(10);
  });
});

describe('page_view URL hygiene', () => {
  const O = 'https://app.vireek.com';
  it('drops the hash and every non-utm query parameter', () => {
    const r = sanitizePageUrl('/dashboard/jobs?email=jane%40example.com&token=abc&utm_source=newsletter&utm_medium=email#frag', O);
    expect(r).toEqual({ page_path: '/dashboard/jobs?utm_source=newsletter&utm_medium=email', page_location: `${O}/dashboard/jobs?utm_source=newsletter&utm_medium=email` });
  });
  it('keeps clean paths untouched and omits the "?" when nothing survives', () => {
    expect(sanitizePageUrl('/pricing', O).page_path).toBe('/pricing');
    expect(sanitizePageUrl('/pricing?foo=1', O).page_path).toBe('/pricing');
    expect(sanitizePageUrl('/', O)).toEqual({ page_path: '/', page_location: `${O}/` });
  });
  it('drops utm values that look like personal data', () => {
    expect(sanitizePageUrl('/x?utm_campaign=jane@example.com&utm_source=ok', O).page_path).toBe('/x?utm_source=ok');
    expect(sanitizePageUrl(`/x?utm_term=${'a'.repeat(101)}`, O).page_path).toBe('/x');
  });
  it('redacts email and JWT path segments, including percent-encoded ones', () => {
    expect(sanitizePageUrl('/unsubscribe/jane%40example.com/confirm', O).page_path).toBe('/unsubscribe/:redacted/confirm');
    expect(sanitizePageUrl('/verify/eyJhbGciOi.eyJzdWIi.sig_abc', O).page_path).toBe('/verify/:redacted');
  });
  it('does not throw on malformed input and clamps long titles', () => {
    expect(() => sanitizePageUrl('/%E0%A4%A?x=%zz', O)).not.toThrow();
    expect(clampPageTitle('t'.repeat(150))).toHaveLength(100);
    expect(clampPageTitle('short')).toBe('short');
  });
});

describe('plan and conversion wiring', () => {
  it('docs/analytics/tracking-plan.md lists exactly the registered events', () => {
    const plan = eventsInPlan(readFileSync(join(ROOT, 'docs/analytics/tracking-plan.md'), 'utf8')) as Set<string>;
    expect([...plan].sort()).toEqual(Object.keys(EVENT_REGISTRY).sort());
  });

  it('every conversion event built for /thank-you is registered with registered properties', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    const events = [
      ...buildConversionEvents('signup', null, now),
      ...buildConversionEvents('demo', new Date('2026-10-11T12:00:00Z'), now),
      ...buildConversionEvents('demo', null, now),
    ];
    for (const e of events) {
      const problems: EventProblem[] = [];
      expect(sanitizeEvent(e.name, e.params, problems), e.name).not.toBeNull();
      expect(problems, e.name).toEqual([]);
    }
  });
});
