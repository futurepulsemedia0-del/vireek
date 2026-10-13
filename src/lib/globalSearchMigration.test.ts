import { describe, it, expect } from 'vitest';
import sql from '../../supabase/migrations/20270402000000_global_search.sql?raw';

/**
 * Contract tests for the Cmd+K migration. They cannot run Postgres, but they
 * pin the security-critical properties so a future edit cannot silently
 * weaken them (leaking another account's rows, exposing invoices, etc.).
 */
const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.global_search(');
const fnEnd = sql.indexOf('$$;', sql.indexOf('END;', fnStart));
const fn = sql.slice(fnStart, fnEnd);

describe('global_search migration', () => {
  it('defines the RPC as SECURITY INVOKER so RLS keeps applying', () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(fn).toContain('SECURITY INVOKER');
    expect(fn).not.toContain('SECURITY DEFINER');
  });

  it('refuses anonymous callers and clamps the limit', () => {
    expect(fn).toContain('auth.uid() IS NULL');
    expect(fn).toMatch(/least\(greatest\(coalesce\(p_limit, 24\), 1\), 50\)/);
    expect(fn).toContain('left(lower(btrim(');
  });

  it('scopes every searched table to the account owner', () => {
    for (const alias of ['c.user_id', 'j.user_id', 'q.user_id', 'i.user_id', 'e.user_id', 'k.user_id', 'l.user_id', 'ca.user_id']) {
      expect(fn).toContain(`${alias} = v_owner`);
    }
    expect(fn).toContain('t.account_owner_id = v_owner');
  });

  it('only returns invoices to users who can view billing', () => {
    expect(fn).toContain('w_invoice AND v_billing');
    expect(sql).toMatch(/FUNCTION public\.search_can_view_billing\(\)[\s\S]*SECURITY DEFINER/);
  });

  it('escapes LIKE wildcards in user input', () => {
    expect(fn).toContain(`replace(replace(replace(v_q, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`);
  });

  it('never returns archived knowledge articles', () => {
    expect(fn).toContain("k.status <> 'archived'");
  });

  it('creates trigram indexes for each searched table and a full-text index for knowledge', () => {
    for (const table of ['customers', 'jobs', 'quotes', 'invoices', 'equipment', 'team_members', 'knowledge_articles', 'leads', 'calls']) {
      expect(sql).toMatch(new RegExp(`ON ${table} USING gin \\(`));
    }
    expect(sql).toContain('gin_trgm_ops');
    expect(sql).toContain("to_tsvector('simple'");
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  });

  it('grants execute to signed-in users only', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.global_search(text, text[], integer) FROM PUBLIC, anon');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.global_search(text, text[], integer) TO authenticated');
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.global_search[^;]*TO (anon|PUBLIC)/);
  });
});
