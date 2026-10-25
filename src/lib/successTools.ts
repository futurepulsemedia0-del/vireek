/**
 * Tenant success tooling — pure logic (no React, no network, no Supabase).
 *
 * Covers: per-account feature-adoption score, guided activation playbooks,
 * nudges for unused high-value features, in-app NPS maths and the staff
 * "at-risk" composition. The staff risk model is layered ON TOP of the existing
 * staff health score (computeHealth in supabase/functions/_shared/staff/accountExplorer.ts):
 * the health result is passed in, never recomputed or forked here.
 *
 * Every number is deterministic and explainable. api: successToolsApi.ts.
 */

import type { HealthResult } from '../../supabase/functions/_shared/staff/accountExplorer';

// ============================================================
// TYPES
// ============================================================

export type FeatureTier = 'core' | 'high_value';
export type FeatureKind = 'activity' | 'setup';
export type FeatureStatus = 'active' | 'lapsed' | 'unused' | 'unmeasured';

export interface CatalogFeature {
  key: string;
  label: string;
  tier: FeatureTier;
  kind: FeatureKind;
  weight: number;
  /** False when the server could not measure it (table missing etc.) — excluded from every score. */
  measured: boolean;
}

export interface FeatureUsage {
  /** Rows found (activity features: last 180 days; setup features: ever). */
  total: number;
  /** Rows created in the last 30 days. */
  recent: number;
  lastAt: string | null;
}

export interface FeatureAdoptionItem extends CatalogFeature {
  status: FeatureStatus;
  usage: FeatureUsage;
  /** 1 active, 0.5 lapsed, 0 unused / unmeasured. */
  credit: number;
}

export type AdoptionLevel = 'strong' | 'growing' | 'low' | 'minimal' | 'unknown';

export interface AdoptionResult {
  /** 0-100, or null when nothing could be measured. */
  score: number | null;
  level: AdoptionLevel;
  items: FeatureAdoptionItem[];
  counts: Record<FeatureStatus, number>;
  coreScore: number | null;
  highValueScore: number | null;
}

export interface ItemState {
  status: 'snoozed' | 'dismissed' | 'skipped';
  snoozedUntil: string | null;
}

export interface SuccessSnapshot {
  accountCreatedAt: string | null;
  features: CatalogFeature[];
  usage: Record<string, FeatureUsage>;
  states: Record<string, ItemState>;
  npsDue: boolean;
}

// ============================================================
// CONSTANTS
// ============================================================

const DAY_MS = 86_400_000;
const EMPTY_USAGE: FeatureUsage = { total: 0, recent: 0, lastAt: null };

export const STATUS_CREDIT: Record<FeatureStatus, number> = { active: 1, lapsed: 0.5, unused: 0, unmeasured: 0 };
export const STATUS_LABELS: Record<FeatureStatus, string> = {
  active: 'In use',
  lapsed: 'Lapsed',
  unused: 'Not started',
  unmeasured: 'Not measured',
};
export const ADOPTION_LEVEL_LABELS: Record<AdoptionLevel, string> = {
  strong: 'Strong adoption',
  growing: 'Growing',
  low: 'Low adoption',
  minimal: 'Barely started',
  unknown: 'Not enough data',
};

/** Accounts younger than this are guided by Getting Started + playbooks, not nudged. */
export const NUDGE_MIN_ACCOUNT_AGE_DAYS = 10;
export const NUDGE_DEFAULT_MAX = 3;
export const NPS_SNOOZE_DAYS = 14;
export const NUDGE_SNOOZE_DAYS = 14;
export const NPS_FRESH_DAYS = 90;
export const NPS_COMMENT_MAX = 1000;

export const nudgeKey = (featureKey: string) => `nudge:${featureKey}`;
export const stepKey = (playbookId: string, stepId: string) => `step:${playbookId}:${stepId}`;
export const NPS_PROMPT_KEY = 'nps_prompt';

// ============================================================
// FEATURE ADOPTION
// ============================================================

export function classifyFeature(feature: CatalogFeature, usage: FeatureUsage = EMPTY_USAGE): FeatureStatus {
  if (!feature.measured) return 'unmeasured';
  if (usage.recent > 0) return 'active';
  if (usage.total > 0) return feature.kind === 'setup' ? 'active' : 'lapsed';
  return 'unused';
}

function weighted(items: FeatureAdoptionItem[]): number | null {
  const measured = items.filter((i) => i.status !== 'unmeasured');
  const total = measured.reduce((s, i) => s + i.weight, 0);
  if (total <= 0) return null;
  return Math.round((100 * measured.reduce((s, i) => s + i.weight * i.credit, 0)) / total);
}

export function adoptionLevel(score: number | null): AdoptionLevel {
  if (score === null) return 'unknown';
  if (score >= 75) return 'strong';
  if (score >= 50) return 'growing';
  if (score >= 25) return 'low';
  return 'minimal';
}

export function computeAdoption(catalog: CatalogFeature[], usage: Record<string, FeatureUsage>): AdoptionResult {
  const items: FeatureAdoptionItem[] = catalog.map((f) => {
    const u = usage[f.key] ?? EMPTY_USAGE;
    const status = classifyFeature(f, u);
    return { ...f, status, usage: u, credit: STATUS_CREDIT[status] };
  });
  const counts: Record<FeatureStatus, number> = { active: 0, lapsed: 0, unused: 0, unmeasured: 0 };
  items.forEach((i) => counts[i.status]++);
  const score = weighted(items);
  return {
    score,
    level: adoptionLevel(score),
    items,
    counts,
    coreScore: weighted(items.filter((i) => i.tier === 'core')),
    highValueScore: weighted(items.filter((i) => i.tier === 'high_value')),
  };
}

// ============================================================
// COPY (presentation metadata for catalog keys; unknown keys simply get no nudge)
// ============================================================

export interface FeatureCopy {
  title: string;
  benefit: string;
  winBack?: string;
  cta: string;
  href: string;
}

export const FEATURE_COPY: Record<string, FeatureCopy> = {
  ai_calls: { title: 'Let the AI answer your calls', benefit: 'Every missed call is a lost job. The assistant answers 24/7 and books work for you.', winBack: 'Calls have gone quiet — check your number forwarding and greeting.', cta: 'Review calls', href: '/dashboard/calls' },
  customers: { title: 'Add your customers', benefit: 'Customer history powers faster quotes, follow-ups and repeat business.', cta: 'Open customers', href: '/dashboard/customers' },
  jobs: { title: 'Schedule your first job', benefit: 'Jobs connect calls to dispatch, invoicing and reviews.', winBack: 'No new jobs lately — booked calls can become jobs in one click.', cta: 'Open jobs', href: '/dashboard/jobs' },
  quotes: { title: 'Send a quote in minutes', benefit: 'Quoting on the spot closes more work than a callback tomorrow.', winBack: 'You stopped sending quotes — fast quotes win more jobs.', cta: 'Open quotes', href: '/dashboard/quotes' },
  invoices: { title: 'Invoice from the job', benefit: 'Invoice the moment the work is done and get paid faster.', winBack: 'No invoices recently — unbilled jobs are cash left on the table.', cta: 'Open invoicing', href: '/dashboard/invoicing' },
  team: { title: 'Invite your team', benefit: 'Technicians and office staff work from the same schedule and customer records.', cta: 'Manage team', href: '/dashboard/team' },
  phone_numbers: { title: 'Connect a business number', benefit: 'Your number is how the AI receptionist starts answering for you.', cta: 'Add a number', href: '/dashboard/phone-numbers' },
  integrations: { title: 'Connect your tools', benefit: 'Sync accounting, calendars and CRM so nothing is typed twice.', cta: 'Open integrations', href: '/dashboard/integrations' },
  call_scripts: { title: 'Write your call scripts', benefit: 'Custom scripts make the assistant sound like your company and qualify leads the way you want.', cta: 'Edit scripts', href: '/dashboard/call-scripts' },
  call_routing: { title: 'Set smart call routing', benefit: 'Route emergencies and VIPs to the right person automatically.', cta: 'Set up routing', href: '/dashboard/call-routing' },
  price_book: { title: 'Build your price book', benefit: 'A price book makes quotes consistent and protects your margins.', cta: 'Open price book', href: '/dashboard/price-book' },
  agreements: { title: 'Sell service agreements', benefit: 'Recurring agreements turn one-off jobs into predictable revenue.', winBack: 'No new agreements lately — renewals and upsells keep revenue steady.', cta: 'Open agreements', href: '/dashboard/agreements' },
  email_campaigns: { title: 'Send your first campaign', benefit: 'Seasonal reminders bring past customers back without ad spend.', winBack: 'Your last campaign was a while ago — past customers are your cheapest leads.', cta: 'Open campaigns', href: '/dashboard/email-campaigns' },
  inventory: { title: 'Track parts and stock', benefit: 'Know what is on every truck and stop losing time to missing parts.', cta: 'Open inventory', href: '/dashboard/inventory' },
  bank_sync: { title: 'Connect your bank', benefit: 'Auto-matched transactions and cash-flow forecasts, without spreadsheets.', cta: 'Connect bank', href: '/dashboard/bank-intelligence' },
  financing: { title: 'Offer customer financing', benefit: 'Financing helps customers say yes to bigger repairs and replacements.', cta: 'Set up financing', href: '/dashboard/financing' },
  expenses: { title: 'Capture expenses', benefit: 'Job-level costs show which work is actually profitable.', winBack: 'No expenses logged recently — profit reports need them.', cta: 'Open expenses', href: '/dashboard/expenses' },
  calendar_feeds: { title: 'Sync your calendar', benefit: 'See Vireek jobs next to everything else in Google or Apple Calendar.', cta: 'Set up sync', href: '/dashboard/calendar-feeds' },
  crm_sync: { title: 'Connect your CRM', benefit: 'Keep leads and customers in sync with the CRM your team already uses.', cta: 'Open CRM sync', href: '/dashboard/crm-sync' },
  call_blocklist: { title: 'Block spam callers', benefit: 'Stop robocalls from using your minutes and your team’s time.', cta: 'Open blocklist', href: '/dashboard/blocklist' },
};

// ============================================================
// STATE HELPERS
// ============================================================

/** Dismissed/skipped always hide; snoozed hides until the snooze ends. */
export function isStateHiding(state: ItemState | undefined, now: Date): boolean {
  if (!state) return false;
  if (state.status === 'snoozed') return !!state.snoozedUntil && Date.parse(state.snoozedUntil) > now.getTime();
  return true;
}

export function accountAgeDays(createdAt: string | null, now: Date): number {
  if (!createdAt) return 0;
  const t = Date.parse(createdAt);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY_MS)) : 0;
}

// ============================================================
// GUIDED ACTIVATION PLAYBOOKS
// ============================================================

export interface PlaybookStepDef {
  id: string;
  featureKey: string;
  title: string;
  why: string;
  href: string;
  cta: string;
  minutes: number;
}

export interface PlaybookDef {
  id: string;
  title: string;
  outcome: string;
  steps: PlaybookStepDef[];
}

export const PLAYBOOKS: PlaybookDef[] = [
  {
    id: 'launch_ai_receptionist',
    title: 'Launch your AI receptionist',
    outcome: 'Never miss a call again — every caller is greeted, qualified and booked.',
    steps: [
      { id: 'number', featureKey: 'phone_numbers', title: 'Connect your business number', why: 'The assistant can only answer calls on a number you connect.', href: '/dashboard/phone-numbers', cta: 'Add number', minutes: 5 },
      { id: 'scripts', featureKey: 'call_scripts', title: 'Customize your call script', why: 'Your greeting and questions decide how professional the first impression is.', href: '/dashboard/call-scripts', cta: 'Edit script', minutes: 10 },
      { id: 'routing', featureKey: 'call_routing', title: 'Set emergency and VIP routing', why: 'Urgent calls should reach a human immediately.', href: '/dashboard/call-routing', cta: 'Set routing', minutes: 8 },
      { id: 'first_call', featureKey: 'ai_calls', title: 'Take your first AI-answered call', why: 'Real calls are the proof — review one to fine-tune the assistant.', href: '/dashboard/calls', cta: 'Review calls', minutes: 5 },
    ],
  },
  {
    id: 'quote_to_cash',
    title: 'Quote to cash',
    outcome: 'Go from estimate to paid invoice without leaving Vireek.',
    steps: [
      { id: 'price_book', featureKey: 'price_book', title: 'Build your price book', why: 'Consistent prices make quoting fast and protect margin.', href: '/dashboard/price-book', cta: 'Open price book', minutes: 15 },
      { id: 'quote', featureKey: 'quotes', title: 'Send a quote', why: 'Customers answer faster when the quote arrives while they are still thinking about it.', href: '/dashboard/quotes', cta: 'New quote', minutes: 5 },
      { id: 'invoice', featureKey: 'invoices', title: 'Invoice a completed job', why: 'Invoicing on the day gets you paid sooner.', href: '/dashboard/invoicing', cta: 'New invoice', minutes: 5 },
      { id: 'bank', featureKey: 'bank_sync', title: 'Connect your bank', why: 'Payments reconcile automatically and cash-flow forecasts switch on.', href: '/dashboard/bank-intelligence', cta: 'Connect bank', minutes: 5 },
    ],
  },
  {
    id: 'run_with_your_team',
    title: 'Run the day with your team',
    outcome: 'One shared schedule for the office and the field.',
    steps: [
      { id: 'team', featureKey: 'team', title: 'Invite your team', why: 'Technicians see their own jobs; the office sees everything.', href: '/dashboard/team', cta: 'Invite team', minutes: 5 },
      { id: 'jobs', featureKey: 'jobs', title: 'Schedule a job', why: 'Jobs tie calls, quotes and invoices into one timeline.', href: '/dashboard/jobs', cta: 'Open jobs', minutes: 5 },
      { id: 'calendar', featureKey: 'calendar_feeds', title: 'Sync your calendar', why: 'Jobs appear in the calendar your crew already checks.', href: '/dashboard/calendar-feeds', cta: 'Set up sync', minutes: 3 },
      { id: 'integrations', featureKey: 'integrations', title: 'Connect your tools', why: 'Remove double entry with accounting and CRM.', href: '/dashboard/integrations', cta: 'Open integrations', minutes: 10 },
    ],
  },
  {
    id: 'build_recurring_revenue',
    title: 'Build recurring revenue',
    outcome: 'Turn one-time customers into a base that renews every year.',
    steps: [
      { id: 'customers', featureKey: 'customers', title: 'Bring in your customers', why: 'Campaigns and agreements need a customer list.', href: '/dashboard/customers', cta: 'Open customers', minutes: 10 },
      { id: 'agreement', featureKey: 'agreements', title: 'Create a service agreement', why: 'Maintenance plans create predictable monthly revenue.', href: '/dashboard/agreements', cta: 'Open agreements', minutes: 10 },
      { id: 'campaign', featureKey: 'email_campaigns', title: 'Send a seasonal campaign', why: 'Reminders re-activate past customers without ad spend.', href: '/dashboard/email-campaigns', cta: 'New campaign', minutes: 10 },
    ],
  },
];

export interface PlaybookStepView extends PlaybookStepDef {
  status: 'done' | 'todo' | 'skipped' | 'unknown';
}

export interface PlaybookProgress {
  def: PlaybookDef;
  steps: PlaybookStepView[];
  /** Steps done / steps that count (measured and not skipped). */
  done: number;
  total: number;
  pct: number;
  complete: boolean;
  next: PlaybookStepView | null;
  minutesLeft: number;
}

export function playbookProgress(
  def: PlaybookDef,
  items: FeatureAdoptionItem[],
  states: Record<string, ItemState> = {},
): PlaybookProgress {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const steps: PlaybookStepView[] = def.steps.map((s) => {
    const item = byKey.get(s.featureKey);
    let status: PlaybookStepView['status'];
    if (!item || item.status === 'unmeasured') status = 'unknown';
    else if (item.status !== 'unused') status = 'done';
    else if (states[stepKey(def.id, s.id)]?.status === 'skipped') status = 'skipped';
    else status = 'todo';
    return { ...s, status };
  });
  const counted = steps.filter((s) => s.status === 'done' || s.status === 'todo');
  const done = counted.filter((s) => s.status === 'done').length;
  const total = counted.length;
  const next = steps.find((s) => s.status === 'todo') ?? null;
  return {
    def,
    steps,
    done,
    total,
    pct: total === 0 ? 0 : Math.round((done / total) * 100),
    complete: total > 0 && done === total,
    next,
    minutesLeft: steps.filter((s) => s.status === 'todo').reduce((m, s) => m + s.minutes, 0),
  };
}

/** The playbook worth focusing on now: furthest-along unfinished one, else the first not started. */
export function pickActivePlaybook(progress: PlaybookProgress[]): PlaybookProgress | null {
  const open = progress.filter((p) => !p.complete && p.next !== null);
  if (open.length === 0) return null;
  const started = open.filter((p) => p.done > 0).sort((a, b) => b.pct - a.pct);
  return started[0] ?? open[0];
}

// ============================================================
// NUDGES
// ============================================================

export interface Nudge {
  id: string;
  featureKey: string;
  kind: 'unused' | 'lapsed';
  title: string;
  body: string;
  cta: string;
  href: string;
  priority: number;
}

export interface NudgeContext {
  accountAgeDays: number;
  now: Date;
  /** Feature keys of the active playbook's open steps get a priority boost. */
  focusFeatureKeys?: ReadonlySet<string>;
  max?: number;
}

export function buildNudges(items: FeatureAdoptionItem[], states: Record<string, ItemState>, ctx: NudgeContext): Nudge[] {
  if (ctx.accountAgeDays < NUDGE_MIN_ACCOUNT_AGE_DAYS) return [];
  // Do not push advanced features at an account that is not using the basics yet.
  const activated = items.some((i) => i.tier === 'core' && i.kind === 'activity' && i.status === 'active');
  if (!activated) return [];

  const nudges: Nudge[] = [];
  for (const i of items) {
    const copy = FEATURE_COPY[i.key];
    if (!copy) continue;
    const unused = i.tier === 'high_value' && i.status === 'unused';
    const lapsed = i.status === 'lapsed' && i.weight >= 5;
    if (!unused && !lapsed) continue;
    if (isStateHiding(states[nudgeKey(i.key)], ctx.now)) continue;
    const boost = ctx.focusFeatureKeys?.has(i.key) ? 4 : 0;
    nudges.push({
      id: nudgeKey(i.key),
      featureKey: i.key,
      kind: lapsed ? 'lapsed' : 'unused',
      title: lapsed ? `Pick ${i.label.toLowerCase()} back up` : copy.title,
      body: lapsed ? (copy.winBack ?? `You haven’t used ${i.label.toLowerCase()} in the last 30 days. ${copy.benefit}`) : copy.benefit,
      cta: copy.cta,
      href: copy.href,
      priority: i.weight * (lapsed ? 1.25 : 1) + boost,
    });
  }
  nudges.sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title));
  return nudges.slice(0, Math.max(0, ctx.max ?? NUDGE_DEFAULT_MAX));
}

// ============================================================
// ONE-CALL DERIVED VIEW (used by the hook)
// ============================================================

export interface SuccessView {
  adoption: AdoptionResult;
  playbooks: PlaybookProgress[];
  activePlaybook: PlaybookProgress | null;
  nudges: Nudge[];
  ageDays: number;
}

export function deriveSuccessView(snapshot: SuccessSnapshot, now: Date = new Date(), maxNudges = NUDGE_DEFAULT_MAX): SuccessView {
  const adoption = computeAdoption(snapshot.features, snapshot.usage);
  const playbooks = PLAYBOOKS.map((p) => playbookProgress(p, adoption.items, snapshot.states));
  const activePlaybook = pickActivePlaybook(playbooks);
  const focus = new Set(activePlaybook?.steps.filter((s) => s.status === 'todo').map((s) => s.featureKey) ?? []);
  const ageDays = accountAgeDays(snapshot.accountCreatedAt, now);
  const nudges = buildNudges(adoption.items, snapshot.states, { accountAgeDays: ageDays, now, focusFeatureKeys: focus, max: maxNudges });
  return { adoption, playbooks, activePlaybook, nudges, ageDays };
}

// ============================================================
// NPS
// ============================================================

export type NpsCategory = 'promoter' | 'passive' | 'detractor';

export const isValidNpsScore = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 10;

export function npsCategory(score: number): NpsCategory {
  return score >= 9 ? 'promoter' : score >= 7 ? 'passive' : 'detractor';
}

export interface NpsSummary {
  responses: number;
  promoters: number;
  passives: number;
  detractors: number;
  /** -100..100, or null with no responses. */
  score: number | null;
}

export function summarizeNps(c: { promoters: number; passives: number; detractors: number }): NpsSummary {
  const responses = c.promoters + c.passives + c.detractors;
  return { ...c, responses, score: responses === 0 ? null : Math.round(((c.promoters - c.detractors) / responses) * 100) };
}

export function npsFollowUpPrompt(score: number): string {
  const c = npsCategory(score);
  if (c === 'promoter') return 'Glad to hear it! What do you like most about Vireek?';
  if (c === 'passive') return 'Thanks! What one thing would make Vireek a 10 for you?';
  return 'Sorry we’re falling short. What went wrong, and what should we fix first?';
}

// ============================================================
// STAFF: AT-RISK COMPOSITION (reuses the staff health score)
// ============================================================

export type RiskLevel = 'high' | 'medium' | 'low' | 'new' | 'churned';
export const RISK_LABELS: Record<RiskLevel, string> = { high: 'High risk', medium: 'Medium risk', low: 'Low risk', new: 'New', churned: 'Churned' };
export const RISK_RANK: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2, new: 3, churned: 4 };

export interface NpsLatest {
  score: number;
  comment: string | null;
  at: string;
}

export interface RiskReason {
  severity: 'high' | 'medium' | 'low';
  text: string;
}

export interface SuccessRisk {
  level: RiskLevel;
  /** 0-100 blended health (higher is healthier), null for new/churned accounts. */
  score: number | null;
  reasons: RiskReason[];
  action: string;
}

const SEVERITY_RANK: Record<RiskReason['severity'], number> = { high: 0, medium: 1, low: 2 };
const NPS_VALUE: Record<NpsCategory, number> = { promoter: 100, passive: 60, detractor: 10 };
const W_HEALTH = 0.55;
const W_ADOPTION = 0.3;
const W_NPS = 0.15;

const snippet = (s: string | null, n = 120) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const names = (items: FeatureAdoptionItem[], n: number) => items.slice(0, n).map((i) => i.label.toLowerCase()).join(', ');

export interface RiskInput {
  health: HealthResult;
  adoption: AdoptionResult | null;
  nps: NpsLatest | null;
  ageDays: number;
  now?: Date;
}

export function computeSuccessRisk(input: RiskInput): SuccessRisk {
  const { health, adoption, ageDays } = input;
  const now = input.now ?? new Date();

  if (health.band === 'churned') return { level: 'churned', score: 0, reasons: [], action: 'No action — the account has churned.' };
  if (health.band === 'new') {
    return { level: 'new', score: null, reasons: [], action: 'Let Getting Started and the activation playbooks work; check in after the first week.' };
  }

  const npsFresh = input.nps && now.getTime() - Date.parse(input.nps.at) <= NPS_FRESH_DAYS * DAY_MS ? input.nps : null;
  const npsCat = npsFresh ? npsCategory(npsFresh.score) : null;
  const adoptionScore = adoption?.score ?? null;

  let weightSum = W_HEALTH;
  let acc = W_HEALTH * health.score;
  if (adoptionScore !== null) {
    weightSum += W_ADOPTION;
    acc += W_ADOPTION * adoptionScore;
  }
  if (npsCat) {
    weightSum += W_NPS;
    acc += W_NPS * NPS_VALUE[npsCat];
  }
  const score = Math.round(acc / weightSum);

  const detractor = npsCat === 'detractor';
  const adoptionStalled = adoptionScore !== null && adoptionScore < 30 && ageDays >= 30;
  let level: RiskLevel = 'low';
  if (health.band === 'critical' || score < 40 || (detractor && score < 60)) level = 'high';
  else if (health.band === 'at_risk' || score < 60 || adoptionStalled || detractor) level = 'medium';

  const reasons: RiskReason[] = [];
  for (const f of health.factors) {
    const ratio = f.max > 0 ? f.points / f.max : 1;
    if (ratio < 0.4) reasons.push({ severity: ratio < 0.2 ? 'high' : 'medium', text: `${f.label}: ${f.detail}` });
  }
  if (adoption && adoptionScore !== null && adoptionScore < 50) {
    const missing = adoption.items.filter((i) => i.status === 'unused').sort((a, b) => b.weight - a.weight);
    reasons.push({
      severity: adoptionScore < 25 ? 'high' : 'medium',
      text: `Feature adoption is ${adoptionScore}%${missing.length ? ` — not using ${names(missing, 3)}` : ''}`,
    });
  }
  if (adoption) {
    const lapsed = adoption.items.filter((i) => i.status === 'lapsed').sort((a, b) => b.weight - a.weight);
    if (lapsed.length) reasons.push({ severity: 'medium', text: `Stopped using ${names(lapsed, 3)}` });
  }
  if (detractor && npsFresh) {
    const quote = snippet(npsFresh.comment);
    reasons.push({ severity: 'high', text: `NPS detractor (${npsFresh.score}/10)${quote ? ` — “${quote}”` : ''}` });
  }
  reasons.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const billing = health.factors.find((f) => f.key === 'billing');
  const recency = health.factors.find((f) => f.key === 'recency');
  let action: string;
  if (billing && billing.points / billing.max < 0.4) action = 'Resolve the billing problem first, then follow up on usage.';
  else if (detractor) action = 'Call within 2 business days to understand the NPS feedback.';
  else if (level === 'high' && recency && recency.points / recency.max < 0.2) action = 'Reach out personally — the account has gone quiet.';
  else if (adoptionScore !== null && adoptionScore < 50) action = 'Offer a 20-minute guided activation session on the top unused features.';
  else if (level === 'medium') action = 'Send a check-in and point them to their next activation playbook.';
  else action = 'No action needed.';

  return { level, score, reasons: reasons.slice(0, 5), action };
}

export interface SuccessAccountInput {
  id: string;
  companyName: string | null;
  email: string;
  plan: string;
  createdAt: string;
  health: HealthResult;
}

export interface StaffSuccessData {
  catalog: CatalogFeature[];
  usageByAccount: Record<string, Record<string, FeatureUsage>>;
  npsLatest: Record<string, NpsLatest>;
  nps: NpsSummary & { days: number };
}

export interface StaffSuccessRow {
  id: string;
  label: string;
  email: string;
  plan: string;
  health: HealthResult;
  adoption: AdoptionResult;
  nps: NpsLatest | null;
  risk: SuccessRisk;
}

export function buildStaffSuccessRow(account: SuccessAccountInput, data: StaffSuccessData, now: Date = new Date()): StaffSuccessRow {
  const adoption = computeAdoption(data.catalog, data.usageByAccount[account.id] ?? {});
  const nps = data.npsLatest[account.id] ?? null;
  const risk = computeSuccessRisk({ health: account.health, adoption, nps, ageDays: accountAgeDays(account.createdAt, now), now });
  return { id: account.id, label: account.companyName || account.email, email: account.email, plan: account.plan, health: account.health, adoption, nps, risk };
}

/** Highest risk first, then lowest blended score, then name. */
export function buildStaffSuccessRows(accounts: SuccessAccountInput[], data: StaffSuccessData, now: Date = new Date()): StaffSuccessRow[] {
  return accounts
    .map((a) => buildStaffSuccessRow(a, data, now))
    .sort((a, b) => RISK_RANK[a.risk.level] - RISK_RANK[b.risk.level] || (a.risk.score ?? 101) - (b.risk.score ?? 101) || a.label.localeCompare(b.label));
}

export function averageAdoption(rows: StaffSuccessRow[]): number | null {
  const scored = rows.filter((r) => r.risk.level !== 'new' && r.risk.level !== 'churned' && r.adoption.score !== null);
  if (scored.length === 0) return null;
  return Math.round(scored.reduce((s, r) => s + (r.adoption.score as number), 0) / scored.length);
}

// ============================================================
// PARSERS (defensive: server JSON -> typed, never throws on odd input)
// ============================================================

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]).filter((x) => x && typeof x === 'object') : []);
const str = (v: unknown, fb = ''): string => (typeof v === 'string' ? v : fb);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

function parseCatalog(v: unknown): CatalogFeature[] {
  return arr(v)
    .filter((f) => typeof f.key === 'string' && f.key)
    .map((f) => ({
      key: str(f.key),
      label: str(f.label, str(f.key)),
      tier: f.tier === 'core' ? 'core' : 'high_value',
      kind: f.kind === 'setup' ? 'setup' : 'activity',
      weight: Math.max(1, num(f.weight)),
      measured: f.measured !== false,
    }));
}

export function parseSnapshot(raw: unknown): SuccessSnapshot {
  const d = obj(raw);
  const features = parseCatalog(d.features);
  const usage: Record<string, FeatureUsage> = {};
  for (const f of arr(d.features)) {
    usage[str(f.key)] = { total: num(f.total), recent: num(f.recent), lastAt: strOrNull(f.last_at) };
  }
  const states: Record<string, ItemState> = {};
  for (const s of arr(d.states)) {
    const status = s.status === 'snoozed' || s.status === 'dismissed' || s.status === 'skipped' ? s.status : null;
    if (status && typeof s.key === 'string') states[s.key] = { status, snoozedUntil: strOrNull(s.snoozed_until) };
  }
  return { accountCreatedAt: strOrNull(d.account_created_at), features, usage, states, npsDue: d.nps_due === true };
}

export function parseStaffOverview(raw: unknown): StaffSuccessData {
  const d = obj(raw);
  const usageByAccount: Record<string, Record<string, FeatureUsage>> = {};
  for (const u of arr(d.usage)) {
    const a = str(u.a);
    const k = str(u.k);
    if (!a || !k) continue;
    const bucket = usageByAccount[a] ?? (usageByAccount[a] = {});
    bucket[k] = { total: num(u.t), recent: num(u.r), lastAt: strOrNull(u.l) };
  }
  const npsLatest: Record<string, NpsLatest> = {};
  for (const n of arr(d.nps_latest)) {
    const a = str(n.a);
    if (a) npsLatest[a] = { score: num(n.score), comment: strOrNull(n.comment), at: str(n.at) };
  }
  const n = obj(d.nps);
  const summary = summarizeNps({ promoters: num(n.promoters), passives: num(n.passives), detractors: num(n.detractors) });
  return { catalog: parseCatalog(d.catalog), usageByAccount, npsLatest, nps: { ...summary, days: num(n.days) || NPS_FRESH_DAYS } };
}
