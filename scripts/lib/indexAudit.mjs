// Static, read-only heuristic: tenant-scoped tables (user_id / account_owner_id) with no index or key whose
// LEADING column is the tenant column. Every RLS policy and nearly every query filters by that column, so a
// missing leading index means a scan per request as the table grows.
// Limits: regex-based (no SQL parser); indexes created through dynamic SQL (DO $$ ... format()) are invisible.
// Treat the output as a review list, then confirm with EXPLAIN on real data.

const TENANT_COLS = ['user_id', 'account_owner_id'];
const ident = '"?([a-z_][a-z0-9_]*)"?';

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function balancedBody(sql, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')' && --depth === 0) return sql.slice(openIdx + 1, i);
  }
  return null;
}

const splitTop = (body) => {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim());
};

/** @param {string[]} sqlFiles contents in migration order. @returns {{tables: Map<string,{cols:Set<string>, leading:Set<string>}>}} */
export function scan(sqlFiles) {
  const tables = new Map();
  const get = (t) => tables.get(t) ?? (tables.set(t, { cols: new Set(), leading: new Set() }), tables.get(t));

  for (const raw of sqlFiles) {
    const sql = stripComments(raw).toLowerCase();

    for (const m of sql.matchAll(new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?${ident}\\s*\\(`, 'g'))) {
      const t = get(m[1]);
      const body = balancedBody(sql, m.index + m[0].length - 1) ?? '';
      for (const part of splitTop(body)) {
        const col = /^"?([a-z_][a-z0-9_]*)"?\s+\S/.exec(part);
        if (col && !/^(primary|unique|foreign|constraint|check|exclude|like)$/.test(col[1])) {
          t.cols.add(col[1]);
          if (TENANT_COLS.includes(col[1]) && /\b(primary\s+key|unique)\b/.test(part)) t.leading.add(col[1]);
        }
        const key = /(?:primary\s+key|unique)\s*\(\s*"?([a-z_][a-z0-9_]*)"?/.exec(part);
        if (key && TENANT_COLS.includes(key[1])) t.leading.add(key[1]);
      }
    }
    for (const m of sql.matchAll(new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:public\\.)?${ident}\\s+([^;]*)`, 'g'))) {
      for (const c of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/g)) get(m[1]).cols.add(c[1]);
    }
    for (const m of sql.matchAll(new RegExp(`create\\s+(?:unique\\s+)?index\\s+(?:concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?\\S+\\s+on\\s+(?:only\\s+)?(?:public\\.)?${ident}\\s*(?:using\\s+\\w+\\s*)?\\(\\s*"?([a-z_][a-z0-9_]*)"?`, 'g'))) {
      if (TENANT_COLS.includes(m[2])) get(m[1]).leading.add(m[2]);
    }
    for (const m of sql.matchAll(new RegExp(`drop\\s+table\\s+(?:if\\s+exists\\s+)?(?:public\\.)?${ident}`, 'g'))) tables.delete(m[1]);
  }
  return { tables };
}

/** Tenant-scoped tables with no index/key that leads with the tenant column. */
export function findGaps({ tables }) {
  const scoped = [];
  const gaps = [];
  for (const [name, t] of tables) {
    const tenantCol = TENANT_COLS.find((c) => t.cols.has(c));
    if (!tenantCol) continue;
    scoped.push(name);
    if (!t.leading.has(tenantCol)) gaps.push({ table: name, column: tenantCol });
  }
  return { scopedCount: scoped.length, gaps: gaps.sort((a, b) => a.table.localeCompare(b.table)) };
}
