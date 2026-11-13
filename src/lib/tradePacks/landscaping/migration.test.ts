/**
 * Static inspection of the landscaping migration (no database needed). It proves structural security properties
 * and TS↔SQL parity; it does NOT replace running supabase/tests/database/landscaping_pack.test.sql.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { RULE_LABELS } from './weather.ts';
import { MAX_INTERVAL_WEEKS, MAX_SEASONS } from './recurrence.ts';

const SQL = readFileSync(new URL('../../../../supabase/migrations/20290301000000_landscaping_pack.sql', import.meta.url), 'utf8');
const code = SQL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

const tables = [...code.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map((m) => m[1]);
const functions = [...code.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]);

/** Function bodies by name (text from CREATE to the closing `$$;`). */
function bodyOf(name: string): string {
  const start = code.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = code.indexOf('$$;', code.indexOf('$$', start) + 2);
  return code.slice(start, end + 3);
}

describe('landscaping migration: structure', () => {
  it('creates the expected tables', () => {
    expect(tables.length).toBeGreaterThanOrEqual(14);
    expect(tables).toContain('landscape_visits');
    expect(tables).toContain('account_entitlements');
  });
  it('enables row level security on every table it creates', () => {
    for (const t of tables) {
      const explicit = new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`).test(code);
      const inLoop = new RegExp(`'${t}'`).test(code.slice(code.indexOf('6. ROW LEVEL SECURITY') === -1 ? 0 : code.indexOf("ROW LEVEL SECURITY (every policy")));
      expect(explicit || inLoop).toBe(true);
    }
  });
  it('every SECURITY DEFINER function pins search_path', () => {
    for (const f of functions) {
      const b = bodyOf(f);
      if (/SECURITY DEFINER/.test(b)) expect(/SET search_path\s*=\s*public/.test(b)).toBe(true);
    }
  });
  it('every public/private RPC revokes PUBLIC access and nothing is granted to anon', () => {
    for (const f of functions.filter((n) => !/^_landscape_(month_in_window|valid_|observed|holiday_name|season_interval)/.test(n))) {
      expect(new RegExp(`REVOKE ALL ON FUNCTION[^;]*\\bpublic\\.${f}\\(`).test(code)).toBe(true);
    }
    expect(/GRANT[^;]*TO[^;]*\banon\b/.test(code)).toBe(false);
  });
  it('service-only functions are not granted to authenticated', () => {
    for (const f of ['landscape_plan_visits', '_landscape_generate_contract', 'landscape_cron_tick', 'landscape_apply_weather_decision', 'landscape_visits_for_weather', 'landscape_record_snow_event_for', '_landscape_place_job']) {
      const grants = [...code.matchAll(/GRANT EXECUTE ON FUNCTION[^;]*;/g)].map((m) => m[0]).filter((g) => g.includes(`public.${f}(`));
      for (const g of grants) expect(/\bTO service_role;$/.test(g)).toBe(true);
    }
  });
  it('every tenant-callable RPC goes through the flag + entitlement gate', () => {
    for (const f of ['landscape_generate_my_visits', 'landscape_pause_contract', 'landscape_resume_contract', 'landscape_cancel_pause', 'landscape_reorder_day', 'landscape_reassign_visits', 'landscape_skip_for_weather', 'landscape_record_snow_event', 'landscape_start_visit', 'landscape_set_task', 'landscape_skip_visit', 'landscape_complete_visit', 'landscape_run_billing']) {
      expect(bodyOf(f)).toMatch(/_landscape_require\(/);
    }
  });
  it('config and billing RPCs require the manage permission', () => {
    for (const f of ['landscape_pause_contract', 'landscape_resume_contract', 'landscape_cancel_pause', 'landscape_run_billing']) {
      expect(bodyOf(f)).toMatch(/_landscape_require\(true\)/);
    }
  });
  it('the flag is seeded OFF and rollback notes list every table', () => {
    expect(SQL).toMatch(/'landscaping_pack'[\s\S]{0,400}false,\s*0\)/);
    for (const t of tables) expect(SQL.slice(0, SQL.indexOf('CREATE EXTENSION'))).toContain(t);
  });
  it('idempotency keys exist as unique constraints/indexes', () => {
    expect(code).toMatch(/UNIQUE \(contract_id, period\)/);
    expect(code).toMatch(/uq_landscape_visit_occurrence[\s\S]{0,120}\(contract_id, occurrence_n\)/);
    expect(code).toMatch(/uq_landscape_visit_addon_event[\s\S]{0,140}\(contract_id, addon_id, event_key\)/);
    expect(code).toMatch(/uq_landscape_visit_makeup/);
  });
  it('audit tables are append-only', () => {
    for (const t of ['account_entitlement_events', 'landscape_contract_events', 'landscape_route_changes']) {
      expect(code).toMatch(new RegExp(`BEFORE UPDATE OR DELETE ON public\\.${t}`));
    }
  });
});

describe('landscaping migration: TS ↔ SQL parity', () => {
  it('weather rule kinds match', () => {
    const sqlKinds = [...bodyOf('_landscape_valid_weather_policy').matchAll(/'(rain_prob_pct|rain_mm|snow_cm|wind_kph|freeze_c|heat_c|alert_keyword)'/g)].map((m) => m[1]);
    expect([...new Set(sqlKinds)].sort()).toEqual(Object.keys(RULE_LABELS).sort());
  });
  it('season limits match', () => {
    expect(bodyOf('_landscape_valid_seasons')).toContain(`NOT BETWEEN 1 AND ${MAX_SEASONS}`);
    expect(bodyOf('_landscape_valid_seasons')).toContain(`NOT BETWEEN 1 AND ${MAX_INTERVAL_WEEKS}`);
  });
  it('holiday set is the same six holidays', () => {
    for (const n of ["New Year", 'Memorial Day', 'Independence Day', 'Labor Day', 'Thanksgiving', 'Christmas Day']) expect(bodyOf('_landscape_holiday_name')).toContain(n);
  });
});
