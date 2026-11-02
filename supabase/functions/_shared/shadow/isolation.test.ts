// Static guarantees for Shadow Mode (no outbound speech / side effects, no ROI leakage, DB write lockdown).
// These read source files; they do not execute edge functions. Run from the repo root.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = process.cwd();
const read = (p: string) => readFileSync(`${root}/${p}`, 'utf8');
const SHADOW_NO_SIDE_EFFECT_FILES = [
  'supabase/functions/_shared/shadow/logic.ts',
  'supabase/functions/_shared/shadow/runtime.ts',
  'supabase/functions/_shared/shadow/report.ts',
  'supabase/functions/shadow-replay/index.ts',
  'supabase/functions/shadow-report/index.ts',
];
const FORBIDDEN_IMPORT = /(notify\/deliver|\/dispatch\/|\/booking\/|vapi|\/pbx\/|twilio|sms-send|email-send|outbound|dialer|call-bridge|live-calls|\/pci\/|speed-to-lead|followup|rich-send|whatsapp|messenger)/i;
const importsOf = (src: string) => [...src.matchAll(/(?:import|from)\s*(?:[^'"]*?\s)?["']([^"']+)["']/g)].map((m) => m[1]);

describe('shadow functions have no outbound / side-effect capability', () => {
  for (const f of SHADOW_NO_SIDE_EFFECT_FILES) {
    it(`${f} imports no messaging, telephony, booking or dispatch module`, () => {
      const bad = importsOf(read(f)).filter((i) => FORBIDDEN_IMPORT.test(i));
      expect(bad).toEqual([]);
    });
    it(`${f} makes no direct network calls to messaging providers`, () => {
      expect(read(f)).not.toMatch(/api\.twilio\.com|api\.resend\.com|api\.vapi\.ai/);
    });
  }
  it('only shadow_* tables are ever written; every other table is read-only (select)', () => {
    for (const f of SHADOW_NO_SIDE_EFFECT_FILES) {
      const src = read(f);
      for (const m of src.matchAll(/\.from\(\s*["']([a-z_]+)["']\s*\)\s*\.(select|insert|update|upsert|delete)/g)) {
        const [, table, op] = m;
        if (!table.startsWith('shadow_')) expect(`${f}:${table}:${op}`).toBe(`${f}:${table}:select`);
      }
    }
  });
  it('shadow-digest only emails the account owner via Resend and imports no telephony/SMS module', () => {
    const src = read('supabase/functions/shadow-digest/index.ts');
    expect(importsOf(src).filter((i) => FORBIDDEN_IMPORT.test(i))).toEqual([]);
    expect(src).not.toMatch(/twilio|sendSms|vapi/i);
    expect(src).toContain('profiles'); // recipient comes from the owner's profile row
    expect(src).not.toMatch(/caller_phone|from_number/);
  });
  it('every edge function that mutates state requires auth (cron secret or user JWT)', () => {
    expect(read('supabase/functions/shadow-replay/index.ts')).toMatch(/timingSafeEqualStr/);
    expect(read('supabase/functions/shadow-replay/index.ts')).toMatch(/auth\.getUser\(\)/);
    expect(read('supabase/functions/shadow-digest/index.ts')).toMatch(/timingSafeEqualStr/);
    expect(read('supabase/functions/shadow-report/index.ts')).toMatch(/auth\.getUser\(\)/);
  });
});

describe('shadow numbers never reach ROI surfaces', () => {
  const roiDirs = ['supabase/functions/money-recovered-run', 'supabase/functions/_shared/money-recovered', 'supabase/functions/_shared/value-scoreboard', 'supabase/functions/value-scoreboard-run'];
  const walk = (d: string): string[] => !existsSync(`${root}/${d}`) ? [] : readdirSync(`${root}/${d}`, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
  it('no ROI / value-scoreboard / money-recovered source references shadow_ tables', () => {
    const files = [...roiDirs.flatMap(walk), 'src/lib/valueScoreboard.ts'].filter((f) => existsSync(`${root}/${f}`) && /\.(ts|tsx)$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(read(f)).not.toMatch(/shadow_(cards|trials|reports|reviews|events)/);
  });
});

describe('shadow migration lockdown', () => {
  const sql = read('supabase/migrations/20280410000000_shadow_mode.sql');
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(shadow_[a-z_]+)/g)].map((m) => m[1]);
  it('creates the five shadow tables and enables RLS on each', () => {
    expect(tables.sort()).toEqual(['shadow_cards', 'shadow_events', 'shadow_reports', 'shadow_reviews', 'shadow_trials']);
    for (const t of tables) expect(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`).test(sql)).toBe(true);
  });
  it('grants authenticated SELECT only and defines no write policies', () => {
    expect(sql).not.toMatch(/CREATE POLICY[^;]*FOR\s+(INSERT|UPDATE|DELETE|ALL)/i);
    expect(sql).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE|ALL)[^;]*TO\s+authenticated/i);
  });
  it('DB-level CHECK forbids an executed would-be action', () => {
    expect(sql).toContain("NOT (actions @> '[{\"executed\": true}]'::jsonb)");
  });
  it('retention purge is not callable by end users', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.shadow_purge_expired\(\) FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.shadow_purge_expired\(\) TO service_role/);
  });
  it('every SECURITY DEFINER function pins search_path', () => {
    const defs = sql.split(/CREATE OR REPLACE FUNCTION/).slice(1);
    for (const d of defs) if (/SECURITY DEFINER/.test(d)) expect(d).toMatch(/SET search_path = public/);
  });
  it('contains no destructive statements', () => {
    expect(sql).not.toMatch(/\b(DROP TABLE|DROP COLUMN|TRUNCATE|ALTER COLUMN[^;]*TYPE)\b/i);
  });
});
