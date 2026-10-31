// @vitest-environment node
// Static contract test: every value estimate-recovery-agent writes to revenue_recovery_events must be allowed by the
// LATEST CHECK constraints in supabase/migrations. The function ignores upsert errors (see index.test.ts), so a value
// missing from a constraint would make that detector fail silently in production.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const agent = read('supabase/functions/estimate-recovery-agent/index.ts');

function constraintValues(file: string, name: string): string[] {
  const sql = read(`supabase/migrations/${file}`).split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  const at = sql.lastIndexOf(`ADD CONSTRAINT ${name}`);
  if (at < 0) throw new Error(`${name} not found in ${file}`);
  const block = sql.slice(at, sql.indexOf(';', at));
  return [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const sourceTypes = constraintValues('20261126000000_revenue_leakage_auditor_gaps.sql', 'revenue_recovery_events_source_type_check');
const sourceTables = constraintValues('20261105000000_membership_lifecycle_os.sql', 'revenue_recovery_events_source_table_check');
const valueBases = constraintValues('20261105000000_membership_lifecycle_os.sql', 'revenue_recovery_events_estimated_value_basis_check');

describe('estimate-recovery-agent ↔ revenue_recovery_events constraints', () => {
  it('parses non-empty constraint lists', () => {
    expect(sourceTypes.length).toBeGreaterThan(10);
    expect(sourceTables.length).toBeGreaterThan(3);
    expect(valueBases.length).toBeGreaterThan(5);
  });

  it('the latest source_type constraint is the one that includes the agent\'s newest detectors', () => {
    expect(sourceTypes).toEqual(expect.arrayContaining(['job_parts_unbilled', 'payment_failed']));
  });

  it('every source_type the agent writes is allowed', () => {
    const used = [...agent.matchAll(/source_type:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(used.length).toBe(6);
    for (const v of used) expect(sourceTypes, v).toContain(v);
  });

  it('every source_table the agent writes is allowed', () => {
    const used = [...agent.matchAll(/source_table:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(used.length).toBe(6);
    for (const v of used) expect(sourceTables, v).toContain(v);
  });

  it('every estimated_value_basis the agent writes is allowed', () => {
    const used = [...agent.matchAll(/estimated_value_basis:\s*(?:"([a-z_]+)"|valueCents > 0 \? "([a-z_]+)" : "([a-z_]+)")/g)].flatMap((m) => m.slice(1).filter(Boolean));
    expect(used.length).toBeGreaterThanOrEqual(6);
    for (const v of used) expect(valueBases, v).toContain(v);
  });

  it('the idempotency key used by the upsert (source_table,source_id) is the table\'s UNIQUE constraint', () => {
    const ddl = read('supabase/migrations/20260922000000_missed_revenue_recovery_ledger.sql');
    expect(ddl).toMatch(/UNIQUE \(source_table, source_id\)/);
    expect(agent).toContain('onConflict: "source_table,source_id"');
  });
});
