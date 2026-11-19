// node --test scripts/security/rls-perf.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maskLiterals, normalizedHash, pickTargets, planIndexes, planPolicies, unwrapAuthCalls, wrapAuthCalls } from "./rls-perf-lib.mjs";
import { renderMigration, renderRollback, renderTest } from "./rls-wrap-generator.mjs";
import { renderMigration as idxMigration, renderOps } from "./rls-index-generator.mjs";

const pol = (table, name, qual, check = null, extra = {}) => ({ schemaname: "public", tablename: table, policyname: name, cmd: "SELECT", permissive: "PERMISSIVE", roles: ["authenticated"], qual, with_check: check, ...extra });

describe("wrapAuthCalls", () => {
  it("wraps bare calls and leaves wrapped ones alone", () => {
    const r = wrapAuthCalls("((a = auth.uid()) OR (( SELECT auth.uid() AS uid) = b))");
    assert.equal(r.count, 1);
    assert.equal(r.sql, "((a = (select auth.uid())) OR (( SELECT auth.uid() AS uid) = b))");
  });
  it("covers jwt/role/email, coalesce and schema-spaced calls", () => {
    assert.equal(wrapAuthCalls("(auth.jwt() ->> 'x'::text) = auth.role()").sql, "((select auth.jwt()) ->> 'x'::text) = (select auth.role())");
    assert.equal(wrapAuthCalls("COALESCE(auth.email(), '')").sql, "COALESCE((select auth.email()), '')");
    assert.equal(wrapAuthCalls("x = auth . uid ( )").count, 1);
  });
  it("never touches string literals or quoted identifiers", () => {
    const e = "body <> 'auth.uid()' AND \"auth.uid()\" = 1 AND it = 'it''s auth.uid()'";
    assert.deepEqual(wrapAuthCalls(e), { sql: e, count: 0 });
  });
  it("is idempotent on its own output", () => {
    const once = wrapAuthCalls("a = auth.uid() and b = auth.jwt() ->> 'k'").sql;
    assert.equal(wrapAuthCalls(once).count, 0);
  });
  it("handles null / empty", () => {
    assert.deepEqual(wrapAuthCalls(null), { sql: null, count: 0 });
    assert.deepEqual(wrapAuthCalls(""), { sql: "", count: 0 });
  });
  it("does not match lookalikes", () => {
    for (const e of ["x = myauth.uid()", "x = auth.uidx()", "x = auth.uid", "x = other.auth.uid_v2()"]) assert.equal(wrapAuthCalls(e).count, 0, e);
  });
});

describe("unwrapAuthCalls / normalizedHash", () => {
  it("is the exact inverse for Postgres-deparsed text", () => {
    const orig = "((a = auth.uid()) OR (b = auth.jwt()))";
    const deparsedAfter = "((a = ( SELECT auth.uid() AS uid)) OR (b = ( SELECT auth.jwt() AS jwt)))";
    assert.equal(unwrapAuthCalls(deparsedAfter), orig);
    assert.equal(normalizedHash(deparsedAfter), normalizedHash(orig));
  });
  it("a changed expression changes the hash", () => {
    assert.notEqual(normalizedHash("a = auth.uid()"), normalizedHash("a = auth.uid() AND b"));
  });
});

describe("maskLiterals", () => {
  it("keeps length and blanks literal bodies", () => {
    const s = "a = 'x''y' and \"q\" = 1";
    const m = maskLiterals(s);
    assert.equal(m.length, s.length);
    assert.ok(!m.includes("x") && !m.includes("y") && !m.includes("q"));
  });
});

describe("planPolicies / pickTargets", () => {
  const policies = [
    pol("big", "p1", "(user_id = auth.uid())"),
    pol("big", "p2", "(user_id = ( SELECT auth.uid() AS uid))"),
    pol("hot", "p1", "(x = auth.role())", "(y = auth.uid())"),
    pol("cold", "p1", "(z = auth.uid())"),
    pol("clean", "p1", "true"),
    { ...pol("other", "p1", "(z = auth.uid())"), schemaname: "private" },
  ];
  const stats = [
    { table: "big", reltuples: 1e6, scans: 5, relkind: "r" },
    { table: "hot", reltuples: 10, scans: 9e6, relkind: "r" },
    { table: "cold", reltuples: 3, scans: 1, relkind: "r" },
    { table: "clean", reltuples: 9e9, scans: 9e9, relkind: "r" },
  ];
  it("plans only policies that change, only the requested schema", () => {
    const plan = planPolicies(policies);
    assert.deepEqual(plan.map((p) => `${p.table}.${p.policy}`), ["big.p1", "cold.p1", "hot.p1"]);
    assert.equal(plan.find((p) => p.table === "hot").newUsing, "(x = (select auth.role()))");
    assert.equal(plan.find((p) => p.table === "hot").newCheck, "(y = (select auth.uid()))");
    assert.equal(plan.find((p) => p.table === "big").newCheck, null);
  });
  it("ranks by best of rows/scans, skips tables with nothing to do", () => {
    assert.deepEqual(pickTargets(policies, stats, { top: 2 }).sort(), ["big", "hot"]);
    assert.deepEqual(pickTargets(policies, stats, { top: 20 }).sort(), ["big", "cold", "hot"]);
  });
  it("honours an explicit table list (still only those with work)", () => {
    assert.deepEqual(pickTargets(policies, stats, { explicit: ["cold", "clean"] }), ["cold"]);
  });
});

describe("generated SQL", () => {
  const plan = planPolicies([pol("jobs", "sel", "((account_owner_id = auth.uid()) AND (body <> 'auth.uid()'::text))", null, {})]);
  const meta = { batch: "1", catalogSha: "a".repeat(64) };
  it("migration is guarded + idempotent, uses dollar quoting and the new text", () => {
    const sql = renderMigration(plan, meta);
    assert.match(sql, /do \$rlsw\$/);
    assert.match(sql, /\(select auth\.uid\(\)\)/);
    assert.match(sql, /'auth\.uid\(\)'::text/); // literal untouched
    assert.match(sql, /expression changed since capture/);
    assert.match(sql, /lock_timeout/);
  });
  it("rollback restores the captured text; test asserts 4 properties", () => {
    assert.match(renderRollback(plan, meta), /\(account_owner_id = auth\.uid\(\)\)/);
    assert.match(renderTest(plan, meta), /select plan\(4\)/);
  });
  it("rejects expressions that would break the dollar quote", () => {
    const evil = planPolicies([pol("t", "p", "x = auth.uid() and y = '$q$'")]);
    assert.throws(() => renderMigration(evil, meta), /dollar-quote/);
  });
  it("output is deterministic", () => {
    assert.equal(renderMigration(plan, meta), renderMigration(plan, meta));
  });
});

describe("planIndexes", () => {
  const cat = {
    policies: [
      pol("a", "p", "(user_id = auth.uid())"),
      pol("b", "p", "(account_owner_id = ( SELECT auth.uid() AS uid))"),
      pol("c", "p", "(EXISTS (SELECT 1 FROM team_members m WHERE ((m.user_id = auth.uid()))))"),
      pol("d", "p", "(owner_id = auth.uid())", "(user_id = auth.uid())"),
      pol("e", "p", "(note = 'user_id')"),
    ],
    columns: ["a.user_id", "b.account_owner_id", "c.user_id", "d.owner_id", "d.user_id", "e.user_id"].map((x) => ({ table: x.split(".")[0], column: x.split(".")[1] })),
    leadingIndexed: [{ table: "b", column: "account_owner_id" }],
    stats: [
      { table: "a", reltuples: 10, scans: 0, relkind: "r" },
      { table: "d", reltuples: 5e6, scans: 0, relkind: "r" },
    ],
    indexNames: [],
  };
  it("flags unindexed policy columns only (qualified / literal / indexed are ignored)", () => {
    const got = planIndexes(cat).map((i) => `${i.table}.${i.column}`);
    assert.deepEqual(got, ["a.user_id", "d.owner_id", "d.user_id"]);
  });
  it("big and unknown-size tables go to the concurrent path; partitioned parents never do", () => {
    const by = Object.fromEntries(planIndexes(cat).map((i) => [`${i.table}.${i.column}`, i.concurrent]));
    assert.equal(by["a.user_id"], false);
    assert.equal(by["d.owner_id"], true);
    const part = planIndexes({ ...cat, stats: [{ table: "a", reltuples: 9e9, scans: 0, relkind: "p" }] }, { tables: ["a"] });
    assert.equal(part[0].concurrent, false);
    assert.equal(part[0].partitioned, true);
  });
  it("index names stay <= 63 bytes and avoid collisions", () => {
    const long = "t".repeat(60);
    const c2 = { ...cat, policies: [pol(long, "p", "(user_id = auth.uid())")], columns: [{ table: long, column: "user_id" }], stats: [], indexNames: [] };
    assert.ok(planIndexes(c2)[0].name.length <= 63);
    const c3 = { ...cat, policies: [pol("a", "p", "(user_id = auth.uid())")], indexNames: ["idx_a_user_id"] };
    assert.notEqual(planIndexes(c3, { tables: ["a"] })[0].name, "idx_a_user_id");
  });
  it("renders CONCURRENTLY only in the ops file, never inside a transaction block", () => {
    const items = planIndexes(cat);
    const mig = idxMigration(items.filter((i) => !i.concurrent));
    const ops = renderOps(items.filter((i) => i.concurrent));
    assert.ok(!/concurrently/i.test(mig.replace(/--.*$/gm, "")));
    assert.match(ops, /create index concurrently if not exists/);
    assert.ok(!/\b(begin|commit)\b/i.test(ops.replace(/--.*$/gm, "")));
  });
});

describe("get_account_owner_id() (dominant tenant predicate)", () => {
  it("wraps qualified and unqualified calls; unwrap is the exact inverse (public. normalised away)", () => {
    const r = wrapAuthCalls("(account_owner_id = public.get_account_owner_id()) OR (x = get_account_owner_id())");
    assert.equal(r.count, 2);
    assert.equal(r.sql, "(account_owner_id = (select public.get_account_owner_id())) OR (x = (select public.get_account_owner_id()))");
    const deparsed = "(account_owner_id = ( SELECT get_account_owner_id() AS get_account_owner_id))";
    assert.equal(normalizedHash(deparsed), normalizedHash("(account_owner_id = public.get_account_owner_id())"));
  });
  it("does not wrap it when owner:false (volatile function) and ignores lookalikes", () => {
    assert.equal(wrapAuthCalls("a = get_account_owner_id()", { owner: false }).count, 0);
    assert.equal(wrapAuthCalls("a = my_get_account_owner_id()").count, 0);
    assert.equal(wrapAuthCalls("a = get_account_owner_id(x)").count, 0);
  });
  it("planPolicies honours the owner switch", () => {
    const p = [pol("t", "p", "(a = get_account_owner_id())")];
    assert.equal(planPolicies(p).length, 1);
    assert.equal(planPolicies(p, { owner: false }).length, 0);
  });
});
