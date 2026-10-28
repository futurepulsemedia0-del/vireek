import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
const read = (f: string) => strip(readFileSync(resolve(process.cwd(), 'supabase/migrations', f), 'utf8'));
const base = read('20271201000000_tool_crib.sql');
const link = read('20280101000000_tool_crib_vehicle_link.sql');

describe('tool crib double check-out protection', () => {
  it('keeps the one-open-loan unique index', () => {
    expect(base).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_crib_loans_one_open\s+ON tool_crib_loans \(tool_id\) WHERE status = 'out'/);
  });
  it('locks the tool row and rejects non-available tools in the new check-out', () => {
    expect(link).toMatch(/FROM tool_crib_items i[\s\S]*?FOR UPDATE/);
    expect(link).toContain("'This tool is already checked out'");
  });
});

describe('tool crib vehicle link migration', () => {
  it('drops the old 5-arg overload before creating the new signature', () => {
    const drop = link.indexOf('DROP FUNCTION IF EXISTS public.check_out_crib_tool(uuid, uuid, integer, text, text);');
    const create = link.indexOf('CREATE OR REPLACE FUNCTION public.check_out_crib_tool(');
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
    expect(link).toContain('p_vehicle_id uuid DEFAULT NULL');
  });
  it('only accepts an active vehicle from the same account', () => {
    expect(link).toMatch(/v\.id = p_vehicle_id AND v\.user_id = v_owner AND v\.status <> 'retired'/);
  });
  it('pins search_path on every SECURITY DEFINER function and grants only authenticated', () => {
    const defs = link.match(/SECURITY DEFINER/g)?.length ?? 0;
    expect(defs).toBe(2);
    expect(link.match(/SET search_path = public/g)?.length).toBe(defs);
    expect(link).toMatch(/GRANT EXECUTE ON FUNCTION public\.check_out_crib_tool\(uuid, uuid, integer, text, text, uuid\) TO authenticated/);
    expect(link).toMatch(/REVOKE ALL ON FUNCTION public\.check_out_crib_tool\(uuid, uuid, integer, text, text, uuid\) FROM PUBLIC, anon/);
  });
});
