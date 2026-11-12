// Guards the single source of truth for plan pricing (src/lib/pricing.ts) against its
// hand-kept mirrors, and blocks stale price / "Free plan" claims in customer-facing files.
// If this fails: update the mirror (or the copy) — do not delete the guard.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PRICING_PLANS } from './pricing';
import { parsePlanMinutes, parseOverageRate } from './planChange';
import { FREE_MINUTES_INCLUDED, minutesForPlan } from '../../supabase/functions/_shared/billing/planCatalog';
import { FREE_MINUTES, PLAN_PRICE_CENTS } from '../../supabase/functions/_shared/fraud/planLimits';
import { PLAN_MONTHLY_CENTS } from '../../supabase/functions/_shared/value-scoreboard/engine';

const ROOT = path.resolve(__dirname, '..', '..');

describe('plan prices: pricing.ts == backend mirrors', () => {
  for (const p of PRICING_PLANS) {
    if (p.monthly === null) continue; // Enterprise = custom
    it(`${p.id}: fraud PLAN_PRICE_CENTS and scoreboard PLAN_MONTHLY_CENTS match`, () => {
      expect(PLAN_PRICE_CENTS[p.id]).toBe(p.monthly! * 100);
      expect(PLAN_MONTHLY_CENTS[p.id]).toBe(p.monthly! * 100);
    });
    if (p.monthly! > 0) {
      it(`${p.id}: annual price is exactly 10 months (2 months free)`, () => {
        expect(p.annual).toBe(p.monthly! * 10);
      });
    }
  }
  it('Enterprise is priced "from" and has no self-serve monthly price', () => {
    const e = PRICING_PLANS.find((p) => p.id === 'enterprise')!;
    expect(e.monthly).toBeNull();
    expect(e.startingAt).toBe(1799);
  });
});

describe('included minutes: pricing.ts == planCatalog / planLimits', () => {
  for (const id of ['free', 'starter', 'professional', 'business'] as const) {
    it(`${id}: minutesForPlan equals the advertised minutes`, () => {
      const plan = PRICING_PLANS.find((p) => p.id === id)!;
      expect(minutesForPlan(id)).toBe(parsePlanMinutes(plan.minutes));
    });
  }
  it('Trial minutes agree everywhere', () => {
    expect(FREE_MINUTES).toBe(FREE_MINUTES_INCLUDED);
    expect(FREE_MINUTES).toBe(60);
  });
  it('overage rates: paid plans $0.25/min, Enterprise $0.20/min, Trial none', () => {
    const rate = (id: string) => parseOverageRate(PRICING_PLANS.find((p) => p.id === id)!.overage);
    expect(rate('free')).toBeNull();
    expect(rate('starter')).toBe(0.25);
    expect(rate('professional')).toBe(0.25);
    expect(rate('business')).toBe(0.25);
    expect(rate('enterprise')).toBe(0.2);
  });
});

describe('marketing feature lists', () => {
  it('keeps the "Everything in X" chain in order', () => {
    const names = PRICING_PLANS.map((p) => p.name);
    PRICING_PLANS.slice(1).forEach((p, i) => {
      expect(p.features[0]).toBe(`Everything in ${names[i]}`);
    });
  });
  it('does not advertise capabilities that are not enforced in code', () => {
    const all = PRICING_PLANS.flatMap((p) => p.features).join('\n');
    // Seat/SMS/retention/support-SLA/per-location-voice terms have no implementation yet.
    for (const banned of [/extra seat/i, /extra location/i, /SMS\/month/i, /call recordings/i, /retention/i, /\(24h\)/, /\(4h\)/, /per location/i]) {
      expect(all).not.toMatch(banned);
    }
  });
});

// ---- stale-claim scan over customer-facing sources ---------------------------------------------
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'locales') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.|\.generated\./.test(name)) out.push(full);
  }
  return out;
}

const STALE: Array<[RegExp, string]> = [
  [/\$(79|199|399|999)\b(?!\s*(tune-up|install))/, 'old plan price'],
  [/\b(400|4,000) (min|minutes)\b/i, 'old included minutes'],
  [/Free plan (needs|requires|with)/i, '"Free plan" marketing claim'],
  [/\bNo card required\b/, '"No card required" claim'],
];
// Contractor-facing example text and legal/operational copy that is not a Vireek plan claim.
const ALLOW = [/directmail[\\/]/, /SignupPage\.tsx$/, /RefundPolicyContent\.tsx$/];

describe('no stale Vireek plan claims in customer-facing sources', () => {
  const files = [
    ...walk(path.join(ROOT, 'src')),
    ...walk(path.join(ROOT, 'supabase', 'functions', '_shared', 'ai-core')),
    path.join(ROOT, 'public', 'llms-full.txt'),
    path.join(ROOT, 'public', 'llms.txt'),
    path.join(ROOT, 'index.html'),
  ];
  it('finds none', () => {
    const hits: string[] = [];
    for (const f of files) {
      if (ALLOW.some((a) => a.test(f))) continue;
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const [re, why] of STALE) if (re.test(line)) hits.push(`${path.relative(ROOT, f)}:${i + 1} (${why})`);
      });
    }
    expect(hits).toEqual([]);
  });
});
