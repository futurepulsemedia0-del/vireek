import type {
  CampaignStatus,
  EnrollmentStatus,
  MarketingCampaignEnrollment,
  MarketingCampaignStep,
  StepChannel,
} from '@/lib/marketing';

export type SendStatus = 'sent' | 'failed' | 'skipped';

export interface CampaignSend {
  enrollment_id: string;
  step_id: string;
  channel: StepChannel;
  status: SendStatus;
  error: string | null;
  sent_at: string;
}

export interface PaidJob {
  id: string;
  customer_id: string | null;
  lead_id: string | null;
  invoice_amount: number | null;
  created_at: string;
}

export interface ContactInfo {
  name: string;
}

/** A paid job counts toward a campaign only if it was booked within this many days of the first message. */
export const ATTRIBUTION_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

export interface Attribution {
  revenue: number;
  jobs: number;
}

/**
 * Last-touch attribution. A paid job is credited to the enrollment whose first
 * successful message is the most recent one before the job was created, as long
 * as the job landed inside the attribution window. Each job is credited once,
 * even if the same person is enrolled both as a lead and as a customer.
 */
export function attributeRevenue(
  enrollments: MarketingCampaignEnrollment[],
  sends: CampaignSend[],
  jobs: PaidJob[],
  windowDays: number = ATTRIBUTION_WINDOW_DAYS,
): Map<string, Attribution> {
  const result = new Map<string, Attribution>();
  const firstSent = new Map<string, number>();
  for (const s of sends) {
    if (s.status !== 'sent') continue;
    const t = Date.parse(s.sent_at);
    if (Number.isNaN(t)) continue;
    const prev = firstSent.get(s.enrollment_id);
    if (prev === undefined || t < prev) firstSent.set(s.enrollment_id, t);
  }

  const byCustomer = new Map<string, string[]>();
  const byLead = new Map<string, string[]>();
  for (const e of enrollments) {
    if (!firstSent.has(e.id)) continue;
    if (e.customer_id) byCustomer.set(e.customer_id, [...(byCustomer.get(e.customer_id) ?? []), e.id]);
    if (e.lead_id) byLead.set(e.lead_id, [...(byLead.get(e.lead_id) ?? []), e.id]);
  }

  const windowMs = windowDays * DAY_MS;
  for (const job of jobs) {
    const amount = Number(job.invoice_amount ?? 0);
    if (!(amount > 0)) continue;
    const jobTime = Date.parse(job.created_at);
    if (Number.isNaN(jobTime)) continue;
    const candidates = [
      ...(job.customer_id ? byCustomer.get(job.customer_id) ?? [] : []),
      ...(job.lead_id ? byLead.get(job.lead_id) ?? [] : []),
    ];
    let winner: string | null = null;
    let winnerTime = -Infinity;
    for (const id of new Set(candidates)) {
      const t = firstSent.get(id)!;
      if (t <= jobTime && jobTime - t <= windowMs && t > winnerTime) {
        winner = id;
        winnerTime = t;
      }
    }
    if (!winner) continue;
    const cur = result.get(winner) ?? { revenue: 0, jobs: 0 };
    result.set(winner, { revenue: cur.revenue + amount, jobs: cur.jobs + 1 });
  }
  return result;
}

export interface FunnelStage {
  key: 'enrolled' | 'messaged' | 'converted';
  label: string;
  count: number;
  pctOfEnrolled: number;
  pctOfPrevious: number;
}

export interface CampaignSummary {
  enrolled: number;
  messaged: number;
  converted: number;
  active: number;
  completed: number;
  stopped: number;
  sent: number;
  failed: number;
  skipped: number;
  deliveryRate: number;
  conversionRate: number;
  revenue: number;
  revenuePerRecipient: number;
}

const pct = (num: number, den: number): number => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

export function isConverted(e: MarketingCampaignEnrollment, attribution: Map<string, Attribution>): boolean {
  return e.status === 'converted' || (attribution.get(e.id)?.revenue ?? 0) > 0;
}

export function summarizeCampaign(
  enrollments: MarketingCampaignEnrollment[],
  sends: CampaignSend[],
  attribution: Map<string, Attribution>,
): CampaignSummary {
  const messagedIds = new Set<string>();
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const s of sends) {
    if (s.status === 'sent') {
      sent += 1;
      messagedIds.add(s.enrollment_id);
    } else if (s.status === 'failed') failed += 1;
    else skipped += 1;
  }
  const count = (status: EnrollmentStatus) => enrollments.filter((e) => e.status === status).length;
  const converted = enrollments.filter((e) => messagedIds.has(e.id) && isConverted(e, attribution)).length;
  let revenue = 0;
  for (const a of attribution.values()) revenue += a.revenue;
  return {
    enrolled: enrollments.length,
    messaged: enrollments.filter((e) => messagedIds.has(e.id)).length,
    converted,
    active: count('active'),
    completed: count('completed'),
    stopped: count('stopped'),
    sent,
    failed,
    skipped,
    deliveryRate: pct(sent, sent + failed),
    conversionRate: pct(converted, enrollments.length),
    revenue,
    revenuePerRecipient: enrollments.length > 0 ? revenue / enrollments.length : 0,
  };
}

export function buildFunnel(summary: CampaignSummary): FunnelStage[] {
  const stages: Array<Pick<FunnelStage, 'key' | 'label' | 'count'>> = [
    { key: 'enrolled', label: 'Enrolled', count: summary.enrolled },
    { key: 'messaged', label: 'Received a message', count: summary.messaged },
    { key: 'converted', label: 'Converted', count: summary.converted },
  ];
  return stages.map((s, i) => ({
    ...s,
    pctOfEnrolled: pct(s.count, summary.enrolled),
    pctOfPrevious: i === 0 ? (s.count > 0 ? 100 : 0) : pct(s.count, stages[i - 1].count),
  }));
}

export interface StepStat {
  stepId: string;
  stepOrder: number;
  channel: StepChannel;
  delayHours: number;
  label: string;
  sent: number;
  failed: number;
  skipped: number;
  reached: number;
  waiting: number;
  deliveryRate: number;
  retentionFromPrevious: number | null;
  topError: string | null;
}

export function buildStepStats(
  steps: MarketingCampaignStep[],
  sends: CampaignSend[],
  enrollments: MarketingCampaignEnrollment[],
): StepStat[] {
  const ordered = [...steps].sort((a, b) => a.step_order - b.step_order);
  let previousReached: number | null = null;
  return ordered.map((step) => {
    const forStep = sends.filter((s) => s.step_id === step.id);
    const sent = forStep.filter((s) => s.status === 'sent');
    const failedRows = forStep.filter((s) => s.status === 'failed');
    const skipped = forStep.length - sent.length - failedRows.length;
    const reached = new Set(sent.map((s) => s.enrollment_id)).size;
    const waiting = enrollments.filter((e) => e.status === 'active' && e.current_step === step.step_order - 1).length;

    const errorCounts = new Map<string, number>();
    for (const f of failedRows) {
      const key = (f.error ?? 'Unknown error').trim() || 'Unknown error';
      errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
    }
    let topError: string | null = null;
    let topCount = 0;
    for (const [msg, n] of errorCounts) {
      if (n > topCount) {
        topError = msg;
        topCount = n;
      }
    }

    const stat: StepStat = {
      stepId: step.id,
      stepOrder: step.step_order,
      channel: step.channel,
      delayHours: step.delay_hours,
      label: step.channel === 'email' ? step.subject?.trim() || 'Email (no subject)' : truncate(step.body, 48),
      sent: sent.length,
      failed: failedRows.length,
      skipped,
      reached,
      waiting,
      deliveryRate: pct(sent.length, sent.length + failedRows.length),
      retentionFromPrevious: previousReached === null ? null : pct(reached, previousReached),
      topError,
    };
    previousReached = reached;
    return stat;
  });
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export interface RecipientRow {
  enrollmentId: string;
  name: string;
  email: string | null;
  phone: string | null;
  kind: 'customer' | 'lead';
  status: EnrollmentStatus;
  stepsDone: number;
  stepsTotal: number;
  lastSentAt: string | null;
  nextSendAt: string | null;
  failedCount: number;
  revenue: number;
  converted: boolean;
}

export function buildRecipientRows(
  enrollments: MarketingCampaignEnrollment[],
  contacts: Map<string, ContactInfo>,
  sends: CampaignSend[],
  attribution: Map<string, Attribution>,
  stepsTotal: number,
): RecipientRow[] {
  const lastSent = new Map<string, string>();
  const failed = new Map<string, number>();
  for (const s of sends) {
    if (s.status === 'sent') {
      const prev = lastSent.get(s.enrollment_id);
      if (!prev || s.sent_at > prev) lastSent.set(s.enrollment_id, s.sent_at);
    } else if (s.status === 'failed') failed.set(s.enrollment_id, (failed.get(s.enrollment_id) ?? 0) + 1);
  }
  return enrollments.map((e) => {
    const key = e.customer_id ? `c:${e.customer_id}` : `l:${e.lead_id}`;
    return {
      enrollmentId: e.id,
      name: contacts.get(key)?.name ?? 'Unknown contact',
      email: e.contact_email,
      phone: e.contact_phone,
      kind: e.customer_id ? 'customer' : 'lead',
      status: e.status,
      stepsDone: Math.min(e.current_step, stepsTotal),
      stepsTotal,
      lastSentAt: lastSent.get(e.id) ?? null,
      nextSendAt: e.status === 'active' ? e.next_send_at : null,
      failedCount: failed.get(e.id) ?? 0,
      revenue: attribution.get(e.id)?.revenue ?? 0,
      converted: isConverted(e, attribution),
    };
  });
}

export type RecipientFilter = 'all' | EnrollmentStatus | 'failed';

export function filterRecipients(rows: RecipientRow[], query: string, filter: RecipientFilter): RecipientRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === 'failed' ? r.failedCount === 0 : filter !== 'all' && r.status !== filter) return false;
    if (!q) return true;
    return [r.name, r.email ?? '', r.phone ?? ''].some((v) => v.toLowerCase().includes(q));
  });
}

export function paginate<T>(items: T[], page: number, pageSize: number): { rows: T[]; pageCount: number; page: number } {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safe = Math.min(Math.max(1, page), pageCount);
  return { rows: items.slice((safe - 1) * pageSize, safe * pageSize), pageCount, page: safe };
}

/** Which status a pause/resume click moves the campaign to, or null when the action isn't available. */
export function toggleTarget(status: CampaignStatus, stepCount: number): CampaignStatus | null {
  if (status === 'active') return 'paused';
  if (stepCount === 0) return null;
  return 'active';
}

export function toggleLabel(status: CampaignStatus): string {
  return status === 'active' ? 'Pause' : status === 'paused' ? 'Resume' : 'Activate';
}

/** Name used when cloning, avoiding "Copy of Copy of …" chains. */
export function cloneName(name: string): string {
  const base = name.replace(/^(Copy of )+/i, '').trim();
  return `Copy of ${base}`.slice(0, 120);
}
