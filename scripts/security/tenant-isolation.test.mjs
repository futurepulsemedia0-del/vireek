import { describe, expect, it } from "vitest";
import { replay } from "./rls-audit.mjs";
import { anonByDesign, classify, enumerationOracles, gate, parseSchemaFacts, renderGuestPgtap, summarize } from "./tenant-isolation.mjs";

const files = (...sqls) => sqls.map((sql, i) => ({ name: `${i}.sql`, sql }));
const build = (...sqls) => {
  const f = files(...sqls);
  return { tables: replay(f), facts: parseSchemaFacts(f) };
};

describe("parseSchemaFacts", () => {
  it("tracks required columns, defaults, later ALTERs and global UNIQUE sets", () => {
    const { facts } = build(
      "create table public.a (id uuid primary key default gen_random_uuid(), user_id uuid not null, name text not null, note text, code text unique, created_at timestamptz not null default now(), unique (user_id, name));",
      "alter table a add column kind text not null; alter table a alter column name set default 'x';",
    );
    const f = facts.get("a");
    expect([...f.required].sort()).toEqual(["kind", "user_id"]);
    expect(f.uniques).toEqual([["id"], ["code"], ["user_id", "name"]]);
  });
  it("ignores partial unique indexes (not a global oracle) and non-public schemas", () => {
    const { facts } = build(
      "create table public.b (id uuid primary key default gen_random_uuid(), user_id uuid not null, ref text);",
      "create unique index u1 on public.b (ref) where ref is not null; create unique index u2 on public.b (user_id, ref); create table auth.c (id uuid);",
    );
    expect(facts.get("b").uniques).toEqual([["id"], ["user_id", "ref"]]);
    expect(facts.has("c")).toBe(false);
  });
});

describe("classify", () => {
  const sql = [
    "create table public.seedable (id uuid primary key default gen_random_uuid(), user_id uuid not null); alter table seedable enable row level security; create policy p on seedable for select to authenticated using (user_id = (select auth.uid()));",
    "create table public.needs_name (id uuid primary key default gen_random_uuid(), user_id uuid not null, name text not null); alter table needs_name enable row level security; create policy p on needs_name for select to authenticated using (user_id = (select auth.uid()));",
    "create table public.catalog (id int primary key, label text); alter table catalog enable row level security; create policy p on catalog for select to authenticated using (true);",
    "create table public.joined (id uuid primary key default gen_random_uuid(), parent_id uuid); alter table joined enable row level security; create policy p on joined for select to authenticated using (exists (select 1 from seedable s where s.id = parent_id));",
    "create table public.secrets (id uuid primary key default gen_random_uuid(), user_id uuid not null); alter table secrets enable row level security;",
    "create table public.norls (id int);",
  ];
  const { tables, facts } = build(...sql);
  const rows = classify(tables, facts, new Map([["needs_name", "x.test.sql"]]));
  const by = Object.fromEntries(rows.map((r) => [r.table, r.status]));

  it("assigns each table exactly one status and skips tables without RLS", () => {
    expect(Object.entries(by).sort()).toEqual([["catalog", "shared-reference"], ["joined", "gap"], ["needs_name", "hand-tested"], ["secrets", "service-only"], ["seedable", "generic-probe"]]);
  });
  it("flags a tenant table the generic probe cannot seed as a gap", () => {
    const r = classify(tables, facts, new Map()).find((x) => x.table === "needs_name");
    expect(r.status).toBe("gap");
    expect(r.reason).toContain("name");
  });
  it("summarizes counts", () => {
    expect(summarize(rows).tables).toBe(5);
  });
});

describe("gate", () => {
  const rows = [{ table: "a", status: "gap", reason: "r" }, { table: "b", status: "generic-probe" }];
  it("passes when every gap is frozen", () => {
    expect(gate(rows, { gaps: ["a"] })).toEqual([]);
  });
  it("FAILS on a NEW untested table", () => {
    const errs = gate([...rows, { table: "new_tbl", status: "gap", reason: "no tenant column" }], { gaps: ["a"] });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("new_tbl");
  });
  it("fails when a frozen gap was closed, so the baseline can only shrink", () => {
    const errs = gate(rows, { gaps: ["a", "b"] });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('"b"');
  });
});

describe("T6 helpers", () => {
  it("lists global unique keys on tenant tables as enumeration-oracle candidates, not tenant-scoped ones", () => {
    const { tables, facts } = build(
      "create table public.inv (id uuid primary key default gen_random_uuid(), user_id uuid not null, number text unique, scoped text, unique (user_id, scoped)); alter table inv enable row level security; create policy p on inv for select using (user_id = (select auth.uid()));",
    );
    expect(enumerationOracles(tables, facts)).toEqual([{ table: "inv", columns: "number" }]);
  });
  it("detects tables guests may read by design", () => {
    const { tables } = build("create table public.posts (id int primary key); alter table posts enable row level security; create policy p on posts for select to anon using (true);");
    expect(anonByDesign(tables)).toEqual(["posts"]);
  });
  it("generates a pgTAP file that checks anon read/write, profile/team enumeration and never skips silently", () => {
    const sql = renderGuestPgtap(["posts"]);
    expect(sql).toContain("array['posts']::text[]");
    expect(sql).toContain("set local role anon");
    expect(sql).toContain("tenant A cannot see tenant B''s profile");
    expect(sql).toContain("select skip(1,");
    expect(sql).toContain("rollback;");
  });
});
