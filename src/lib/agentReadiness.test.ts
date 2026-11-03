import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/locales/en/agentReadiness.json';
import { RULE_IDS, RULES } from '../../supabase/functions/_shared/agent-readiness/rules';
import { coveragePct, ringOffset, scoreTone, SUBSCORE_ORDER } from '@/lib/agentReadinessCore';

const engineSrc = readFileSync(resolve(process.cwd(), 'supabase/functions/_shared/agent-readiness/engine.ts'), 'utf8');
const get = (path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);

describe('agentReadiness i18n completeness', () => {
  it('has title, why and fix for every rule', () => {
    for (const id of RULE_IDS) for (const f of ['title', 'why', 'fix']) expect(get(`rules.${id}.${f}`), `${id}.${f}`).toBeTypeOf('string');
  });
  it('has a string for every evidence key the engine can emit', () => {
    // `k:` values may be ternaries ({ k: ok ? 'a' : 'b' }), so collect every quoted literal inside each k expression.
    const exprs = [...engineSrc.matchAll(/\bk: ([^}]*?)(?:, p:|\s*\})/g)].map((m) => m[1]);
    const keys = [...new Set(exprs.flatMap((e) => [...e.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1])))];
    expect(keys.length).toBeGreaterThan(40);
    for (const k of keys) expect(get(`evidence.${k}`), `evidence.${k}`).toBeTypeOf('string');
  });
  it('has strings for every fix key, note, subscore and status', () => {
    const fixKeys = [...engineSrc.matchAll(/key: '([a-z_]+)', kind:/g)].map((m) => m[1]);
    expect(fixKeys.length).toBeGreaterThanOrEqual(6);
    for (const k of [...fixKeys, 'gbp_manual_checks']) { expect(get(`fixes.${k}.title`), k).toBeTypeOf('string'); expect(get(`fixes.${k}.desc`), k).toBeTypeOf('string'); }
    const notes = [...engineSrc.matchAll(/'((?:templated_draft|currency_assumed|address_incomplete|hours_missing|hours_conflict|holidays_missing|emergency_flag_missing|services_below_8))'/g)].map((m) => m[1]);
    for (const n of notes) expect(get(`notes.${n}`), n).toBeTypeOf('string');
    for (const s of SUBSCORE_ORDER) expect(get(`subscores.${s}`), s).toBeTypeOf('string');
    for (const s of ['pass', 'partial', 'fail', 'not_measured']) expect(get(`status.${s}`), s).toBeTypeOf('string');
  });
  it('has an error string for every failure code the server can return', () => {
    for (const c of ['empty', 'too_long', 'bad_url', 'bad_scheme', 'credentials', 'bad_port', 'ip_literal', 'blocked_host', 'blocked_address', 'robots', 'timeout', 'network', 'http_error', 'redirect', 'not_html', 'rate_limited', 'unavailable', 'not_configured', 'bad_request', 'forbidden', 'unauthorized', 'no_business_profile', 'no_website', 'unknown'])
      expect(get(`errors.${c}`), c).toBeTypeOf('string');
  });
  it('every rule cites an official source and flags changeable ones', () => {
    for (const id of RULE_IDS) expect(RULES[id].source.startsWith('https://')).toBe(true);
    expect(RULES.site_jsonld_faq.mayChange).toBe(true);
  });
});

describe('score helpers', () => {
  it('maps tone and clamps the ring', () => {
    expect(scoreTone(90)).toBe('good'); expect(scoreTone(60)).toBe('ok'); expect(scoreTone(10)).toBe('poor'); expect(scoreTone(null)).toBe('poor');
    expect(ringOffset(100, 100)).toBe(0); expect(ringOffset(0, 100)).toBe(100); expect(ringOffset(250, 100)).toBe(0); expect(ringOffset(null, 100)).toBe(100);
    expect(coveragePct(0.456)).toBe(46); expect(coveragePct(5)).toBe(100);
  });
});
