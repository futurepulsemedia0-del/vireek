// scripts/security/rls-perf-lib.mjs
// Pure helpers (no I/O, zero dependencies) for the RLS performance generators.
//  - wrapAuthCalls():  auth.uid() -> (select auth.uid())   (Supabase "initPlan" optimisation)
//  - unwrapAuthCalls(): exact inverse, mirrored by the SQL guards in the generated migration/tests
//  - pickTargets():    choose the largest / hottest tables that still have unwrapped policies
//  - planIndexes():    missing leading-column indexes for policy columns (same rule as rls-audit.mjs)
import { createHash } from "node:crypto";

export const INDEX_COLUMNS = ["user_id", "account_owner_id", "owner_id"];
/** Zero-argument STABLE helpers that RLS policies call per row. Wrapped only when the catalog proves STABLE/IMMUTABLE. */
export const OWNER_FN = "get_account_owner_id";

// auth.uid()/jwt()/role()/email()  and  [public.]get_account_owner_id()
const CALL = String.raw`(?<![\w.])(?:auth\s*\.\s*(uid|jwt|role|email)|(?:public\s*\.\s*)?(get_account_owner_id))\s*\(\s*\)`;
// Postgres deparses `(select f())` as `( SELECT f() AS f)`; used for the exact inverse + SQL guards.
export const SQL_WRAPPED = String.raw`\(\s*select\s+((?:auth\.(?:uid|jwt|role|email))|(?:public\.)?get_account_owner_id)\(\)\s+as\s+\w+\s*\)`;
export const SQL_BARE = String.raw`(?:auth\.(?:uid|jwt|role|email)|get_account_owner_id)\(\)`;
const WRAPPED_DEPARSED = new RegExp(SQL_WRAPPED, "gi");

export const md5 = (s) => createHash("md5").update(s ?? "", "utf8").digest("hex");
export const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** Same-length copy of `sql` with the contents of '…' literals and "…" identifiers blanked out. */
export function maskLiterals(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2; // doubled quote = escaped quote
          else break;
        } else j++;
      }
      const end = Math.min(j, sql.length - 1);
      out += c + " ".repeat(Math.max(0, end - i - 1)) + (j < sql.length ? c : "");
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out.slice(0, sql.length).padEnd(sql.length, " ");
}

/**
 * Wraps every bare auth.<fn>() (and, unless owner:false, get_account_owner_id()) outside literals as
 * `(select …)`. Returns { sql, count }.
 */
export function wrapAuthCalls(expr, { owner = true } = {}) {
  if (expr == null || expr === "") return { sql: expr ?? null, count: 0 };
  const masked = maskLiterals(expr);
  let out = "";
  let last = 0;
  let count = 0;
  for (const m of masked.matchAll(new RegExp(CALL, "gi"))) {
    if (m[2] && !owner) continue;
    if (/\(\s*select\s+$/i.test(masked.slice(0, m.index))) continue; // already the body of a (select …)
    const call = m[1] ? `auth.${m[1].toLowerCase()}()` : `public.${OWNER_FN}()`;
    out += expr.slice(last, m.index) + `(select ${call})`;
    last = m.index + m[0].length;
    count++;
  }
  return { sql: out + expr.slice(last), count };
}

/** Number of bare (unwrapped) auth calls left in a catalog (deparsed) expression. */
export function countUnwrapped(expr, opts) {
  return wrapAuthCalls(expr, opts).count;
}

/** Exact inverse for catalog-deparsed text (also drops a `public.` qualifier); mirrored by the SQL guards/tests. */
export function unwrapAuthCalls(expr) {
  return (expr ?? "").replace(WRAPPED_DEPARSED, (_m, call) => `${call.toLowerCase()}()`).replace(/public\.get_account_owner_id/gi, OWNER_FN);
}

/** Hash of the policy expression modulo wrapping — equal before/after a correct wrap. */
export const normalizedHash = (expr) => md5(unwrapAuthCalls(expr));

const sqlStr = (s) => (s == null ? "null::text" : `'${String(s).replace(/'/g, "''")}'`);
export const dq = (tag, body) => {
  if (body.includes(`$${tag}$`)) throw new Error(`Expression contains the dollar-quote tag $${tag}$`);
  return `$${tag}$${body}$${tag}$`;
};
export { sqlStr };

/** Group a pg_policies export into planned ALTER POLICY edits (only policies that actually change). */
export function planPolicies(policies, { schema = "public", tables = null, owner = true } = {}) {
  const set = tables ? new Set(tables) : null;
  const plan = [];
  for (const p of policies) {
    if (p.schemaname !== schema) continue;
    if (set && !set.has(p.tablename)) continue;
    const u = wrapAuthCalls(p.qual, { owner });
    const c = wrapAuthCalls(p.with_check, { owner });
    if (u.count + c.count === 0) continue;
    plan.push({
      table: p.tablename,
      policy: p.policyname,
      cmd: String(p.cmd).toLowerCase(),
      permissive: String(p.permissive).toUpperCase(),
      roles: Array.isArray(p.roles) ? p.roles.join(",") : String(p.roles).replace(/[{}]/g, ""),
      origUsing: p.qual ?? null,
      origCheck: p.with_check ?? null,
      newUsing: u.count ? u.sql : null, // null => clause not touched
      newCheck: c.count ? c.sql : null,
      calls: u.count + c.count,
    });
  }
  return plan.sort((a, b) => a.table.localeCompare(b.table) || a.policy.localeCompare(b.policy));
}

/**
 * Pick target tables: among tables with >= 1 unwrapped policy, rank by rows and by scans; a table's
 * score is its BEST rank in either list ("largest OR hottest"); ties break by rows desc, then name.
 */
export function pickTargets(policies, stats, { top = 20, explicit = null, schema = "public", owner = true } = {}) {
  const withWork = new Set(planPolicies(policies, { schema, owner }).map((p) => p.table));
  if (explicit?.length) return explicit.filter((t) => withWork.has(t));
  const rows = stats.filter((s) => withWork.has(s.table));
  const byRows = [...rows].sort((a, b) => b.reltuples - a.reltuples || a.table.localeCompare(b.table));
  const byScans = [...rows].sort((a, b) => b.scans - a.scans || a.table.localeCompare(b.table));
  const rank = new Map();
  byRows.forEach((s, i) => rank.set(s.table, { r: i, s: Infinity }));
  byScans.forEach((s, i) => (rank.get(s.table).s = i));
  return rows
    .map((s) => ({ ...s, score: Math.min(rank.get(s.table).r, rank.get(s.table).s) }))
    .sort((a, b) => a.score - b.score || b.reltuples - a.reltuples || a.table.localeCompare(b.table))
    .slice(0, top)
    .map((s) => s.table);
}

const bareIdent = (masked, col) => new RegExp(`(?<![\\w.])${col}(?![\\w(])`, "i").test(masked);

/** Missing leading-column indexes for policy columns. Mirrors the `policy-column-unindexed` audit rule. */
export function planIndexes({ policies, columns, leadingIndexed, stats, indexNames = [] }, { tables = null, schema = "public", concurrentAbove = 100000 } = {}) {
  const cols = new Map();
  for (const c of columns) (cols.get(c.table) ?? cols.set(c.table, new Set()).get(c.table)).add(c.column);
  const indexed = new Set(leadingIndexed.map((i) => `${i.table}.${i.column}`));
  const st = new Map(stats.map((s) => [s.table, s]));
  const taken = new Set(indexNames);
  const filter = tables ? new Set(tables) : null;
  const need = new Map();
  for (const p of policies) {
    if (p.schemaname !== schema || (filter && !filter.has(p.tablename))) continue;
    const exprs = [maskLiterals(p.qual ?? ""), maskLiterals(p.with_check ?? "")];
    for (const col of INDEX_COLUMNS) {
      if (!cols.get(p.tablename)?.has(col) || indexed.has(`${p.tablename}.${col}`)) continue;
      if (exprs.some((m) => bareIdent(m, col))) need.set(`${p.tablename}.${col}`, { table: p.tablename, column: col });
    }
  }
  return [...need.values()]
    .sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column))
    .map((n) => {
      let name = `idx_${n.table}_${n.column}`;
      if (name.length > 63) name = `${name.slice(0, 54)}_${md5(name).slice(0, 8)}`;
      if (taken.has(name)) name = `${name.slice(0, 54)}_${md5(`${name}rls`).slice(0, 8)}`;
      taken.add(name);
      const s = st.get(n.table) ?? { reltuples: -1, relkind: "r" };
      const partitioned = s.relkind === "p";
      const unknownOrBig = s.reltuples < 0 || s.reltuples > concurrentAbove;
      return { ...n, name, reltuples: s.reltuples, partitioned, concurrent: unknownOrBig && !partitioned };
    });
}
