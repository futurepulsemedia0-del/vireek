// Release-safety rules for NEW migrations (expand/contract policy). Pure: SQL text in, issues out.
// Opt out per file with a comment:  -- lint:allow-blocking <reason>
// Every new migration needs a rollback note:  -- rollback: <how to undo>

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const stripStrings = (s) => s.replace(/'(?:[^']|'')*'/g, "''");
const stripDollar = (s) => s.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' $$ ');

const IDENT = '(?:public\\.)?"?([a-z0-9_]+)"?';

/** @returns {string[]} human-readable problems (empty = ok) */
export function checkMigrationSql(raw) {
  const issues = [];
  if (!/^\s*--\s*rollback:\s*\S/im.test(raw) && !/\/\*[\s\S]*?\n\s*--\s*rollback:/i.test(raw)) {
    issues.push('missing rollback note. Add a line: -- rollback: <how to undo this migration safely>');
  }
  if (/--\s*lint:allow-blocking\b/i.test(raw)) return issues;

  const code = stripDollar(stripStrings(stripComments(raw)));
  const statements = code.split(';').map((s) => s.trim()).filter(Boolean);
  const createdHere = new Set(
    [...code.matchAll(new RegExp(`\\bcreate\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${IDENT}`, 'gi'))].map((m) => m[1].toLowerCase()),
  );
  const onNewTable = (stmt, re) => {
    const m = re.exec(stmt);
    return m ? createdHere.has(m[1].toLowerCase()) : false;
  };

  for (const stmt of statements) {
    const idx = /^create\s+(unique\s+)?index\s+(concurrently\s+)?/i.exec(stmt);
    if (idx) {
      const concurrently = Boolean(idx[2]);
      if (concurrently && statements.length > 1) {
        issues.push('CREATE INDEX CONCURRENTLY cannot run in a multi-statement migration (it runs in a transaction). Put it alone in its own migration file.');
      }
      if (!concurrently && !onNewTable(stmt, new RegExp(`\\bon\\s+(?:only\\s+)?${IDENT}`, 'i'))) {
        issues.push('CREATE INDEX on an existing table blocks writes. Use CREATE INDEX CONCURRENTLY in its own migration file.');
      }
      continue;
    }
    if (!/^alter\s+table\b/i.test(stmt)) continue;
    const table = new RegExp(`^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${IDENT}`, 'i').exec(stmt);
    if (table && createdHere.has(table[1].toLowerCase())) continue;

    for (const part of stmt.split(/,(?![^(]*\))/)) {
      const add = /\badd\s+column\b(?:\s+if\s+not\s+exists)?\s+"?[a-z0-9_]+"?\s+([^]*)$/i.exec(part);
      if (add && /\bnot\s+null\b/i.test(add[1]) && !/\bdefault\b/i.test(add[1])) {
        issues.push('ADD COLUMN ... NOT NULL without DEFAULT fails/locks on populated tables. Expand first (nullable or with DEFAULT), backfill, then constrain.');
      }
      if (/\balter\s+column\b[^]*\bset\s+not\s+null\b/i.test(part)) {
        issues.push('SET NOT NULL scans the table under lock. Add CHECK (col IS NOT NULL) NOT VALID, VALIDATE it, then SET NOT NULL.');
      }
      if (/\badd\s+constraint\b[^]*\b(check|foreign\s+key)\b/i.test(part) && !/\bnot\s+valid\b/i.test(part)) {
        issues.push('ADD CONSTRAINT (CHECK/FOREIGN KEY) without NOT VALID validates under lock. Add NOT VALID, then VALIDATE CONSTRAINT in a later migration.');
      }
    }
  }
  return [...new Set(issues)];
}
