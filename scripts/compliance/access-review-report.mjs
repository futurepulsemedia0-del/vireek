#!/usr/bin/env node
// scripts/compliance/access-review-report.mjs
//
// Renders the quarterly staff access review from the JSON produced by
//   select public.staff_access_review_report(<year>, <quarter>);
// (migration 20290307000000_staff_insider_risk.sql). The database returns FACTS; this script adds the
// review flags and a sign-off block that is deliberately left blank. It never signs, never attests,
// and never claims that a review took place.
//
//   psql "$DATABASE_URL" -At -c "select public.staff_access_review_report(2026, 4)" > review.json
//   node scripts/compliance/access-review-report.mjs review.json --out docs/compliance/access-reviews/2026-Q4.md
//   node scripts/compliance/access-review-report.mjs review.json --strict     # exit 1 when any flag is raised
//
// Exit codes: 0 ok · 1 flags raised with --strict · 2 unusable input.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA = 'vireek.access-review/v1';
export const DORMANT_DAYS = 90;

/** Flag catalogue: id -> reviewer-facing meaning. Keep in sync with docs/compliance/insider-risk-monitoring.md. */
export const FLAGS = Object.freeze({
  no_verified_mfa: 'No verified MFA factor enrolled',
  dormant: `No sign-in for ${DORMANT_DAYS}+ days (or never): consider removing staff access`,
  not_active: 'Staff flag set on an account whose status is not "active"',
  open_alerts: 'Open insider-risk alerts about this account',
  sessions_without_ticket: 'Impersonation sessions without a ticket reference',
  staff_exports: 'Exports of customer data performed by this account',
});

const isRec = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const toInt = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : 0);
const str = (v) => (typeof v === 'string' ? v : '');
const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Throws a plain Error with a reviewer-readable message when the input is not a usable report. */
export function parseReport(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { throw new Error('input is not valid JSON'); }
  }
  if (!isRec(data)) throw new Error('report must be a JSON object');
  if (data.schema !== SCHEMA) throw new Error(`unsupported schema "${String(data.schema)}" (expected ${SCHEMA})`);
  if (!isRec(data.period) || !Number.isInteger(data.period.year) || !Number.isInteger(data.period.quarter)) throw new Error('report.period is missing');
  if (!Array.isArray(data.staff)) throw new Error('report.staff must be an array');
  return data;
}

/** Reference date for "dormant": the end of the period, or now when the period is still running. */
function referenceDate(report, now) {
  const end = Date.parse(str(report.period.to));
  return Number.isFinite(end) ? new Date(Math.min(end, now.getTime())) : now;
}

/** Returns the list of flag ids for one staff row. Pure. */
export function evaluateStaff(row, ref) {
  const flags = [];
  if (toInt(row.mfa_verified_factors) === 0) flags.push('no_verified_mfa');
  const last = Date.parse(str(row.last_sign_in_at));
  if (!Number.isFinite(last) || (ref.getTime() - last) / 86_400_000 > DORMANT_DAYS) flags.push('dormant');
  if (str(row.status) !== 'active') flags.push('not_active');
  if (toInt(row.alerts_open) > 0) flags.push('open_alerts');
  if (toInt(row.sessions_without_ticket) > 0) flags.push('sessions_without_ticket');
  if (toInt(row.sensitive_export_events) > 0) flags.push('staff_exports');
  return flags;
}

export function summarise(report, now = new Date()) {
  const ref = referenceDate(report, now);
  const rows = report.staff.filter(isRec).map((r) => ({ row: r, flags: evaluateStaff(r, ref) }));
  const flagged = rows.filter((r) => r.flags.length > 0);
  return { rows, flagged, flagCount: rows.reduce((n, r) => n + r.flags.length, 0) };
}

const MANUAL_CHECKS = [
  'GitHub organisation members, owners and deploy keys',
  'Hosting console (Cloudflare Workers / Vercel: whichever serves production) [VERIFY]',
  'Supabase organisation members and project roles',
  'Stripe, Twilio, Vapi and other provider-console users',
  'Shared secrets or credentials held by anyone who has left or changed role (see docs/compliance/policies/secrets-key-rotation.md)',
];

export function renderMarkdown(reportInput, now = new Date()) {
  const report = parseReport(reportInput);
  const { rows, flagged, flagCount } = summarise(report, now);
  const { year, quarter } = report.period;
  const out = [];
  const push = (...l) => out.push(...l);

  push(`# Staff access review: ${year} Q${quarter}`, '');
  push('> **DRAFT: not signed.** Generated from the database by `public.staff_access_review_report`. It lists facts and review flags. It is not evidence that a review took place until a named reviewer completes and signs the section at the end, and it makes no compliance claim.', '');
  push(`- Period (UTC): ${str(report.period.from).slice(0, 10)} to ${str(report.period.to).slice(0, 10)} (end exclusive)`);
  push(`- Generated at: ${str(report.generated_at) || 'unknown'}`);
  push(`- Staff accounts in scope: ${rows.length} · with at least one flag: ${flagged.length} · flags raised: ${flagCount}`);
  push(`- Open insider-risk alerts raised in earlier periods and still unresolved: ${toInt(report.open_alerts_from_earlier_periods)}`, '');

  push('## 1. Staff accounts', '');
  if (rows.length === 0) {
    push('_No account has `profiles.is_staff = true`. Confirm this is expected before signing._', '');
  } else {
    push('| Account | Role | Status | Last sign-in | MFA factors | Sessions | Accounts | No ticket | Audit actions | Records read | Exports | Alerts (period / open) | Flags |');
    push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const { row, flags } of rows) {
      const actions = isRec(row.staff_audit_actions)
        ? Object.entries(row.staff_audit_actions).map(([k, v]) => `${k}: ${toInt(v)}`).join(', ') || 'none'
        : 'none';
      push(`| ${cell(row.email)} | ${cell(row.role)} | ${cell(row.status)} | ${cell(str(row.last_sign_in_at).slice(0, 10) || 'never')} | ${toInt(row.mfa_verified_factors)} | ${toInt(row.impersonation_sessions)} | ${toInt(row.impersonated_accounts)} | ${toInt(row.sessions_without_ticket)} | ${cell(actions)} | ${toInt(row.sensitive_read_records)} | ${toInt(row.sensitive_export_events)} | ${toInt(row.alerts_in_period)} / ${toInt(row.alerts_open)} | ${flags.length ? flags.join(', ') : '-'} |`);
    }
    push('');
  }

  push('## 2. Flags', '');
  push('| Flag | Meaning |', '|---|---|');
  for (const [id, text] of Object.entries(FLAGS)) push(`| \`${id}\` | ${text} |`);
  push('');

  push('## 3. Insider-risk alerts in the period', '');
  const alerts = Array.isArray(report.alerts_by_rule) ? report.alerts_by_rule.filter(isRec) : [];
  if (alerts.length === 0) {
    push('_No alerts were raised in this period. This can also mean detection was not scheduled: confirm the `staff-insider-detect` cron job exists._', '');
  } else {
    push('| Rule | Severity | Status | Count |', '|---|---|---|---|');
    for (const a of alerts) push(`| ${cell(a.rule)} | ${cell(a.severity)} | ${cell(a.status)} | ${toInt(a.count)} |`);
    push('');
  }

  push('## 4. Platform access snapshot', '');
  const pa = isRec(report.platform_access) ? report.platform_access : {};
  const scim = isRec(pa.scim) ? pa.scim : {};
  push(`- SCIM tokens: ${toInt(scim.active)} active, ${toInt(scim.revoked)} revoked, ${toInt(scim.active_unused_90d)} active but unused for ${DORMANT_DAYS}+ days`);
  push(`- Custom roles defined: ${toInt(pa.custom_roles)}`);
  const byRole = Array.isArray(pa.profiles_by_role) ? pa.profiles_by_role.filter(isRec) : [];
  if (byRole.length) push(`- Account profiles by role/status: ${byRole.map((r) => `${cell(r.role)}/${cell(r.status)} ${toInt(r.count)}`).join('; ')}`);
  push('');

  push('## 5. Outside the database (manual)', '');
  push('Tick only what you actually checked in the live console. Unticked means not done.', '');
  for (const m of MANUAL_CHECKS) push(`- [ ] ${m}`);
  push('');

  push('## 6. Decisions', '');
  push('| Account | Decision (keep / reduce / remove) | Reason | Done on |', '|---|---|---|---|');
  for (const { row } of flagged.length ? flagged : rows) push(`| ${cell(row.email)} |  |  |  |`);
  push('');

  push('## 7. Sign-off', '');
  push('The reviewer must not be an account listed in section 1 (no one approves their own access). If that is impossible, record who reviews the reviewer.', '');
  push('- Reviewer (name, role): ');
  push('- Reviewed on: ');
  push('- [ ] I am not listed in section 1 / reviewer-of-reviewer recorded: ');
  push('- Evidence location of this signed file: ');
  push('');
  return out.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const strict = args.includes('--strict');
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const nowIdx = args.indexOf('--now');
  const now = nowIdx >= 0 ? new Date(args[nowIdx + 1]) : new Date();
  const skip = new Set([outIdx + 1, nowIdx + 1].filter((i) => i > 0));
  const input = args.find((a, i) => !a.startsWith('--') && !skip.has(i));
  if (!input || Number.isNaN(now.getTime()) || (outIdx >= 0 && !outPath)) {
    console.error('usage: access-review-report.mjs <report.json|-> [--out file.md] [--strict] [--now ISO-date]');
    return 2;
  }
  let report;
  try {
    report = parseReport(readFileSync(input === '-' ? 0 : input, 'utf8').trim());
  } catch (e) {
    console.error(`access-review-report: ${e.message}`);
    return 2;
  }
  const md = renderMarkdown(report, now);
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, md);
    console.log(`wrote ${outPath}`);
  } else {
    process.stdout.write(md);
  }
  const { flagCount } = summarise(report, now);
  if (strict && flagCount > 0) {
    console.error(`::error::${flagCount} access review flag(s) raised`);
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv));
