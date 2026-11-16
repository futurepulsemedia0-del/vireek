// Drift guard: cogs_plan_catalog() in the COGS migration is a SQL mirror of CATALOG_PLANS (pricingCatalog.ts).
// If a price, included-minutes or overage value changes in the catalog, this test fails until the SQL is updated.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CATALOG_PLANS } from './pricingCatalog.ts';

const sql = readFileSync(new URL('../../../migrations/20290305000100_cogs_margin_views.sql', import.meta.url), 'utf8');
const literal = /SELECT '(\{.*\})'::jsonb/.exec(sql)?.[1];

describe('cogs_plan_catalog() SQL mirror (20290305000100_cogs_margin_views.sql)', () => {
  it('has a JSON literal', () => {
    expect(literal).toBeTruthy();
  });
  it('equals CATALOG_PLANS for price, minutes, overage and quoted flag', () => {
    const parsed = JSON.parse(literal as string);
    const expected = Object.fromEntries(CATALOG_PLANS.map((p) => [p.id, {
      monthlyCents: p.monthlyCents, minutesIncluded: p.minutesIncluded, overageCentsPerMin: p.overageCentsPerMin, quoted: p.quoted,
    }]));
    expect(parsed).toEqual(expected);
  });
});

describe('COGS migration safety', () => {
  it('is idempotent, has a rollback note and no client grants on the views', () => {
    expect(sql).toMatch(/^-- rollback:/m);
    expect(sql).not.toMatch(/\bCREATE VIEW\b(?!.*OR REPLACE)/);
    expect(sql).toMatch(/REVOKE ALL ON public\.cogs_tenant_plan_v[\s\S]*FROM PUBLIC, anon, authenticated/);
    expect(sql).not.toMatch(/GRANT SELECT ON[^;]*TO authenticated/);
  });
  it('gates every staff RPC through the staff check', () => {
    expect(sql).toMatch(/is_vireek_staff\(auth\.uid\(\)\)/);
    for (const fn of ['staff_cogs_by_plan', 'staff_cogs_tenants', 'staff_cogs_ai_actions']) {
      expect(sql).toMatch(new RegExp(`FUNCTION public\\.${fn}\\([^)]*\\)[\\s\\S]*?cogs_assert_staff_month`));
    }
  });
});
