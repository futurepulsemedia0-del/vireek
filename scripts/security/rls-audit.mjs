#!/usr/bin/env node
// scripts/security/rls-audit.mjs
//
// Replays supabase/migrations (static, in filename order) to compute, per public table:
// RLS enabled?, policies (cmd/roles/expressions), tenant column, and policy-performance lint.
//
//   node scripts/security/rls-audit.mjs --write   regenerate docs/security/rls-audit.{md,json} and
//                                                 supabase/tests/database/rls_catalog.test.sql
//   node scripts/security/rls-audit.mjs --check   CI gate (stale artifacts, NEW tables without RLS / policies, NEW perf/permissive findings)
//   node scripts/security/rls-audit.mjs --update-baseline
//
// STATIC replay = best effort (it does not execute SQL). The generated pgTAP file performs the RUNTIME proof
// against the real catalog; this script only gates drift and produces the inventory.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { posix, readText, sortKeys } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const TENANT_COLUMNS = ["user_id", "account_owner_id", "owner_id"];

// ---------------------------------------------------------------- SQL helpers
/** Strips -- and /* *\/ comments, keeping quoted strings and dollar-quoted bodies intact. */
export function stripSql(sql) {
  let out = "", i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    if (c === "-" && d === "-") { while (i < n && sql[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = sql.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; out += " "; continue; }
    if (c === "'") { let j = i + 1; while (j < n) { if (sql[j] === "'" && sql[j + 1] === "'") j += 2; else if (sql[j] === "'") break; else j++; } out += sql.slice(i, j + 1); i = j + 1; continue; }
    if (c === "$") { const m = sql.slice(i).match(/^\$([A-Za-z_]*)\$/); if (m) { const e = sql.indexOf(m[0], i + m[0].length); const end = e < 0 ? n : e + m[0].length; out += sql.slice(i, end); i = end; continue; } }
    out += c; i++;
  }
  return out;
}

/** Splits on ; outside quotes / dollar-quotes / parentheses-agnostic. Dollar-quoted bodies (functions) are returned inside their statement. */
export function splitStatements(sql) {
  const stmts = []; let cur = "", i = 0; const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") { let j = i + 1; while (j < n) { if (sql[j] === "'" && sql[j + 1] === "'") j += 2; else if (sql[j] === "'") break; else j++; } cur += sql.slice(i, j + 1); i = j + 1; continue; }
    if (c === "$") { const m = sql.slice(i).match(/^\$([A-Za-z_]*)\$/); if (m) { const e = sql.indexOf(m[0], i + m[0].length); const end = e < 0 ? n : e + m[0].length; cur += sql.slice(i, end); i = end; continue; } }
    if (c === ";") { if (cur.trim()) stmts.push(cur.trim()); cur = ""; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts;
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const QNAME = String.raw`(?:${IDENT}\.)?${IDENT}`;
const unq = (s) => s.replace(/"/g, "").replace(/^public\./i, "").toLowerCase();
const isPublic = (raw) => !/^"?(?:auth|storage|extensions|cron|net|vault|realtime|graphql\w*|pg_\w+|information_schema|supabase_\w+)"?\./i.test(raw);

function balanced(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "'") { i = s.indexOf("'", i + 1); if (i < 0) break; continue; }
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return s.slice(start + 1, i);
  }
  return s.slice(start + 1);
}

function topLevelItems(body) {
  const items = []; let depth = 0, cur = "";
  for (const ch of body) {
    if (ch === "(") depth++; else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { items.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
}

// ---------------------------------------------------------------- replay
export function replay(files) {
  const tables = new Map();
  const get = (t) => tables.get(t);
  for (const { name: file, sql } of files) {
    const queue = splitStatements(stripSql(sql));
    while (queue.length) {
      const st = queue.shift();
      let m;
      if (/^do\b/i.test(st)) {
        // Expand loop idioms: FOREACH t IN ARRAY ARRAY['a','b'] LOOP / FOR t IN SELECT … FROM (VALUES ('a',…)) LOOP
        // whose body EXECUTEs format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY' | 'CREATE POLICY …', t).
        const synth = [];
        let counter = 0;
        for (const chunk of st.split(/\bEND\s+LOOP\b/i)) {
          const heads = [...chunk.matchAll(/\b(?:FOREACH|FOR)\b[\s\S]*?\bLOOP\b/gi)];
          if (!heads.length) continue;
          const head = heads[heads.length - 1];
          let names = [...head[0].matchAll(/'([a-z_][a-z0-9_]*)'/gi)].map((x) => x[1].toLowerCase()).filter((n) => tables.has(n));
          // The table list may be declared earlier in the DO block (DECLARE tables text[] := ARRAY[...]): fall back to every known table named in it.
          if (!names.length) names = [...new Set([...st.matchAll(/'([a-z_][a-z0-9_]*)'/gi)].map((x) => x[1].toLowerCase()).filter((n) => tables.has(n)))];
          const body = chunk.slice(head.index + head[0].length);
          for (const f of body.matchAll(/format\(\s*'((?:[^']|'')*)'/gi)) {
            const lit = f[1].replace(/''/g, "'");
            if (/^\s*drop\s+policy/i.test(lit) || !/^\s*(alter\s+table|create\s+policy)/i.test(lit)) continue;
            for (const n of names) {
              let first = /^\s*create\s+policy\s+%I/i.test(lit);
              synth.push(lit.replace(/%1\$[sIL]|%[sIL]/g, () => (first ? ((first = false), `"${n}_dyn${counter++}"`) : n)));
            }
          }
        }
        // Plain statements living inside a DO block (e.g. guarded by IF/EXCEPTION).
        for (const x of st.matchAll(new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${QNAME})\\s+(?:enable|force)\\s+row\\s+level\\s+security`, "gi"))) synth.push(x[0]);
        queue.unshift(...synth);
        continue;
      }
      if ((m = st.match(new RegExp(`^create\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?(${QNAME})\\s*\\(`, "i")))) {
        if (!isPublic(m[1])) continue;
        const t = unq(m[1]);
        const body = balanced(st, st.indexOf("(", m.index + m[0].length - 1));
        const cols = new Map();
        const indexed = new Set();
        for (const item of topLevelItems(body)) {
          if (/^(constraint|primary\s+key|unique|foreign\s+key|check|exclude|like)\b/i.test(item)) {
            const pk = item.match(/(?:primary\s+key|unique)\s*\(([^)]*)\)/i);
            if (pk) indexed.add(unq(pk[1].split(",")[0].trim()));
            continue;
          }
          const cm = item.match(new RegExp(`^(${IDENT})\\s+(\\w+)`));
          if (cm) {
            const c = unq(cm[1]);
            cols.set(c, cm[2].toLowerCase());
            if (/primary\s+key|\bunique\b/i.test(item)) indexed.add(c);
          }
        }
        tables.set(t, { name: t, createdIn: file, cols, indexed, rls: false, forced: false, policies: new Map() });
        continue;
      }
      if ((m = st.match(new RegExp(`^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${QNAME})\\s+([\\s\\S]*)$`, "i")))) {
        const t = get(unq(m[1])); if (!t) continue;
        const rest = m[2];
        if (/enable\s+row\s+level\s+security/i.test(rest)) t.rls = true;
        if (/disable\s+row\s+level\s+security/i.test(rest)) t.rls = false;
        if (/\bforce\s+row\s+level\s+security/i.test(rest) && !/no\s+force/i.test(rest)) t.forced = true;
        for (const a of rest.matchAll(new RegExp(`add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?(${IDENT})\\s+(\\w+)`, "gi"))) t.cols.set(unq(a[1]), a[2].toLowerCase());
        const rn = rest.match(new RegExp(`^rename\\s+to\\s+(${IDENT})`, "i"));
        if (rn) { tables.delete(t.name); t.name = unq(rn[1]); tables.set(t.name, t); }
        continue;
      }
      if ((m = st.match(new RegExp(`^drop\\s+table\\s+(?:if\\s+exists\\s+)?([\\s\\S]+)$`, "i")))) {
        for (const q of m[1].replace(/\b(cascade|restrict)\b/gi, "").split(",")) tables.delete(unq(q.trim()));
        continue;
      }
      if ((m = st.match(new RegExp(`^create\\s+policy\\s+(${IDENT})\\s+on\\s+(${QNAME})\\s*([\\s\\S]*)$`, "i")))) {
        const t = get(unq(m[2])); if (!t) continue;
        const rest = m[3];
        const cmd = (rest.match(/\bfor\s+(all|select|insert|update|delete)\b/i)?.[1] ?? "all").toLowerCase();
        const roles = (rest.match(/\bto\s+([\w",\s]+?)(?=\s+(?:using|with\s+check)\b|$)/i)?.[1] ?? "public").split(",").map((r) => r.trim().replace(/"/g, "").toLowerCase());
        const ui = rest.search(/\busing\s*\(/i);
        const wi = rest.search(/\bwith\s+check\s*\(/i);
        const using = ui >= 0 ? balanced(rest, rest.indexOf("(", ui)) : null;
        const check = wi >= 0 ? balanced(rest, rest.indexOf("(", wi)) : null;
        t.policies.set(unq(m[1]), { name: unq(m[1]), cmd, roles, using, check, file, permissive: !/\bas\s+restrictive\b/i.test(rest) });
        continue;
      }
      if ((m = st.match(new RegExp(`^drop\\s+policy\\s+(?:if\\s+exists\\s+)?(${IDENT})\\s+on\\s+(${QNAME})`, "i")))) {
        get(unq(m[2]))?.policies.delete(unq(m[1]));
        continue;
      }
      if ((m = st.match(new RegExp(`^create\\s+(?:unique\\s+)?index\\s+(?:concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?${IDENT}?\\s*on\\s+(?:only\\s+)?(${QNAME})\\s*(?:using\\s+\\w+\\s*)?\\(([^)]*)\\)`, "i")))) {
        const t = get(unq(m[1])); if (!t) continue;
        t.indexed.add(unq(m[2].split(",")[0].trim().split(/\s+/)[0]));
      }
    }
  }
  return tables;
}

// ---------------------------------------------------------------- lint
const AUTH_FN = /\b(auth\.uid|auth\.jwt|auth\.role|get_account_owner_id|current_setting)\s*\(/gi;

/** True when every occurrence of an auth function in expr is inside a `(select ...)` sub-select (initPlan-cacheable). */
export function unwrappedAuthCalls(expr) {
  if (!expr) return [];
  const bad = [];
  for (const m of expr.matchAll(AUTH_FN)) {
    const before = expr.slice(0, m.index).replace(/(?:\w+\.)+$/, ""); // drop a schema prefix such as public.
    // wrapped if the closest preceding non-space characters are `(select` (optionally `(select coalesce(`) 
    if (!/\(\s*select\s+(?:[\w.]+\s*\(\s*)?$/i.test(before)) bad.push(m[1].toLowerCase());
  }
  return bad;
}

export function lint(tables) {
  const findings = [];
  for (const t of [...tables.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!t.rls) findings.push({ table: t.name, rule: "no-rls", detail: `created in ${t.createdIn}` });
    else if (t.policies.size === 0) findings.push({ table: t.name, rule: "rls-no-policy", detail: "service-role only (deny-by-default). Must be intentional." });
    const tenantCol = TENANT_COLUMNS.find((c) => t.cols.has(c));
    for (const p of t.policies.values()) {
      const exprs = [p.using, p.check];
      const permissiveTrue = exprs.some((e) => e !== null && /^\s*true\s*$/i.test(e));
      const forClients = p.roles.some((r) => ["public", "anon", "authenticated"].includes(r));
      if (permissiveTrue && forClients && p.permissive) findings.push({ table: t.name, rule: "policy-true", detail: `${p.name} (${p.cmd}) for ${p.roles.join(",")}` });
      if (p.cmd !== "select" && p.roles.includes("anon") && !/^\s*false\s*$/i.test(p.using ?? "false")) findings.push({ table: t.name, rule: "anon-write-policy", detail: `${p.name} (${p.cmd})` });
      const unwrapped = [...new Set(exprs.flatMap(unwrappedAuthCalls))];
      if (unwrapped.length) findings.push({ table: t.name, rule: "policy-unwrapped-auth", detail: `${p.name}: ${unwrapped.join(", ")} not wrapped in (select …)` });
      const refs = [...new Set(exprs.flatMap((e) => (e ? [...e.matchAll(/\b(user_id|account_owner_id|owner_id)\b/gi)].map((x) => x[1].toLowerCase()) : [])))];
      for (const c of refs) if (t.cols.has(c) && !t.indexed.has(c)) findings.push({ table: t.name, rule: "policy-column-unindexed", detail: `${p.name} filters on ${c} but no index/PK/unique with ${c} as leading column was found` });
    }
    void tenantCol;
  }
  const seen = new Set();
  return findings.filter((f) => { const k = `${f.table}|${f.rule}|${f.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function summarizeRls(tables, findings) {
  const list = [...tables.values()];
  const rules = {};
  for (const f of findings) rules[f.rule] = (rules[f.rule] ?? 0) + 1;
  return {
    tables: list.length,
    rlsEnabled: list.filter((t) => t.rls).length,
    withPolicies: list.filter((t) => t.rls && t.policies.size > 0).length,
    serviceRoleOnly: list.filter((t) => t.rls && t.policies.size === 0).length,
    noRls: list.filter((t) => !t.rls).length,
    policies: list.reduce((n, t) => n + t.policies.size, 0),
    tenantColumnTables: list.filter((t) => TENANT_COLUMNS.some((c) => t.cols.has(c)) && t.rls && t.policies.size > 0).length,
    findings: rules,
  };
}

// ---------------------------------------------------------------- baseline gate
export function gateRls(findings, baseline) {
  const frozen = new Set((baseline.findings ?? []).map((f) => `${f.table}|${f.rule}`));
  const errors = [];
  const keys = new Set();
  for (const f of findings) {
    const k = `${f.table}|${f.rule}`;
    keys.add(k);
    if (!frozen.has(k)) errors.push(`${f.table}: ${f.rule} — ${f.detail}${f.rule === "no-rls" ? " (add ENABLE ROW LEVEL SECURITY + policies in the same migration)" : ""}`);
  }
  for (const k of frozen) if (!keys.has(k)) errors.push(`baseline entry "${k}" is fixed — run --update-baseline to shrink the baseline.`);
  return errors;
}

// ---------------------------------------------------------------- pgTAP generation
const sqlArr = (xs) => (xs.length ? `array[${xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(", ")}]::text[]` : "array[]::text[]");

export function renderPgtap(baseline) {
  const exemptNoRls = (baseline.findings ?? []).filter((f) => f.rule === "no-rls").map((f) => f.table).sort();
  const exemptNoPolicy = (baseline.findings ?? []).filter((f) => f.rule === "rls-no-policy").map((f) => f.table).sort();
  return `-- GENERATED by scripts/security/rls-audit.mjs --write. Do not edit by hand.
-- Runtime RLS proof against the REAL catalog. Run with:  supabase test db
--   1. every public table has RLS enabled (exceptions are the frozen legacy list below; the list may only shrink)
--   2. every RLS table without a policy is a known service-role-only table (deny-by-default), and anon/authenticated can read 0 rows
--   3. cross-tenant isolation: for every table with a tenant column AND a policy whose minimal row can be seeded, an
--      unrelated authenticated user cannot SELECT, UPDATE or DELETE another tenant's row and cannot INSERT into it.
--      Tables that cannot be seeded with only the tenant column are reported with skip() — they are NOT proven by this file.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();

create temp table _rls_exempt_no_rls as select unnest(${sqlArr(exemptNoRls)}) as t;
create temp table _rls_known_service_only as select unnest(${sqlArr(exemptNoPolicy)}) as t;

-- 1. RLS enabled everywhere
select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r','p') and not c.relispartition and not c.relrowsecurity
       and c.relname not in (select t from _rls_exempt_no_rls) order by 1 $$,
  'every public table has RLS enabled (outside the frozen legacy exemption list)');

-- 2. service-role-only tables: no policy, and clients read nothing
select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r','p') and c.relrowsecurity
       and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
       and c.relname not in (select t from _rls_known_service_only) order by 1 $$,
  'every RLS table without a policy is a known, intentional service-role-only table');

create or replace function pg_temp._rls_client_reads_nothing() returns table(tbl text, leaked bigint) language plpgsql as $f$
declare r record; n bigint;
begin
  for r in select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
           where ns.nspname = 'public' and c.relkind in ('r','p') and c.relrowsecurity
             and not exists (select 1 from pg_policy p where p.polrelid = c.oid) order by 1 loop
    tbl := r.relname;
    begin
      execute 'set local role authenticated';
      execute format('select count(*) from public.%I', r.relname) into n;
    exception when insufficient_privilege then n := 0;   -- permission denied == unreachable
    end;
    execute 'reset role';
    leaked := n;
    return next;
  end loop;
end $f$;
select is((select count(*) from pg_temp._rls_client_reads_nothing() where leaked > 0), 0::bigint, 'service-role-only tables return no rows to authenticated clients');

-- 3. cross-tenant isolation probe
create temp table _rls_probe(tbl text, col text, seeded boolean, read_ok boolean, update_ok boolean, delete_ok boolean, insert_ok boolean);

create or replace function pg_temp._rls_run_probe() returns void language plpgsql as $f$
declare
  r record; col text; n bigint; seeded boolean; rd boolean; up boolean; de boolean; ins boolean;
  a uuid := '00000000-0000-0000-0000-00000000a0a0';
  b uuid := '00000000-0000-0000-0000-00000000b0b0';
begin
  insert into auth.users (id, email) values (a, 'tenant-a@rls-probe.test'), (b, 'tenant-b@rls-probe.test') on conflict do nothing;
  for r in
    select c.oid, c.relname,
           (select a2.attname from pg_attribute a2 where a2.attrelid = c.oid and not a2.attisdropped and a2.atttypid = 'uuid'::regtype
              and a2.attname in ('user_id','account_owner_id','owner_id') order by array_position(array['user_id','account_owner_id','owner_id'], a2.attname::text) limit 1) as tcol
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and exists (select 1 from pg_policy p where p.polrelid = c.oid)
    order by c.relname
  loop
    continue when r.tcol is null;
    col := r.tcol; seeded := false; rd := null; up := null; de := null; ins := null;
    begin   -- seed one row for tenant B as the table owner (bypasses RLS); only the tenant column is supplied
      execute 'reset role';
      execute format('insert into public.%I (%I) values ($1)', r.relname, col) using b;
      execute format('select count(*) from public.%I where %I = $1', r.relname, col) into n using b;
      seeded := n > 0;
    exception when others then seeded := false;
    end;
    if seeded then
      perform set_config('request.jwt.claim.sub', a::text, true);
      perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
      begin execute 'set local role authenticated'; execute format('select count(*) from public.%I where %I = $1', r.relname, col) into n using b; rd := (n = 0);
      exception when insufficient_privilege then rd := true; when others then rd := false; end;
      begin execute 'set local role authenticated'; execute format('update public.%I set %I = %I where %I = $1', r.relname, col, col, col) using b; get diagnostics n = row_count; up := (n = 0);
      exception when insufficient_privilege then up := true; when others then up := false; end;
      begin execute 'set local role authenticated'; execute format('delete from public.%I where %I = $1', r.relname, col) using b; get diagnostics n = row_count; de := (n = 0);
      exception when insufficient_privilege then de := true; when others then de := false; end;
      begin execute 'set local role authenticated'; execute format('insert into public.%I (%I) values ($1)', r.relname, col) using b; ins := false;
      exception when insufficient_privilege then ins := true; when others then ins := false; end;
      execute 'reset role';
    end if;
    insert into _rls_probe values (r.relname, col, seeded, rd, up, de, ins);
  end loop;
  execute 'reset role';
end $f$;
select pg_temp._rls_run_probe();

select ok(read_ok,   tbl || ': tenant A cannot SELECT tenant B rows (' || col || ')') from _rls_probe where seeded order by tbl;
select ok(update_ok, tbl || ': tenant A cannot UPDATE tenant B rows') from _rls_probe where seeded order by tbl;
select ok(delete_ok, tbl || ': tenant A cannot DELETE tenant B rows') from _rls_probe where seeded order by tbl;
select ok(insert_ok, tbl || ': tenant A cannot INSERT a row for tenant B') from _rls_probe where seeded order by tbl;
select skip(1, tbl || ': not seedable with only ' || col || ' — NOT proven by the generic probe; needs a hand-written test') from _rls_probe where not seeded order by tbl;
select diag('RLS probe coverage: ' || count(*) filter (where seeded) || ' tables proven, ' || count(*) filter (where not seeded) || ' not seedable (skipped)') from _rls_probe;

select * from finish();
rollback;
`;
}

// ---------------------------------------------------------------- markdown
export function renderMd(tables, findings, summary) {
  const L = ["# RLS audit", "", "> Generated by `node scripts/security/rls-audit.mjs --write`. Static replay of `supabase/migrations` (best effort). The runtime proof is `supabase/tests/database/rls_catalog.test.sql` (pgTAP).", "", "## Summary", "", "| Metric | Count |", "|---|---:|"];
  const lab = { tables: "Public tables", rlsEnabled: "RLS enabled", withPolicies: "RLS + ≥1 policy", serviceRoleOnly: "RLS, no policy (service-role only)", noRls: "NO RLS", policies: "Policies", tenantColumnTables: "Tenant-column tables with policies (probe candidates)" };
  for (const [k, v] of Object.entries(lab)) L.push(`| ${v} | ${summary[k]} |`);
  L.push("", "## Findings by rule (legacy frozen in `rls-baseline.json`; new ones fail CI)", "", "| Rule | Count |", "|---|---:|");
  for (const [r, n] of Object.entries(summary.findings).sort((a, b) => b[1] - a[1])) L.push(`| \`${r}\` | ${n} |`);
  const sect = (title, rule) => {
    const xs = findings.filter((f) => f.rule === rule);
    L.push("", `## ${title} (${xs.length})`, "", xs.length ? xs.map((f) => `\`${f.table}\``).join(", ") : "_None._");
  };
  sect("Tables WITHOUT row level security", "no-rls");
  sect("RLS enabled but no policy (must be service-role-only)", "rls-no-policy");
  sect("Policies that are `true` for clients", "policy-true");
  sect("Policies with auth functions not wrapped in `(select …)`", "policy-unwrapped-auth");
  sect("Policy columns without a leading index", "policy-column-unindexed");
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------- CLI
export function load(root = ROOT) {
  const dir = path.join(root, "supabase", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => ({ name: f, sql: readText(path.join(dir, f)) }));
  const tables = replay(files);
  const findings = lint(tables);
  return { tables, findings, summary: summarizeRls(tables, findings) };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const { tables, findings, summary } = load();
  const out = (p) => path.join(ROOT, p);
  const basePath = out("docs/security/rls-baseline.json");
  const loadBase = () => (fs.existsSync(basePath) ? JSON.parse(readText(basePath)) : { version: 1, findings: [] });

  if (args.has("--update-baseline")) {
    const next = { version: 1, note: "Frozen legacy RLS findings. Only ever shrink. Generated by scripts/security/rls-audit.mjs --update-baseline.", findings: findings.map((f) => ({ table: f.table, rule: f.rule })) };
    fs.writeFileSync(basePath, `${JSON.stringify(sortKeys(next), null, 2)}\n`);
    console.log(`rls baseline written: ${next.findings.length} findings`);
  }
  const artifacts = {
    "docs/security/rls-audit.md": renderMd(tables, findings, summary),
    "docs/security/rls-audit.json": `${JSON.stringify(sortKeys({ version: 1, summary, findings }), null, 2)}\n`,
    "supabase/tests/database/rls_catalog.test.sql": renderPgtap(loadBase()),
  };
  if (args.has("--write") || args.has("--update-baseline")) {
    for (const [p, text] of Object.entries(artifacts)) fs.writeFileSync(out(p), text);
    console.log(`wrote ${Object.keys(artifacts).map(posix).join(", ")}`);
    return;
  }
  if (args.has("--check")) {
    const errors = gateRls(findings, loadBase());
    for (const [p, text] of Object.entries(artifacts)) if (!fs.existsSync(out(p)) || readText(out(p)) !== text) errors.push(`${p} is stale — run: node scripts/security/rls-audit.mjs --write`);
    if (errors.length) { console.error(`RLS gate FAILED (${errors.length}):`); for (const e of errors) console.error(`  - ${e}`); process.exit(1); }
    console.log(`RLS gate passed (${summary.tables} tables, ${summary.rlsEnabled} with RLS).`);
    return;
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
