import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const raw = readFileSync(join(process.cwd(), 'supabase/migrations/20290308000000_learn_completions.sql'), 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

describe('learn completions SQL', () => {
  it('is additive and idempotent', () => {
    expect(code).not.toMatch(/\bdrop\s+(table|column|schema|type|function)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).toContain('CREATE TABLE IF NOT EXISTS public.learn_module_completions');
    for (const m of code.matchAll(/CREATE POLICY "([^"]+)" ON ([\w.]+)/g)) expect(code).toContain(`DROP POLICY IF EXISTS "${m[1]}" ON ${m[2]}`);
  });
  it('has RLS, no delete policy, and a tamper-proof insert check', () => {
    expect(code).toContain('ALTER TABLE public.learn_module_completions ENABLE ROW LEVEL SECURITY');
    expect(code).not.toMatch(/FOR DELETE/);
    const ins = code.match(/CREATE POLICY "insert_own_learn_completions"[\s\S]*?;/)?.[0] ?? '';
    expect(ins).toContain('user_id = auth.uid()');
    expect(ins).toContain('account_owner_id = public.get_account_owner_id()');
  });
  it('learners read only their rows; the owner reads the account', () => {
    const sel = code.match(/CREATE POLICY "select_learn_completions"[\s\S]*?;/)?.[0] ?? '';
    expect(sel).toContain('user_id = auth.uid() OR account_owner_id = auth.uid()');
  });
  it('record function enforces login and pass mark, and is not callable by anon', () => {
    const fn = code.match(/CREATE OR REPLACE FUNCTION public\.record_learn_completion[\s\S]*?\$\$;/)?.[0] ?? '';
    expect(fn).toContain('SECURITY INVOKER');
    expect(fn).toContain('auth.uid() IS NULL');
    expect(fn).toContain('p_score_pct < 80');
    expect(code).toContain('REVOKE ALL ON FUNCTION public.record_learn_completion(text, text, integer) FROM PUBLIC, anon');
  });
  it('team summary is SECURITY DEFINER with pinned search_path and an owner-only guard', () => {
    const fn = code.match(/CREATE OR REPLACE FUNCTION public\.learn_team_completion_summary[\s\S]*?\$\$;/)?.[0] ?? '';
    expect(fn).toContain('SECURITY DEFINER');
    expect(fn).toContain('SET search_path = public');
    expect(fn).toContain('auth.uid() <> v_owner');
    expect(fn).toContain('c.account_owner_id = v_owner');
    expect(code).toContain('REVOKE ALL ON FUNCTION public.learn_team_completion_summary() FROM PUBLIC, anon');
  });
});
