// scripts/compliance/erasure-lib.mjs
//
// Pure helpers for the erasure-registry completeness check. No I/O except readMigrations().
// Everything here is deterministic and unit-tested (erasure-lib.test.mjs).
//
// What "covered by account erasure" means in Vireek (verified against the code, see
// supabase/functions/delete-account and supabase/migrations/20280410000000_erase_user_rows.sql):
//   1. swept     — table has a uuid `user_id` column; the erase_user_rows() RPC deletes from it
//                  (unless the table is in the RPC's exclusion list).
//   2. owned     — listed in OWNED_TABLES (deleted by user_id) or TENANT_KEYED_OWNED_TABLES
//                  (deleted by an explicit tenant column such as account_id / tenant_id).
//   3. cascade   — FK ... ON DELETE CASCADE to a covered parent (or to auth.users / profiles on a
//                  user/tenant column).
//   4. exempt    — listed in ERASURE_EXEMPTIONS with a category (and the category carries the reason).
// Every deletion-based mechanism (1-3) silently fails for a table that has a BEFORE DELETE trigger
// which raises (append-only ledgers): erase_user_rows() reports it as `blocked`. Such tables MUST be
// exempted explicitly so the retention decision is visible.
//
// Limits (heuristic, line/regex based — treat findings as "needs a human decision"):
//   * Only statements the regexes see: CREATE TABLE, ALTER TABLE ADD COLUMN / ADD FOREIGN KEY /
//     RENAME, DROP TABLE, CREATE/DROP TRIGGER, CREATE FUNCTION. Tables created dynamically inside
//     DO $$ ... EXECUTE format(...) blocks are invisible.
//   * "Personal data" is detected from column NAMES only. A table whose personal data lives in
//     free-text / jsonb columns without a tenant key will be classified `no_signal`.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Columns that identify a data subject directly. Name-based on purpose: conservative and auditable. */
export const PII_COLUMN =
  /^(email|phone|phone_number|phone_e164|mobile|first_name|last_name|full_name|display_name|date_of_birth|dob|ssn|address|street_address|address_line1|address1|ip|ip_address|user_agent|caller_number|from_number|to_number|transcript|recording_url|latitude|longitude)$|_(email|phone)$|^(contact|visitor|customer|requester|recipient|owner|signer)_(name|address)$/;

/** uuid columns that carry the tenant (= account owner user id) when a table has no `user_id`. */
export const TENANT_KEY_COLUMNS = new Set(['account_id', 'tenant_id', 'owner_id', 'account_owner_id', 'owner_user_id']);

/** Parents whose deletion is driven by account erasure (auth.users cascades to profiles). */
const ROOT_PARENTS = new Set(['users', 'profiles']);

export const stripSql = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let cur = '';
  let quote = false;
  for (const ch of body) {
    if (ch === "'") quote = !quote;
    if (!quote) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const IDENT = '"?(\\w+)"?';
const SCHEMA = '(?:(\\w+)\\.)?';

function addFk(table, col, parent, tail, isAuth) {
  table.fks.push({
    col,
    parent,
    cascade: /on\s+delete\s+cascade/i.test(tail),
    auth: isAuth,
  });
}

const INLINE_REF = new RegExp(`references\\s+${SCHEMA}${IDENT}\\s*(?:\\(\\s*"?\\w+"?\\s*\\))?([^,]*)`, 'i');

/**
 * Parses an ordered list of {name, sql} migrations into a model of the public schema.
 * @param {{name: string, sql: string}[]} files already sorted in apply order
 */
export function parseMigrations(files) {
  /** @type {Map<string, {cols: Map<string,string>, fks: Array<{col:string,parent:string,cascade:boolean,auth:boolean}>, file: string}>} */
  const tables = new Map();
  const functions = new Map(); // name -> body
  const triggers = new Map(); // `${table}|${name}` -> {table, name, fn}
  let rpcExcluded = null;

  for (const f of files) {
    const sql = stripSql(f.sql);

    // ---- functions (for trigger bodies + erase_user_rows exclusion list)
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\)\s*(?:returns|language|as|security|set|stable|volatile|immutable)[\s\S]*?\$(\w*)\$([\s\S]*?)\$\3\$/gi)) {
      functions.set(m[1].toLowerCase(), m[4]);
      if (m[1].toLowerCase() === 'erase_user_rows') {
        const ex = /p_exclude\s+text\[\]\s+default\s+array\s*\[([^\]]*)\]/i.exec(m[2]);
        if (ex) rpcExcluded = [...ex[1].matchAll(/'(\w+)'/g)].map((x) => x[1].toLowerCase());
      }
    }

    // ---- CREATE TABLE
    const createRe = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${SCHEMA}${IDENT}\\s*\\(`, 'gi');
    let m;
    while ((m = createRe.exec(sql))) {
      const schema = (m[1] ?? 'public').toLowerCase();
      let i = createRe.lastIndex;
      let depth = 1;
      let quote = false;
      const start = i;
      while (i < sql.length && depth > 0) {
        const ch = sql[i];
        if (ch === "'") quote = !quote;
        if (!quote) { if (ch === '(') depth++; if (ch === ')') depth--; }
        i++;
      }
      if (schema !== 'public') continue;
      const name = m[2].toLowerCase();
      if (!tables.has(name)) tables.set(name, { cols: new Map(), fks: [], file: f.name });
      const t = tables.get(name);
      for (const part of splitTopLevel(sql.slice(start, i - 1))) {
        const p = part.trim();
        const tableFk = /^(?:constraint\s+\S+\s+)?foreign\s+key\s*\(\s*"?(\w+)"?\s*\)\s*references\s+(?:(\w+)\.)?"?(\w+)"?/i.exec(p);
        if (tableFk) {
          addFk(t, tableFk[1].toLowerCase(), tableFk[3].toLowerCase(), p, (tableFk[2] ?? '').toLowerCase() === 'auth');
          continue;
        }
        const col = /^"?(\w+)"?\s+([\w[\]]+)/i.exec(p);
        if (!col || /^(constraint|primary|foreign|unique|check|exclude|like)$/i.test(col[1])) continue;
        const cname = col[1].toLowerCase();
        t.cols.set(cname, col[2].toLowerCase());
        const ref = INLINE_REF.exec(p);
        if (ref) addFk(t, cname, ref[2].toLowerCase(), ref[3] ?? '', (ref[1] ?? '').toLowerCase() === 'auth');
      }
    }

    // ---- ALTER TABLE
    const alterRe = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${SCHEMA}${IDENT}\\s+([\\s\\S]*?);`, 'gi');
    for (const a of sql.matchAll(alterRe)) {
      if ((a[1] ?? 'public').toLowerCase() !== 'public') continue;
      const name = a[2].toLowerCase();
      const body = a[3];
      const rename = new RegExp(`^rename\\s+to\\s+${IDENT}`, 'i').exec(body.trim());
      if (rename && tables.has(name)) {
        tables.set(rename[1].toLowerCase(), tables.get(name));
        tables.delete(name);
        continue;
      }
      if (!tables.has(name)) continue;
      const t = tables.get(name);
      const renameCol = /rename\s+column\s+"?(\w+)"?\s+to\s+"?(\w+)"?/i.exec(body);
      if (renameCol) {
        const from = renameCol[1].toLowerCase();
        const to = renameCol[2].toLowerCase();
        if (t.cols.has(from)) { t.cols.set(to, t.cols.get(from)); t.cols.delete(from); }
        for (const fk of t.fks) if (fk.col === from) fk.col = to;
      }
      for (const c of body.matchAll(/drop\s+column\s+(?:if\s+exists\s+)?"?(\w+)"?/gi)) {
        t.cols.delete(c[1].toLowerCase());
        t.fks = t.fks.filter((fk) => fk.col !== c[1].toLowerCase());
      }
      for (const c of body.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?\s+([\w[\]]+)([^,]*)/gi)) {
        const cname = c[1].toLowerCase();
        t.cols.set(cname, c[2].toLowerCase());
        const ref = INLINE_REF.exec(c[3]);
        if (ref) addFk(t, cname, ref[2].toLowerCase(), ref[3] ?? '', (ref[1] ?? '').toLowerCase() === 'auth');
      }
      const fk = /foreign\s+key\s*\(\s*"?(\w+)"?\s*\)\s*references\s+(?:(\w+)\.)?"?(\w+)"?([^;]*)/i.exec(body);
      if (fk) addFk(t, fk[1].toLowerCase(), fk[3].toLowerCase(), fk[4], (fk[2] ?? '').toLowerCase() === 'auth');
    }

    // ---- DROP TABLE
    const dropRe = new RegExp(`drop\\s+table\\s+(?:if\\s+exists\\s+)?${SCHEMA}${IDENT}`, 'gi');
    for (const d of sql.matchAll(dropRe)) {
      if ((d[1] ?? 'public').toLowerCase() === 'public') tables.delete(d[2].toLowerCase());
    }

    // ---- triggers (CREATE / DROP applied in file order: migrations usually DROP IF EXISTS then CREATE)
    const trgEvents = [];
    const trgRe = new RegExp(`create\\s+(?:or\\s+replace\\s+)?trigger\\s+${IDENT}\\s+(before|after|instead\\s+of)\\s+([\\s\\S]*?)\\s+on\\s+${SCHEMA}${IDENT}[\\s\\S]*?execute\\s+(?:function|procedure)\\s+(?:public\\.)?"?(\\w+)"?`, 'gi');
    for (const t of sql.matchAll(trgRe)) {
      if ((t[4] ?? 'public').toLowerCase() !== 'public') continue;
      if (!/before/i.test(t[2]) || !/delete/i.test(t[3])) continue;
      trgEvents.push({ at: t.index, op: 'create', table: t[5].toLowerCase(), name: t[1].toLowerCase(), fn: t[6].toLowerCase() });
    }
    const dropTrgRe = new RegExp(`drop\\s+trigger\\s+(?:if\\s+exists\\s+)?${IDENT}\\s+on\\s+${SCHEMA}${IDENT}`, 'gi');
    for (const d of sql.matchAll(dropTrgRe)) trgEvents.push({ at: d.index, op: 'drop', table: d[3].toLowerCase(), name: d[1].toLowerCase() });
    trgEvents.sort((a, b) => a.at - b.at);
    for (const e of trgEvents) {
      const key = `${e.table}|${e.name}`;
      if (e.op === 'create') triggers.set(key, { table: e.table, name: e.name, fn: e.fn });
      else triggers.delete(key);
    }
  }

  // Tables whose BEFORE DELETE trigger function can RAISE (append-only / immutability guards).
  const guarded = new Map(); // table -> trigger function names
  for (const t of triggers.values()) {
    if (!tables.has(t.table)) continue;
    if (!/raise\s+exception/i.test(functions.get(t.fn) ?? '')) continue;
    guarded.set(t.table, [...(guarded.get(t.table) ?? []), t.fn]);
  }
  return { tables, guarded, rpcExcluded: rpcExcluded ?? [] };
}

export function readMigrations(dir) {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

// ---------------------------------------------------------------------------
// Registry parsing (regex on literal-friendly TypeScript — CI runs on Node 20, no .ts import)
// ---------------------------------------------------------------------------

const sliceArray = (src, exportName) => {
  const m = new RegExp(`export\\s+const\\s+${exportName}\\b[^=]*=\\s*\\[`).exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  let quote = null;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (quote) { if (ch === quote && src[i - 1] !== '\\') quote = null; }
    else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '[') depth++;
    else if (ch === ']') depth--;
    i++;
  }
  return src.slice(start, i - 1);
};

/** Reads the registry exports of ownedTables.ts. Returns null for a missing export (= broken registry). */
export function parseRegistry(src) {
  const owned = sliceArray(src, 'OWNED_TABLES');
  const tenant = sliceArray(src, 'TENANT_KEYED_OWNED_TABLES');
  const exempt = sliceArray(src, 'ERASURE_EXEMPTIONS');
  const excluded = sliceArray(src, 'ERASURE_RPC_EXCLUDED');
  const categories = sliceArray(src, 'ERASURE_EXEMPTION_CATEGORIES');
  const cat = categories === null ? null : [...categories.matchAll(/id:\s*"(\w+)"/g)].map((m) => m[1]);
  const catReasons = categories === null ? new Map() : new Map(
    [...categories.matchAll(/id:\s*"(\w+)"[\s\S]*?reason:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2]]),
  );
  return {
    owned: owned === null ? null : [...owned.matchAll(/table:\s*"(\w+)"/g)].map((m) => m[1]),
    tenantKeyed: tenant === null ? null : [...tenant.matchAll(/table:\s*"(\w+)"\s*,\s*ownerColumn:\s*"(\w+)"/g)].map((m) => ({ table: m[1], ownerColumn: m[2] })),
    exemptions: exempt === null ? null : [...exempt.matchAll(/table:\s*"(\w+)"\s*,\s*category:\s*"(\w+)"(?:\s*,\s*note:\s*"((?:[^"\\]|\\.)*)")?/g)].map((m) => ({ table: m[1], category: m[2], note: m[3] ?? '' })),
    rpcExcluded: excluded === null ? null : [...excluded.matchAll(/"(\w+)"/g)].map((m) => m[1]),
    categories: cat,
    categoryReasons: catReasons,
  };
}

export function parseTrustTables(src) {
  return [...(/TRUST_TENANT_TABLES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(src)?.[1] ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Exemption categories whose precondition is verifiable from the migrations. */
const NEEDS_GUARD = new Set(['delete_guarded_ledger']);
/** Categories that are known open problems (reported; fail only with --strict). */
export const REMEDIATION_CATEGORY = 'needs_remediation';

export function personalColumns(cols) {
  return [...cols.keys()].filter((c) => PII_COLUMN.test(c));
}
export function tenantColumns(cols) {
  return [...cols].filter(([c, ty]) => TENANT_KEY_COLUMNS.has(c) && ty.startsWith('uuid')).map(([c]) => c);
}

/**
 * @returns {{rows: Array<{table:string,status:string,detail?:string}>, errors: string[], gaps: Array<{table:string,kind:string,detail:string}>, remediation: string[], counts: Record<string,number>}}
 */
export function classify(model, registry, trustTables = []) {
  const { tables, guarded } = model;
  const errors = [];
  const rows = [];
  const gaps = [];
  const remediation = [];

  // ---- registry sanity -------------------------------------------------------------------------
  for (const k of ['owned', 'tenantKeyed', 'exemptions', 'rpcExcluded', 'categories']) {
    if (registry[k] === null) errors.push(`ownedTables.ts: export for "${k}" is missing or unreadable`);
  }
  if (errors.length) return { rows, errors, gaps, remediation, counts: {} };

  const categories = new Set(registry.categories);
  const exemptByTable = new Map();
  for (const e of registry.exemptions) {
    if (exemptByTable.has(e.table)) errors.push(`ERASURE_EXEMPTIONS: duplicate entry for "${e.table}"`);
    exemptByTable.set(e.table, e);
    if (!categories.has(e.category)) errors.push(`ERASURE_EXEMPTIONS: "${e.table}" uses unknown category "${e.category}"`);
    const reason = (registry.categoryReasons.get(e.category) ?? '').trim();
    if (reason.length < 20 && e.note.trim().length < 20) errors.push(`ERASURE_EXEMPTIONS: "${e.table}" has no reason (category reason or note >= 20 chars)`);
    if (e.category === REMEDIATION_CATEGORY && e.note.trim().length < 20) errors.push(`ERASURE_EXEMPTIONS: "${e.table}" is needs_remediation and needs a note explaining the open problem`);
    if (!tables.has(e.table)) errors.push(`ERASURE_EXEMPTIONS: "${e.table}" does not exist in migrations — remove the stale entry`);
  }
  const ownedSet = new Set(registry.owned);
  const trustSet = new Set(trustTables);
  const tenantSet = new Map(registry.tenantKeyed.map((t) => [t.table, t.ownerColumn]));
  for (const t of registry.owned) {
    const def = tables.get(t);
    if (!def) errors.push(`OWNED_TABLES: "${t}" does not exist in migrations`);
    else if (!def.cols.get('user_id')?.startsWith('uuid')) errors.push(`OWNED_TABLES: "${t}" has no uuid user_id column (delete-account deletes by user_id)`);
    if (exemptByTable.has(t)) errors.push(`"${t}" is both in OWNED_TABLES and ERASURE_EXEMPTIONS`);
  }
  for (const [t, col] of tenantSet) {
    const def = tables.get(t);
    if (!def) errors.push(`TENANT_KEYED_OWNED_TABLES: "${t}" does not exist in migrations`);
    else if (!def.cols.get(col)?.startsWith('uuid')) errors.push(`TENANT_KEYED_OWNED_TABLES: "${t}.${col}" is not a uuid column`);
    if (!TENANT_KEY_COLUMNS.has(col)) errors.push(`TENANT_KEYED_OWNED_TABLES: "${t}" uses ownerColumn "${col}" which is not a known tenant column`);
    if (exemptByTable.has(t)) errors.push(`"${t}" is both in TENANT_KEYED_OWNED_TABLES and ERASURE_EXEMPTIONS`);
    if (ownedSet.has(t)) errors.push(`"${t}" is in both OWNED_TABLES and TENANT_KEYED_OWNED_TABLES`);
  }
  const wantExcluded = [...model.rpcExcluded].sort().join(',');
  const haveExcluded = [...registry.rpcExcluded].map((s) => s.toLowerCase()).sort().join(',');
  if (wantExcluded !== haveExcluded) {
    errors.push(`ERASURE_RPC_EXCLUDED (${haveExcluded || 'empty'}) differs from erase_user_rows() default p_exclude in migrations (${wantExcluded || 'not found'})`);
  }
  for (const t of model.rpcExcluded) {
    if (tables.has(t) && !exemptByTable.has(t) && !ownedSet.has(t)) {
      gaps.push({ table: t, kind: 'rpc_excluded_unregistered', detail: 'excluded from erase_user_rows() but has no exemption/owner entry' });
    }
  }

  // ---- classification ---------------------------------------------------------------------------
  const status = new Map();
  const covered = new Set(); // deletion-capable coverage (excludes exempt + guarded)
  const isSwept = (t) => tables.get(t).cols.get('user_id')?.startsWith('uuid') && !model.rpcExcluded.includes(t);

  const names = [...tables.keys()].sort();
  for (const t of names) {
    if (exemptByTable.has(t)) { status.set(t, 'exempt'); continue; }
    const g = guarded.get(t);
    const wouldCover = ownedSet.has(t) || trustSet.has(t) || tenantSet.has(t) || isSwept(t);
    if (wouldCover) {
      if (g) { status.set(t, 'GAP'); gaps.push({ table: t, kind: 'delete_guarded', detail: `BEFORE DELETE trigger function ${[...new Set(g)].join(', ')} can raise: erase_user_rows() reports it as blocked and rows survive erasure — add an exemption (delete_guarded_ledger) or fix the guard` }); continue; }
      status.set(t, ownedSet.has(t) || trustSet.has(t) ? 'owned' : tenantSet.has(t) ? 'owned_tenant' : 'swept');
      covered.add(t);
    }
  }
  // transitive cascade
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of names) {
      if (status.has(t)) continue;
      const def = tables.get(t);
      const viaFk = def.fks.some((fk) => {
        if (!fk.cascade) return false;
        const root = fk.auth || ROOT_PARENTS.has(fk.parent);
        if (root) return fk.col === 'user_id' || fk.col === 'id' || TENANT_KEY_COLUMNS.has(fk.col) || fk.col === 'profile_id';
        return covered.has(fk.parent);
      });
      if (!viaFk) continue;
      const g = guarded.get(t);
      if (g) { status.set(t, 'GAP'); gaps.push({ table: t, kind: 'delete_guarded', detail: `cascade-deleted child but BEFORE DELETE trigger function ${[...new Set(g)].join(', ')} can raise` }); changed = true; continue; }
      status.set(t, 'cascade');
      covered.add(t);
      changed = true;
    }
  }
  // remaining tables: personal-data signals decide
  for (const t of names) {
    if (status.has(t)) continue;
    const def = tables.get(t);
    const pii = personalColumns(def.cols);
    const tenant = tenantColumns(def.cols);
    if (pii.length === 0 && tenant.length === 0) { status.set(t, 'no_signal'); continue; }
    status.set(t, 'GAP');
    gaps.push({
      table: t,
      kind: 'unregistered_personal_data',
      detail: `${pii.length ? `personal columns: ${pii.join(', ')}` : ''}${pii.length && tenant.length ? ' | ' : ''}${tenant.length ? `tenant column(s) not swept by erase_user_rows: ${tenant.join(', ')}` : ''}`,
    });
  }

  // exemption preconditions (after classification so we can detect redundant entries)
  for (const e of registry.exemptions) {
    if (!tables.has(e.table)) continue;
    if (NEEDS_GUARD.has(e.category) && !guarded.has(e.table)) errors.push(`ERASURE_EXEMPTIONS: "${e.table}" is delete_guarded_ledger but no raising BEFORE DELETE trigger was found — remove or recategorise`);
    if (e.category === REMEDIATION_CATEGORY) remediation.push(e.table);
  }

  const counts = {};
  for (const t of names) {
    const s = status.get(t);
    counts[s] = (counts[s] ?? 0) + 1;
    rows.push({ table: t, status: s });
  }
  gaps.sort((a, b) => a.table.localeCompare(b.table));
  return { rows, errors, gaps, remediation: remediation.sort(), counts };
}
