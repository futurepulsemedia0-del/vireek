// OSHA recordkeeping (roadmap item 109). Executes the pure TypeScript core and STATICALLY checks the SQL.
// What this does NOT prove: that the SQL runs, or that RLS holds against a live database. Those need a Postgres
// (see docs/safety/osha-recordkeeping.md, "Database verification").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CLASSIFICATIONS, ILLNESS_TYPES, PRIVACY_REASONS, validateCaseInput, computeRetainUntil, isPastRetention, logName, logToCsv,
  summaryToCsv, caseDraftFromIncident, parseWholeNumber, summaryMissingLabels, MIN_RETENTION_YEARS,
} from '../../src/lib/osha/core.ts';

const sql = readFileSync(new URL('../../supabase/migrations/20290312000000_osha_recordkeeping.sql', import.meta.url), 'utf8');
const NOW = new Date(2027, 2, 10);
const ok = { employee_name: 'A B', job_title: 'Installer', description: 'Cut hand on sheet metal', date_of_injury: '2027-03-01', classification: 'other_recordable', illness_type: 'injury' };

test('valid input passes; each missing required field is reported', () => {
  assert.deepEqual(validateCaseInput(ok, NOW), []);
  assert.equal(validateCaseInput({ ...ok, employee_name: ' ' }, NOW).length, 1);
  assert.equal(validateCaseInput({ ...ok, job_title: '' }, NOW).length, 1);
  assert.equal(validateCaseInput({ ...ok, description: 'x' }, NOW).length, 1);
});
test('future and malformed injury dates are rejected', () => {
  assert.match(validateCaseInput({ ...ok, date_of_injury: '2027-03-11' }, NOW)[0], /future/);
  assert.match(validateCaseInput({ ...ok, date_of_injury: '03/01/2027' }, NOW)[0], /valid date/);
  assert.equal(validateCaseInput({ ...ok, date_of_injury: '2027-03-10' }, NOW).length, 0);
});
test('death requires a date of death not before the injury', () => {
  assert.equal(validateCaseInput({ ...ok, classification: 'death' }, NOW).length, 1);
  assert.equal(validateCaseInput({ ...ok, classification: 'death', died_on: '2027-02-01' }, NOW).length, 1);
  assert.equal(validateCaseInput({ ...ok, classification: 'death', died_on: '2027-03-05' }, NOW).length, 0);
});
test('day counts are whole numbers 0..180', () => {
  for (const bad of [-1, 181, 1.5, Number.NaN]) assert.equal(validateCaseInput({ ...ok, days_away: bad }, NOW).length, 1, String(bad));
  assert.equal(validateCaseInput({ ...ok, days_away: 180, days_restricted: 0 }, NOW).length, 0);
});
test('privacy reason requires privacy case', () => {
  assert.equal(validateCaseInput({ ...ok, privacy_reason: 'mental_illness' }, NOW).length, 1);
  assert.equal(validateCaseInput({ ...ok, privacy_case: true, privacy_reason: 'mental_illness' }, NOW).length, 0);
});
test('retention: Dec 31 of the case year + years, never below 5', () => {
  assert.equal(computeRetainUntil(2026, 5), '2031-12-31');
  assert.equal(computeRetainUntil(2026, 1), `${2026 + MIN_RETENTION_YEARS}-12-31`);
  assert.equal(computeRetainUntil(2026, 7), '2033-12-31');
  assert.equal(isPastRetention('2031-12-31', '2032-01-01'), true);
  assert.equal(isPastRetention('2031-12-31', '2031-12-31'), false);
});
test('privacy cases are masked in names and CSV', () => {
  assert.equal(logName({ employee_name: 'Jane Roe', privacy_case: true }), 'Privacy Case');
  const row = { case_no: '2027-001', employee_name: 'Jane Roe', job_title: 'Tech', date_of_injury: '2027-03-01', location_where: null, description: 'd', classification: 'days_away', days_away: 3, days_restricted: 0, illness_type: 'injury', privacy_case: true };
  const csv = logToCsv([row]);
  assert.ok(!csv.includes('Jane Roe'));
  assert.ok(csv.includes('Privacy Case'));
  assert.equal(csv.split('\r\n').length, 2);
});
test('CSV neutralises spreadsheet formulas in free text', () => {
  const row = { case_no: '2027-002', employee_name: 'X', job_title: 'T', date_of_injury: '2027-03-01', location_where: null, description: '=HYPERLINK("http://evil")', classification: 'other_recordable', days_away: 0, days_restricted: 0, illness_type: 'injury', privacy_case: false };
  assert.ok(logToCsv([row]).includes(`"'=HYPERLINK`));
});
test('summary CSV leaves missing inputs empty, not zero', () => {
  const totals = Object.fromEntries(['deaths', 'days_away_cases', 'job_transfer_cases', 'other_recordable_cases', 'total_days_away', 'total_days_restricted', 'injuries', 'skin_disorders', 'respiratory_conditions', 'poisonings', 'hearing_loss', 'other_illnesses', 'total_cases'].map((k) => [k, 0]));
  const csv = summaryToCsv({ year: 2027, establishment: null, avg_employees: null, total_hours: null, totals, certification: null, missing: ['avg_employees'] });
  assert.match(csv, /Annual average number of employees,\r?\n/);
  assert.deepEqual(summaryMissingLabels(['total_hours']), ['Total hours worked by all employees']);
});
test('incident prefill and number parsing', () => {
  const d = caseDraftFromIncident({ id: 'i1', occurred_at: '2027-03-01T12:00:00Z', description: 'x'.repeat(3000) });
  assert.equal(d.incident_id, 'i1');
  assert.equal(d.description.length, 2000);
  assert.equal(parseWholeNumber('1,250', 1e6), 1250);
  assert.equal(parseWholeNumber('12.5', 1e6), null);
  assert.equal(parseWholeNumber('-3', 1e6), null);
  assert.equal(parseWholeNumber('2000000', 1e6), null);
});

// ---- TS <-> SQL drift ----
const sqlList = (col) => {
  const m = sql.match(new RegExp(`${col} text[^\\n]*?IN \\(([^)]*)\\)`));
  assert.ok(m, col);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
};
test('allowed values in TypeScript match the SQL CHECK constraints', () => {
  assert.deepEqual(sqlList('classification'), [...CLASSIFICATIONS]);
  assert.deepEqual(sqlList('illness_type'), [...ILLNESS_TYPES]);
  const priv = sql.match(/privacy_reason text CHECK \(privacy_reason IS NULL OR privacy_reason IN\s*\(([^)]*)\)/);
  assert.deepEqual([...priv[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]), [...PRIVACY_REASONS]);
});

// ---- static SQL security checks ----
const TABLES = ['osha_settings', 'osha_cases', 'osha_case_counters', 'osha_annual_summaries', 'osha_audit_events'];
test('every table has RLS enabled', () => {
  for (const t of TABLES) assert.match(sql, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`), t);
});
test('readable tables have a manager-only, tenant-scoped SELECT policy; the counter has none', () => {
  for (const t of TABLES.filter((x) => x !== 'osha_case_counters')) {
    const m = sql.match(new RegExp(`CREATE POLICY "[a-z_]+" ON ${t} FOR SELECT TO authenticated\\s+USING \\(([^;]*)\\);`));
    assert.ok(m, t);
    assert.match(m[1], /get_account_owner_id\(\)/);
    assert.match(m[1], /safety_can_manage\(\)/);
  }
  assert.ok(!/CREATE POLICY[^;]*ON osha_case_counters/.test(sql));
  assert.match(sql, /REVOKE ALL ON osha_case_counters FROM anon, authenticated/);
});
test('no policy allows client writes, and writes are revoked', () => {
  assert.ok(!/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)\b/.test(sql.replace(/\/\*[\s\S]*?\*\//g, '')));
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON osha_settings, osha_cases, osha_annual_summaries, osha_audit_events FROM anon, authenticated/);
});
test('every function is SECURITY DEFINER with a pinned search_path and is not executable by PUBLIC/anon', () => {
  const fns = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(([^)]*)\)([\s\S]*?)\n\$\$;/g)];
  assert.ok(fns.length >= 12);
  for (const [, name, args, body] of fns) {
    assert.match(body, /SECURITY DEFINER/, name);
    assert.match(body, /SET search_path = public/, name);
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon`), name);
    if (!name.startsWith('_')) assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO authenticated`), name);
  }
});
test('public RPCs go through the manager guard', () => {
  const pub = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(osha_\w+)\([^)]*\)([\s\S]*?)\n\$\$;/g)];
  for (const [, name, body] of pub) assert.match(body, /v_owner uuid := public\._osha_owner\(\)/, name);
});
test('migration is idempotent in shape and never deletes OSHA cases', () => {
  assert.ok(!/CREATE TABLE (?!IF NOT EXISTS)/.test(sql));
  assert.ok(!/DELETE FROM osha_cases/i.test(sql));
  assert.match(sql, /retention_years integer NOT NULL DEFAULT 5 CHECK \(retention_years BETWEEN 5 AND 30\)/);
  assert.match(sql, /incident_id uuid REFERENCES safety_incidents\(id\) ON DELETE SET NULL/);
});
