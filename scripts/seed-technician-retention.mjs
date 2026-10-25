#!/usr/bin/env node
// scripts/seed-technician-retention.mjs
//
// Demo data for the Technician Retention Engine page: six fictional technicians
// (@demo.vireek.invalid), eight weeks of scores, suggested + approved actions.
// The weekly engine ignores these technicians, so demo data never mixes with real scores.
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service key> \
//     node scripts/seed-technician-retention.mjs --email owner@yourcompany.com
//   ... --clean     removes the demo technicians and everything attached to them
//
// Safe to re-run: it removes the previous demo set first.

import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = opt('email');
if (!url || !key || !email) {
  console.error('Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed-technician-retention.mjs --email owner@company.com [--clean]');
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });
const DAY = 86_400_000;
const DEMO_DOMAIN = '@demo.vireek.invalid';

const fail = (what, error) => { console.error(`✗ ${what}: ${error.message}`); process.exit(1); };

const { data: profile, error: pErr } = await db.from('profiles').select('id').ilike('email', email).maybeSingle();
if (pErr) fail('lookup owner', pErr);
if (!profile) { console.error(`✗ No account found for ${email}`); process.exit(1); }
const owner = profile.id;

// Remove any previous demo set (scores, actions and freezes cascade).
{
  const { error } = await db.from('team_members').delete().eq('account_owner_id', owner).like('member_email', `%${DEMO_DOMAIN}`);
  if (error) fail('clean demo technicians', error);
}
if (flag('clean')) { console.log('✓ Demo technicians removed.'); process.exit(0); }

const prob = (s) => Math.round(Math.min(0.6, Math.max(0, 0.08 + 0.0052 * s)) * 1000) / 1000;
const cost = (days) => (days < 365 ? 15000 : days < 1095 ? 20000 : 25000);
const band = (s) => (s >= 50 ? 'high' : s >= 25 ? 'elevated' : 'low');
const monday = (weeksAgo) => {
  const d = new Date();
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day - weeksAgo * 7)).toISOString().slice(0, 10);
};

const D = {
  same_day_changes: (points, count, perWeek) => ({ key: 'same_day_changes', points, severity: 80, params: { count, perWeek }, message: `${count} jobs moved within 24 hours of the start time (${perWeek} per week).` }),
  on_call_load: (points, days, avg) => ({ key: 'on_call_load', points, severity: 75, params: { days, avg, ratio: Math.round((days / avg) * 10) / 10 }, message: `${days} days on call vs a team average of ${avg}.` }),
  overtime: (points, hours, perWeek) => ({ key: 'overtime', points, severity: 70, params: { hours, perWeek }, message: `${hours} overtime hours (${perWeek} per week).` }),
  earnings_trend: (points, dropPct) => ({ key: 'earnings_trend', points, severity: 85, params: { dropPct, recent: 3800, prior: 6100 }, message: `Earnings are down ${dropPct}% over the last 4 weeks compared with the 4 weeks before.` }),
  unanswered_requests: (points, count, total) => ({ key: 'unanswered_requests', points, severity: 70, params: { count, total, perWeek: Math.round((count / 8) * 10) / 10 }, message: `${count} of ${total} requests to the office got no reply within 4 hours.` }),
  callback_rate: (points, count, jobs) => ({ key: 'callback_rate', points, severity: 60, params: { count, jobs, ratePct: Math.round((count / jobs) * 1000) / 10 }, message: `${count} callbacks on ${jobs} completed jobs (${Math.round((count / jobs) * 1000) / 10}%).` }),
  unpaid_time: (points, hours) => ({ key: 'unpaid_time', points, severity: 55, params: { hours, perWeek: Math.round((hours / 8) * 10) / 10 }, message: `${hours} worked hours were rejected and not paid (${Math.round((hours / 8) * 10) / 10} per week).` }),
};

const TECHS = [
  { name: 'Marcus Reyes', slug: 'marcus', tenure: 1400, history: [38, 44, 49, 55, 58, 62, 66, 68], drivers: [D.same_day_changes(26, 31, 3.9), D.on_call_load(22, 21, 9), D.overtime(20, 58, 7.3)] },
  { name: 'Dana Whitfield', slug: 'dana', tenure: 1100, history: [30, 33, 38, 41, 44, 47, 50, 52], drivers: [D.earnings_trend(20, 38), D.unanswered_requests(18, 9, 14), D.callback_rate(14, 6, 41)] },
  { name: 'Luis Ortega', slug: 'luis', tenure: 600, history: [18, 20, 22, 25, 27, 30, 31, 33], drivers: [D.overtime(15, 36, 4.5), D.unpaid_time(10, 14), D.same_day_changes(8, 12, 1.5)] },
  { name: 'Priya Nair', slug: 'priya', tenure: 900, history: [14, 13, 12, 12, 11, 12, 12, 12], drivers: [] },
  { name: 'Sam Carter', slug: 'sam', tenure: 300, history: [20, 22, 19, 18, 18, 17, 18, 18], drivers: [] },
  { name: 'Jordan Lee', slug: 'jordan', tenure: 12, history: [], drivers: [], insufficient: true },
];

const { data: techRows, error: tErr } = await db.from('team_members').insert(
  TECHS.map((t) => ({
    account_owner_id: owner, member_email: `${t.slug}${DEMO_DOMAIN}`, member_name: t.name, role: 'technician',
    invite_status: 'active', created_at: new Date(Date.now() - t.tenure * DAY).toISOString(),
  })),
).select('id, member_email');
if (tErr) fail('create demo technicians', tErr);
const idBySlug = Object.fromEntries(techRows.map((r) => [r.member_email.split('@')[0], r.id]));

const scoreRows = [];
for (const t of TECHS) {
  const tech_id = idBySlug[t.slug];
  if (t.insufficient) {
    scoreRows.push({ user_id: owner, tech_id, week: monday(0), score: 0, risk_band: 'insufficient', data_quality: 'insufficient', confidence: 0, top_drivers: [], signals: {}, attrition_probability: 0.18, est_replacement_cost: cost(t.tenure), expected_annual_cost: Math.round(0.18 * cost(t.tenure)), score_delta: null, is_demo: true });
    continue;
  }
  t.history.forEach((score, i) => {
    const weeksAgo = t.history.length - 1 - i;
    const latest = weeksAgo === 0;
    const p = prob(score);
    scoreRows.push({
      user_id: owner, tech_id, week: monday(weeksAgo), score, risk_band: band(score), data_quality: 'ok', confidence: 1,
      top_drivers: latest ? t.drivers : [], signals: {}, attrition_probability: p,
      est_replacement_cost: cost(t.tenure), expected_annual_cost: Math.round(p * cost(t.tenure)),
      score_delta: i === 0 ? null : score - t.history[i - 1], is_demo: true,
    });
  });
}
const { data: savedScores, error: sErr } = await db.from('tech_risk_scores').insert(scoreRows).select('id, tech_id, week');
if (sErr) fail('create demo scores', sErr);
const latestWeek = monday(0);
const scoreId = (slug) => savedScores.find((s) => s.tech_id === idBySlug[slug] && s.week === latestWeek)?.id ?? null;

const act = (slug, type, driver_key, title, detail, extra = {}) => ({
  user_id: owner, tech_id: idBySlug[slug], score_id: scoreId(slug), action_type: type, driver_key, title, detail,
  params: { name: TECHS.find((t) => t.slug === slug).name }, is_demo: true, ...extra,
});
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

const actions = [
  act('marcus', 'freeze_schedule', 'same_day_changes', "Freeze Marcus Reyes's schedule for the next 48 hours", '31 jobs moved within 24 hours of the start time (3.9 per week). Only an emergency should move his jobs; you can lift the freeze at any time.'),
  act('marcus', 'rebalance_on_call', 'on_call_load', 'Rebalance the on-call rotation for Marcus Reyes', '21 days on call vs a team average of 9. Review the rotation so on-call days are shared more evenly.', { status: 'approved', baseline_score: 74, score_after: 68, outcome: 'improved', decided_at: ago(11), outcome_checked_at: ago(2) }),
  act('dana', 'manager_one_on_one', 'earnings_trend', 'Hold a 1:1 check-in with Dana Whitfield', 'Earnings are down 38% over the last 4 weeks compared with the 4 weeks before. Ask what is getting in the way and what would help.'),
  act('dana', 'clear_office_backlog', 'unanswered_requests', 'Clear the office backlog for Dana Whitfield', '9 of 14 requests to the office got no reply within 4 hours. Reply to open requests and agree a response-time target.'),
  act('luis', 'reduce_overtime', 'overtime', "Redistribute Luis Ortega's overtime", '36 overtime hours (4.5 per week). Move or reassign some upcoming jobs to technicians with open capacity.'),
  act('luis', 'remove_paperwork_step', 'unpaid_time', 'Remove a paperwork step for Luis Ortega', '14 worked hours were rejected and not paid (1.8 per week). Simplify the timesheet or close-out step that causes it.', { status: 'approved', baseline_score: 32, decided_at: ago(2) }),
];
const { error: aErr } = await db.from('retention_actions').insert(actions);
if (aErr) fail('create demo actions', aErr);

console.log(`✓ Seeded ${TECHS.length} demo technicians, ${scoreRows.length} weekly scores and ${actions.length} actions for ${email}.`);
console.log('  Open /dashboard/technician-retention. Remove with: node scripts/seed-technician-retention.mjs --email <email> --clean');
