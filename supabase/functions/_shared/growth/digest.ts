// Weekly founder digest: rules turn the SQL snapshot into recommended actions. Pure (no I/O).
// Every number comes from growth_digest_snapshot(); nothing is estimated. Each action states its evidence and rule.

export interface PeriodRow {
  currency: string;
  opening_mrr_cents: number;
  closing_mrr_cents: number;
  movements: Partial<Record<'new' | 'expansion' | 'contraction' | 'churn' | 'reactivation', { cents: number; n: number }>>;
  cohort_n: number;
}
export interface DigestSnapshot {
  generated_at: string;
  primary_currency: string | null;
  week: PeriodRow[];
  prior_week: PeriodRow[];
  last_30d: PeriodRow[];
  history_days: number;
  trials_in_flight: number;
  trials_ending_7d: number;
  past_due_accounts: number;
  signups_7_14d: number;
  activated_of_signups_7_14d: number;
  open_alerts: { rule_key: string; value: number | null; fired_at: string }[];
  events_without_fact_30d: number;
  running_experiments: number;
}

export type Priority = 'high' | 'medium' | 'low';
export interface DigestAction {
  id: string;
  priority: Priority;
  title: string;
  evidence: string;
  rule: string;
}
export interface Digest {
  weekLabel: string;
  headline: { label: string; value: string }[];
  actions: DigestAction[];
  notices: string[];
}

export const MIN_SAMPLE = 30;
/** Heuristic, stated in the email: activation below this share of a matured cohort prompts a funnel review. */
export const ACTIVATION_REVIEW_BELOW = 0.5;

const fmtMoney = (cents: number, cur: string) =>
  new Intl.NumberFormat('en', { style: 'currency', currency: cur.toUpperCase(), maximumFractionDigits: 0 }).format(cents / 100);
const row = (rows: PeriodRow[], cur: string | null): PeriodRow | null => (cur ? rows.find((r) => r.currency === cur) ?? null : null);
const mv = (r: PeriodRow | null, k: keyof PeriodRow['movements']) => r?.movements[k]?.cents ?? 0;
const mn = (r: PeriodRow | null, k: keyof PeriodRow['movements']) => r?.movements[k]?.n ?? 0;

const ALERT_TITLES: Record<string, string> = {
  data_gap_events: 'Stripe events are not reaching the analytics tables',
  past_due_accounts: 'Many accounts have a failing card',
  mrr_churn_30d_pct: 'MRR churn over 30 days is above the threshold',
  no_new_paid_days: 'No new paying customer for several weeks',
};

export function buildDigest(s: DigestSnapshot, weekLabel: string): Digest {
  const cur = s.primary_currency;
  const w = row(s.week, cur);
  const pw = row(s.prior_week, cur);
  const actions: DigestAction[] = [];
  const notices: string[] = [];
  const headline: Digest['headline'] = [];

  if (cur && w) {
    headline.push({ label: 'MRR (closing)', value: fmtMoney(w.closing_mrr_cents, cur) });
    const delta = w.closing_mrr_cents - w.opening_mrr_cents;
    headline.push({ label: 'Net change this week', value: `${delta >= 0 ? '+' : '-'}${fmtMoney(Math.abs(delta), cur)}` });
    headline.push({ label: 'New / churned accounts', value: `${mn(w, 'new') + mn(w, 'reactivation')} / ${mn(w, 'churn')}` });
    const priorNet = pw ? pw.closing_mrr_cents - pw.opening_mrr_cents : null;
    if (priorNet !== null) headline.push({ label: 'Prior week net', value: `${priorNet >= 0 ? '+' : '-'}${fmtMoney(Math.abs(priorNet), cur)}` });
  } else {
    notices.push('No paying-subscription history yet: revenue metrics are not available.');
  }
  headline.push({ label: 'Trials in flight', value: String(s.trials_in_flight) });
  headline.push({ label: 'Past-due accounts', value: String(s.past_due_accounts) });

  if (s.events_without_fact_30d > 0) {
    actions.push({ id: 'data_gap', priority: 'high', title: 'Fix the Stripe → analytics data gap first',
      evidence: `${s.events_without_fact_30d} subscription event(s) in the last 30 days produced no fact, so revenue numbers may be wrong.`,
      rule: 'Any subscription event older than 1 hour without a fact.' });
  }
  if (s.past_due_accounts > 0) {
    actions.push({ id: 'past_due', priority: s.past_due_accounts >= 5 ? 'high' : 'medium', title: 'Follow up on failing payments',
      evidence: `${s.past_due_accounts} account(s) are past_due right now.`, rule: 'Any account with subscription_status = past_due.' });
  }
  if (s.trials_ending_7d > 0) {
    actions.push({ id: 'trials_ending', priority: 'medium', title: 'Reach out to trials that end within 7 days',
      evidence: `${s.trials_ending_7d} trialing subscription(s) end in the next 7 days.`, rule: 'Latest status trialing and trial_end < now + 7 days.' });
  }
  if (w && mn(w, 'churn') > 0) {
    actions.push({ id: 'churn_review', priority: mv(w, 'churn') > mv(pw, 'churn') ? 'high' : 'medium', title: 'Review accounts that churned this week',
      evidence: `${mn(w, 'churn')} account(s) churned (${fmtMoney(mv(w, 'churn'), w.currency)} MRR); prior week: ${mn(pw, 'churn')} (${fmtMoney(mv(pw, 'churn'), w.currency)}).`,
      rule: 'Any churn movement in the last 7 days; high when above the prior week.' });
  }
  if (s.signups_7_14d >= MIN_SAMPLE) {
    const rate = s.activated_of_signups_7_14d / s.signups_7_14d;
    if (rate < ACTIVATION_REVIEW_BELOW) {
      actions.push({ id: 'activation', priority: 'medium', title: 'Review the activation funnel',
        evidence: `${s.activated_of_signups_7_14d} of ${s.signups_7_14d} signups from 7–14 days ago made a real call within 7 days (${Math.round(rate * 100)}%).`,
        rule: `Matured cohort ≥ ${MIN_SAMPLE} and activation below ${Math.round(ACTIVATION_REVIEW_BELOW * 100)}% (a heuristic, not a benchmark).` });
    }
  } else {
    notices.push(`Activation not assessed: only ${s.signups_7_14d} matured signup(s) (need ${MIN_SAMPLE}).`);
  }
  for (const a of s.open_alerts) {
    actions.push({ id: `alert_${a.rule_key}`, priority: 'high', title: ALERT_TITLES[a.rule_key] ?? `Alert: ${a.rule_key}`,
      evidence: `Open alert${a.value === null ? '' : ` (value ${a.value})`}, fired ${a.fired_at.slice(0, 10)}.`, rule: 'Unacknowledged growth alert.' });
  }
  if (s.history_days < 60) notices.push(`Only ${s.history_days} day(s) of subscription history: retention, LTV and payback are not reliable yet.`);
  const w30 = row(s.last_30d, cur);
  if (w30 && w30.cohort_n < MIN_SAMPLE) notices.push(`Opening paying cohort is ${w30.cohort_n} account(s) (< ${MIN_SAMPLE}): NRR/GRR carry low-sample warnings.`);
  if (actions.length === 0) actions.push({ id: 'none', priority: 'low', title: 'No rule fired this week', evidence: 'All monitored conditions are within thresholds.', rule: 'See rules above.' });

  const order: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
  actions.sort((a, b) => order[a.priority] - order[b.priority]);
  return { weekLabel, headline, actions, notices };
}

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderDigest(d: Digest, dashboardUrl: string): { subject: string; html: string; text: string } {
  const subject = `Vireek growth digest — ${d.weekLabel}`;
  const text = [
    subject, '',
    ...d.headline.map((h) => `${h.label}: ${h.value}`), '',
    'Recommended actions:',
    ...d.actions.map((a) => `- [${a.priority}] ${a.title}\n  Evidence: ${a.evidence}\n  Rule: ${a.rule}`),
    ...(d.notices.length ? ['', 'Data notices:', ...d.notices.map((n) => `- ${n}`)] : []),
    '', `Dashboard: ${dashboardUrl}`,
  ].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:600px">
<h2>${esc(subject)}</h2>
<table>${d.headline.map((h) => `<tr><td style="padding:2px 12px 2px 0">${esc(h.label)}</td><td><strong>${esc(h.value)}</strong></td></tr>`).join('')}</table>
<h3>Recommended actions</h3>
<ol>${d.actions.map((a) => `<li><strong>[${esc(a.priority)}] ${esc(a.title)}</strong><br>${esc(a.evidence)}<br><small>Rule: ${esc(a.rule)}</small></li>`).join('')}</ol>
${d.notices.length ? `<h3>Data notices</h3><ul>${d.notices.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
<p><a href="${esc(dashboardUrl)}">Open the growth dashboard</a></p></div>`;
  return { subject, html, text };
}
