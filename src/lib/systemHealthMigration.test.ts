import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20271001000000_system_health_snapshot.sql'),
  'utf8',
);

describe('get_system_health_snapshot migration', () => {
  it('is tenant-scoped, read-only and not callable by anon/public', () => {
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path = public/);
    expect(sql).toMatch(/v_owner uuid := public\.get_account_owner_id\(\)/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_system_health_snapshot\(\) FROM PUBLIC/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_system_health_snapshot\(\) TO authenticated/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s/i);
  });

  it('scopes every table read to the account owner', () => {
    const reads = sql.match(/FROM (\w+) \w+\s+WHERE[^;]*/g) ?? [];
    expect(reads.length).toBeGreaterThanOrEqual(8);
    for (const r of reads) expect(r).toContain('v_owner');
  });
});
