import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Static contract checks on the payroll-connectors migration. They can't execute SQL, but they pin
 * the invariants that protect payroll money: nothing is exported twice, clients have no direct write
 * path, tokens stay server-side, and Vireek's own pay runs cannot silently re-pay an exported row.
 */
const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20271210000000_payroll_provider_connectors.sql'), 'utf8');
const code = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');

const TABLES = [
  'payroll_connection_secrets',
  'payroll_connections',
  'payroll_employee_links',
  'payroll_export_events',
  'payroll_export_lines',
  'payroll_export_sources',
  'payroll_exports',
];

describe('payroll connectors migration contract', () => {
  it('enables RLS on every table it creates', () => {
    const tables = [...code.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map((m) => m[1]);
    expect([...tables].sort()).toEqual(TABLES);
    for (const t of tables) expect(code).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`));
  });

  it('gives clients no direct write path to any table', () => {
    expect(code).not.toMatch(/CREATE POLICY[^;]*FOR (ALL|INSERT|UPDATE|DELETE)/i);
    expect(code).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE|ALL)[^;]*TO\s+(anon|authenticated)/i);
    for (const t of TABLES) expect(code).toMatch(new RegExp(`REVOKE ALL ON [^;]*public\\.${t}\\b[^;]*FROM anon, authenticated`));
  });

  it('keeps provider tokens and export sources unreadable by clients', () => {
    expect(code).not.toMatch(/CREATE POLICY[^;]* ON public\.payroll_connection_secrets/);
    expect(code).not.toMatch(/CREATE POLICY[^;]* ON public\.payroll_export_sources/);
    expect(code).not.toMatch(/GRANT[^;]*payroll_connection_secrets[^;]*TO/);
    expect(code).not.toMatch(/GRANT[^;]*payroll_export_sources[^;]*TO/);
  });

  it('allows a source row in at most one active export', () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_export_sources_active\s+ON public\.payroll_export_sources \(source_type, source_id\) WHERE active/);
  });

  it('makes export creation idempotent', () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_exports_idempotency/);
    expect(code).toMatch(/pg_advisory_xact_lock/);
  });

  it('declares every SECURITY DEFINER function with a pinned search_path', () => {
    const defs = code.split(/CREATE OR REPLACE FUNCTION/).slice(1).filter((d) => /SECURITY DEFINER/.test(d.split(/\$\$/)[0]));
    expect(defs.length).toBeGreaterThan(12);
    for (const d of defs) expect(d.split(/\$\$/)[0]).toMatch(/SET search_path = public/);
  });

  it('keeps internal helpers away from clients', () => {
    for (const fn of ['_require_payroll_connector_access', '_payroll_export_guard_pay_run', '_payroll_clean_settings', '_payroll_check_period', '_payroll_export_compute']) {
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`));
    }
  });

  it('gates every client RPC on the connector access check', () => {
    for (const fn of ['save_payroll_connection', 'get_payroll_mapping', 'set_payroll_employee_link', 'set_payroll_employee_links', 'get_payroll_export_preview', 'create_payroll_export', 'record_payroll_export_download', 'mark_payroll_export_submitted', 'void_payroll_export', 'get_payroll_export_detail']) {
      const body = code.split(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`))[1]?.split(/\$\$;/)[0] ?? '';
      expect(body, fn).toMatch(/_require_payroll_connector_access\(\)/);
    }
  });

  it('blocks a Vireek pay run from re-paying exported hours, commissions and tips', () => {
    for (const t of ['timesheets', 'commission_records', 'tips']) {
      expect(code).toMatch(new RegExp(`CREATE TRIGGER trg_payroll_export_guard BEFORE UPDATE OF pay_run_item_id ON public\\.${t}`));
    }
    const guard = code.split('CREATE OR REPLACE FUNCTION public._payroll_export_guard_pay_run(')[1]?.split(/\$\$;/)[0] ?? '';
    expect(guard).toMatch(/PAYROLL_EXPORT_LOCK/);
  });

  it('requires a download before submit and an acknowledgement to void a delivered export', () => {
    const submit = code.split('CREATE OR REPLACE FUNCTION public.mark_payroll_export_submitted(')[1]?.split(/\$\$;/)[0] ?? '';
    expect(submit).toMatch(/DOWNLOAD_REQUIRED/);
    const voidFn = code.split('CREATE OR REPLACE FUNCTION public.void_payroll_export(')[1]?.split(/\$\$;/)[0] ?? '';
    expect(voidFn).toMatch(/ACK_REQUIRED/);
  });

  it('exposes only authenticated execute on client RPCs', () => {
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.create_payroll_export\(text, date, date, text, text\) TO authenticated/);
    expect(code).not.toMatch(/GRANT EXECUTE[^;]*TO\s+anon/i);
  });
});
