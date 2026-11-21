// Drift guards between the client, the edge functions, the SQL and the locale files.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIAL_DAYS } from './trial';

const root = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function flatten(o: Record<string, unknown>, p = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flatten(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]));
}

describe('plan step agreement', () => {
  it('client TRIAL_DAYS equals the server TRIAL_DAYS', () => {
    const m = read('supabase/functions/_shared/billing/trialLifecycle.ts').match(/export const TRIAL_DAYS = (\d+)/);
    expect(Number(m?.[1])).toBe(TRIAL_DAYS);
  });
  it('fa locale has exactly the same keys as en', () => {
    const en = JSON.parse(read('src/locales/en/planStep.json'));
    const fa = JSON.parse(read('src/locales/fa/planStep.json'));
    expect(flatten(fa).sort()).toEqual(flatten(en).sort());
  });
  it('every translation key used by the page exists in en', () => {
    const en = new Set(flatten(JSON.parse(read('src/locales/en/planStep.json'))));
    const src = read('src/pages/onboarding/PlanStepPage.tsx') + read('src/components/onboarding/PlanResumeBanner.tsx');
    const used = [...src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
    const missing = used.filter((k) => !en.has(k));
    expect(missing).toEqual([]);
  });
  it('the SQL step values match the client step union', () => {
    const sql = read('supabase/migrations/20290307000000_plan_onboarding.sql');
    for (const s of ['plan', 'checkout', 'done', 'skipped', 'sales']) expect(sql).toContain(`'${s}'`);
  });
  it('the dashboard route wraps the page in PlanStepGate outside QualificationGate', () => {
    const app = read('src/App.tsx');
    expect(app).toMatch(/<PlanStepGate>\s*<QualificationGate>/);
    expect(app).toContain('path="/onboarding/plan"');
  });
});
