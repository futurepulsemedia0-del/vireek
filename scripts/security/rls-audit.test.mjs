import { describe, expect, it } from "vitest";
import { gateRls, lint, renderPgtap, replay, splitStatements, stripSql, unwrappedAuthCalls } from "./rls-audit.mjs";

const run = (...sqls) => replay(sqls.map((sql, i) => ({ name: `${i}.sql`, sql })));

describe("sql helpers", () => {
  it("strips comments but not string contents; splits outside dollar quotes", () => {
    expect(stripSql("select '--x'; -- c\n/* b */ select 2")).toContain("'--x'");
    const parts = splitStatements("create function f() returns int as $$ select 1; select 2; $$ language sql; select 3");
    expect(parts).toHaveLength(2);
  });
});

describe("replay", () => {
  it("tracks RLS enable/disable, policies, drops and renames", () => {
    const t = run(
      "create table public.a (id uuid primary key, user_id uuid not null); alter table a enable row level security;",
      "create policy p1 on a for select to authenticated using (user_id = (select auth.uid()));",
      "create table b (id int); create table c (id int); alter table c enable row level security; drop policy if exists nothing on c;",
      "alter table c rename to d; drop table b;",
    );
    expect([...t.keys()].sort()).toEqual(["a", "d"]);
    expect(t.get("a").rls).toBe(true);
    expect(t.get("a").policies.get("p1").cmd).toBe("select");
    expect(t.get("a").indexed.has("id")).toBe(true);
  });
  it("expands DO-loop idioms (FOREACH … EXECUTE format) for RLS and policies", () => {
    const t = run(
      "create table x1 (user_id uuid); create table x2 (user_id uuid);",
      `do $$ declare t text; begin foreach t in array array['x1','x2'] loop
         execute format('alter table %I enable row level security', t);
         execute format('create policy "select_own_%1$s" on %1$I for select to authenticated using (user_id = (select auth.uid()))', t);
       end loop; end $$;`,
    );
    for (const n of ["x1", "x2"]) { expect(t.get(n).rls).toBe(true); expect(t.get(n).policies.size).toBe(1); }
  });
  it("ignores auth/storage schema tables", () => {
    expect(run("create table auth.users (id uuid); create table storage.objects (id uuid);").size).toBe(0);
  });
});

describe("unwrappedAuthCalls", () => {
  it("flags bare calls, accepts (select …) wrappers incl. schema prefix", () => {
    expect(unwrappedAuthCalls("user_id = auth.uid()")).toEqual(["auth.uid"]);
    expect(unwrappedAuthCalls("user_id = (select auth.uid())")).toEqual([]);
    expect(unwrappedAuthCalls("user_id = (SELECT public.get_account_owner_id())")).toEqual([]);
    expect(unwrappedAuthCalls("user_id = public.get_account_owner_id()")).toEqual(["get_account_owner_id"]);
  });
});

describe("lint + gate", () => {
  const tables = run(
    "create table open_t (id int, user_id uuid); create table svc (id int); alter table svc enable row level security;",
    "create table leaky (id int, user_id uuid); alter table leaky enable row level security; create policy p on leaky for select to authenticated using (true);",
    "create table slow (id int, user_id uuid); alter table slow enable row level security; create policy p on slow for all to authenticated using (user_id = auth.uid());",
  );
  const f = lint(tables);
  const rules = (t) => f.filter((x) => x.table === t).map((x) => x.rule).sort();
  it("reports missing RLS, service-role-only, permissive-true, unwrapped auth and unindexed policy columns", () => {
    expect(rules("open_t")).toContain("no-rls");
    expect(rules("svc")).toEqual(["rls-no-policy"]);
    expect(rules("leaky")).toContain("policy-true");
    expect(rules("slow")).toEqual(expect.arrayContaining(["policy-unwrapped-auth", "policy-column-unindexed"]));
  });
  it("gate fails on NEW findings, tolerates frozen ones, demands baseline shrinkage", () => {
    const frozen = { findings: f.map((x) => ({ table: x.table, rule: x.rule })) };
    expect(gateRls(f, frozen)).toEqual([]);
    expect(gateRls(f, { findings: [] }).length).toBe(f.length);
    expect(gateRls([], frozen).join("\n")).toMatch(/is fixed/);
  });
});

describe("generated pgTAP", () => {
  it("embeds the frozen exemptions, never claims unseedable tables as proven", () => {
    const sql = renderPgtap({ findings: [{ table: "legacy_t", rule: "no-rls" }, { table: "svc_t", rule: "rls-no-policy" }] });
    expect(sql).toContain("'legacy_t'");
    expect(sql).toContain("'svc_t'");
    expect(sql).toContain("skip(1,");
    expect(sql).toContain("tenant A cannot SELECT tenant B rows");
    expect(sql.trim().endsWith("rollback;")).toBe(true);
  });
});
