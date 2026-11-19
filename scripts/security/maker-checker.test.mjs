import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sql = fs.readFileSync(path.join(ROOT, "supabase/migrations/20290306000000_maker_checker.sql"), "utf8");
const code = sql.replace(/--.*$/gm, "");

describe("maker-checker migration (static)", () => {
  it("is idempotent: every table, policy and trigger is re-runnable", () => {
    for (const m of code.matchAll(/CREATE TABLE (?!IF NOT EXISTS)/g)) throw new Error(`CREATE TABLE without IF NOT EXISTS at ${m.index}`);
    const policies = [...code.matchAll(/CREATE POLICY (\w+) ON ([\w.]+)/g)];
    expect(policies.length).toBeGreaterThan(0);
    for (const [, name, table] of policies) expect(code).toContain(`DROP POLICY IF EXISTS ${name} ON ${table}`);
    const triggers = [...code.matchAll(/CREATE TRIGGER (\w+)\s+(?:BEFORE|AFTER)[^;]*?ON ([\w.]+)/g)];
    expect(triggers.length).toBe(5);
    for (const [, name, table] of triggers) expect(code).toContain(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
  });

  it("guards every approval table in the inventory", () => {
    for (const t of ["workflow_approvals", "compiled_workflow_approvals", "closeout_steps", "commercial_approval_decisions"]) {
      expect(code).toMatch(new RegExp(`CREATE TRIGGER \\w+[\\s\\S]*?ON public\\.${t}\\b`));
    }
  });

  it("is non-destructive and keeps every SECURITY DEFINER function pinned and revoked from clients", () => {
    expect(code).not.toMatch(/DROP (TABLE|COLUMN|SCHEMA)|TRUNCATE|DELETE FROM/i);
    const defs = [...code.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(([^)]*)\)[\s\S]*?\$\$;/g)];
    expect(defs.length).toBe(6);
    for (const [body, name] of defs) {
      if (/SECURITY DEFINER/.test(body)) expect(body).toMatch(/SET search_path = public, pg_temp/);
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated`));
    }
  });

  it("never exempts an unknown amount or a risky approval from the threshold", () => {
    expect(code).toMatch(/NOT COALESCE\(p_risky, false\) AND p_amount_cents IS NOT NULL AND p_amount_cents < v_threshold/);
  });

  it("limits the solo exception to the tenant owner when no other active member exists", () => {
    expect(code).toMatch(/v_solo AND p_approver = p_tenant AND NOT public\.maker_checker_has_other_member/);
  });
});
