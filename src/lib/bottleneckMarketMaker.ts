/**
 * Bottleneck Market Maker — client library.
 *
 * Most dashboards optimize locally: fill this slot, quote this job, run
 * this campaign. None of that matters if the business only has one truly
 * scarce resource this week — usually one technician skill category — and
 * every local optimization is quietly competing for the same few hours of
 * it. This engine finds that single scarcest resource first, then decides
 * who gets it: which pending customers, jobs, zones and slots return the
 * most long-term value, and coordinates Booking, Pricing, Marketing and
 * Dispatch around that one answer instead of four independent guesses.
 *
 * Data sources read (all pre-existing, nothing new added to the schema):
 *   - team_members              (technician skills, service area, max_jobs_per_day, dispatch_enabled)
 *   - jobs                      (near-term scheduled load per service type + zone, paid history for LTV)
 *   - leads                     (open, not-yet-scheduled demand per service type)
 *   - capacity_waitlist_entries (customers already waiting for a slot)
 *   - customers                 (lifecycle stage, for the value score)
 *
 * Every step is disclosed via MARKET_MAKER_ASSUMPTIONS and wrapped
 * defensively — a missing table/column degrades one section, never the
 * whole plan.
 */

import { supabase } from '@/lib/supabase';
import { normalizePhoneDigits } from '@/lib/telephony';
import { parseLocality } from '@/lib/regionalDemand';
import type { Job, TeamMember, Lead, Customer } from '@/lib/supabase';
import type { CapacityWaitlistEntry } from '@/lib/capacityDemand';

// ============================================================
// ASSUMPTIONS — disclosed weights. Tune to your real numbers.
// ============================================================

export interface MarketMakerAssumptions {
  /** How many days ahead count as "this week's" capacity window. */
  windowDays: number;
  /** Utilization at/above this is treated as the active bottleneck. */
  scarceUtilizationPct: number;
  /** Suggested price premium on new bookings for the bottleneck category while scarce. */
  surgePricingPct: number;
  /** Share of a matched customer's paid history folded into the value score. */
  ltvWeight: number;
  /** Flat value-score bonus for a VIP customer. */
  vipBonusCents: number;
  /** Flat value-score bonus for an active (non-VIP) customer. */
  activeBonusCents: number;
  /** When no job/quote value is known, this is used as the placeholder job value. */
  fallbackJobValueCents: number;
  /** How many days of paid job history to scan when computing customer LTV. */
  ltvLookbackDays: number;
}

export const MARKET_MAKER_ASSUMPTIONS: MarketMakerAssumptions = {
  windowDays: 7,
  scarceUtilizationPct: 85,
  surgePricingPct: 12,
  ltvWeight: 0.15,
  vipBonusCents: 30_000,
  activeBonusCents: 10_000,
  fallbackJobValueCents: 25_000,
  ltvLookbackDays: 365,
};

const OPEN_JOB_STATUSES = new Set(['scheduled', 'en_route', 'in_progress']);
const OPEN_LEAD_STAGES = new Set(['new', 'contacted', 'quoted']);
const GENERAL_BUCKET = 'General Service Capacity';

export type AllocationDecision = 'prioritize' | 'hold' | 'defer';

export interface BucketUtilization {
  serviceType: string;
  capacityUnits: number; // technician-slots available across the window
  demandUnits: number; // scheduled jobs + open pending demand in the window
  utilizationPct: number;
  techniciansSkilled: number;
}

export interface AllocationCandidate {
  id: string;
  source: 'waitlist' | 'lead';
  customerName: string;
  zone: string | null;
  estimatedValueCents: number;
  customerLtvCents: number;
  lifecycleStage: Customer['lifecycle_stage'] | null;
  valueScoreCents: number;
  decision: AllocationDecision;
  reason: string;
}

export interface MarketMakerRecommendations {
  booking: string[];
  pricing: string[];
  marketing: string[];
  dispatch: string[];
}

export interface MarketMakerPlan {
  generatedAt: string;
  bottleneck: BucketUtilization | null;
  slackBucket: BucketUtilization | null;
  allBuckets: BucketUtilization[];
  candidates: AllocationCandidate[];
  recommendations: MarketMakerRecommendations;
  assumptions: MarketMakerAssumptions;
}

function windowBounds(days: number): { startIso: string; endIso: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + days * 86_400_000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/** Every distinct skill listed by any dispatch-enabled technician; falls back to one shared bucket. */
function bucketsFromTechnicians(technicians: TeamMember[]): string[] {
  const skills = new Set<string>();
  for (const tech of technicians) {
    for (const skill of tech.skills ?? []) {
      if (skill && skill.trim()) skills.add(skill.trim());
    }
  }
  return skills.size > 0 ? Array.from(skills) : [GENERAL_BUCKET];
}

async function fetchTechnicians(): Promise<TeamMember[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, member_name, role, skills, service_area, max_jobs_per_day, dispatch_enabled')
    .eq('dispatch_enabled', true);
  if (error || !data) return [];
  return (data as TeamMember[]).filter((t) => t.role === 'technician' || t.role === 'owner' || t.role === 'admin');
}

async function fetchOpenJobsInWindow(startIso: string, endIso: string): Promise<Job[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, service_type, scheduled_datetime, customer_id, customer_name, customer_phone, invoice_amount, job_status')
    .gte('scheduled_datetime', startIso)
    .lt('scheduled_datetime', endIso);
  if (error || !data) return [];
  return (data as Job[]).filter((j) => OPEN_JOB_STATUSES.has(j.job_status));
}

async function fetchOpenLeads(): Promise<Lead[]> {
  const { data, error } = await supabase
    .from('leads')
    .select('id, name, phone, service_interested, stage, quote_amount, created_at');
  if (error || !data) return [];
  return (data as Lead[]).filter((l) => OPEN_LEAD_STAGES.has(l.stage));
}

async function fetchWaitlist(): Promise<CapacityWaitlistEntry[]> {
  const { data, error } = await supabase
    .from('capacity_waitlist_entries')
    .select('*')
    .eq('status', 'waiting');
  if (error || !data) return [];
  return data as CapacityWaitlistEntry[];
}

/** Best-effort LTV: paid job history for customers matched by phone. Never throws. */
async function fetchLtvByPhone(lookbackDays: number): Promise<Map<string, number>> {
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('jobs')
    .select('customer_phone, invoice_amount, invoice_status')
    .eq('invoice_status', 'paid')
    .gte('created_at', since);
  if (error || !data) return new Map();
  const map = new Map<string, number>();
  for (const row of data as Pick<Job, 'customer_phone' | 'invoice_amount' | 'invoice_status'>[]) {
    if (!row.customer_phone || !row.invoice_amount) continue;
    const key = normalizePhoneDigits(row.customer_phone);
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + row.invoice_amount);
  }
  return map;
}

/** Best-effort lifecycle stage + service zone lookup by phone. Never throws. */
async function fetchCustomerInfoByPhone(): Promise<
  Map<string, { lifecycleStage: Customer['lifecycle_stage']; zone: string | null }>
> {
  const { data, error } = await supabase.from('customers').select('phone, lifecycle_stage, address');
  if (error || !data) return new Map();
  const map = new Map<string, { lifecycleStage: Customer['lifecycle_stage']; zone: string | null }>();
  for (const row of data as Pick<Customer, 'phone' | 'lifecycle_stage' | 'address'>[]) {
    if (!row.phone) continue;
    map.set(normalizePhoneDigits(row.phone), { lifecycleStage: row.lifecycle_stage, zone: parseLocality(row.address) });
  }
  return map;
}

function matchesBucket(serviceLabel: string | null | undefined, bucket: string): boolean {
  if (bucket === GENERAL_BUCKET) return true;
  if (!serviceLabel) return false;
  return serviceLabel.toLowerCase().includes(bucket.toLowerCase()) || bucket.toLowerCase().includes(serviceLabel.toLowerCase());
}

function lifecycleBonusCents(stage: Customer['lifecycle_stage'] | null, assumptions: MarketMakerAssumptions): number {
  if (stage === 'vip') return assumptions.vipBonusCents;
  if (stage === 'active') return assumptions.activeBonusCents;
  return 0;
}

// ============================================================
// Main entry point
// ============================================================

export async function buildMarketMakerPlan(): Promise<MarketMakerPlan> {
  const { windowDays, scarceUtilizationPct } = MARKET_MAKER_ASSUMPTIONS;
  const { startIso, endIso } = windowBounds(windowDays);

  const [technicians, jobs, leads, waitlist, ltvByPhone, customerInfoByPhone] = await Promise.all([
    fetchTechnicians().catch(() => []),
    fetchOpenJobsInWindow(startIso, endIso).catch(() => []),
    fetchOpenLeads().catch(() => []),
    fetchWaitlist().catch(() => []),
    fetchLtvByPhone(MARKET_MAKER_ASSUMPTIONS.ltvLookbackDays).catch(() => new Map<string, number>()),
    fetchCustomerInfoByPhone().catch(
      () => new Map<string, { lifecycleStage: Customer['lifecycle_stage']; zone: string | null }>(),
    ),
  ]);

  const buckets = bucketsFromTechnicians(technicians);

  const allBuckets: BucketUtilization[] = buckets.map((bucket) => {
    const skilledTechs =
      bucket === GENERAL_BUCKET ? technicians : technicians.filter((t) => (t.skills ?? []).includes(bucket));
    const capacityUnits = (skilledTechs.length > 0 ? skilledTechs : technicians).reduce(
      (sum, t) => sum + (t.max_jobs_per_day || 6) * windowDays,
      0,
    );
    const scheduledDemand = jobs.filter((j) => matchesBucket(j.service_type, bucket)).length;
    const pendingLeadDemand = leads.filter((l) => matchesBucket(l.service_interested, bucket)).length;
    const pendingWaitlistDemand = waitlist.filter((w) => matchesBucket(w.service_type, bucket)).length;
    const demandUnits = scheduledDemand + pendingLeadDemand + pendingWaitlistDemand;
    const utilizationPct = capacityUnits > 0 ? Math.round((demandUnits / capacityUnits) * 100) : demandUnits > 0 ? 999 : 0;
    return {
      serviceType: bucket,
      capacityUnits,
      demandUnits,
      utilizationPct,
      techniciansSkilled: skilledTechs.length,
    };
  });

  const sorted = [...allBuckets].sort((a, b) => b.utilizationPct - a.utilizationPct);
  const topBucket = sorted[0] ?? null;
  const bottleneck = topBucket && topBucket.utilizationPct >= scarceUtilizationPct ? topBucket : null;
  const slackBucket = sorted.length > 1 ? sorted[sorted.length - 1] : null;

  const candidates: AllocationCandidate[] = [];
  const recommendations: MarketMakerRecommendations = { booking: [], pricing: [], marketing: [], dispatch: [] };

  if (!bottleneck) {
    recommendations.booking.push(
      technicians.length === 0
        ? 'No dispatch-enabled technicians configured yet — connect your team before this map can find a real bottleneck.'
        : `No category is currently scarce (highest utilization: ${topBucket?.serviceType ?? 'n/a'} at ${topBucket?.utilizationPct ?? 0}%). Capacity is healthy across the board — safe to keep booking normally.`,
    );
  } else {
    for (const w of waitlist.filter((entry) => matchesBucket(entry.service_type, bottleneck.serviceType))) {
      const phoneKey = w.customer_phone ? normalizePhoneDigits(w.customer_phone) : '';
      const ltv = phoneKey ? ltvByPhone.get(phoneKey) ?? 0 : 0;
      const info = phoneKey ? customerInfoByPhone.get(phoneKey) : undefined;
      const base = MARKET_MAKER_ASSUMPTIONS.fallbackJobValueCents;
      const valueScoreCents =
        base + ltv * MARKET_MAKER_ASSUMPTIONS.ltvWeight + lifecycleBonusCents(info?.lifecycleStage ?? null, MARKET_MAKER_ASSUMPTIONS);
      candidates.push({
        id: `wl-${w.id}`,
        source: 'waitlist',
        customerName: w.customer_name,
        zone: info?.zone ?? null,
        estimatedValueCents: base,
        customerLtvCents: ltv,
        lifecycleStage: info?.lifecycleStage ?? null,
        valueScoreCents,
        decision: 'hold',
        reason: 'On the capacity waitlist for this category.',
      });
    }
    for (const l of leads.filter((lead) => matchesBucket(lead.service_interested, bottleneck.serviceType))) {
      const phoneKey = l.phone ? normalizePhoneDigits(l.phone) : '';
      const ltv = phoneKey ? ltvByPhone.get(phoneKey) ?? 0 : 0;
      const info = phoneKey ? customerInfoByPhone.get(phoneKey) : undefined;
      const base = l.quote_amount ?? MARKET_MAKER_ASSUMPTIONS.fallbackJobValueCents;
      const valueScoreCents =
        base + ltv * MARKET_MAKER_ASSUMPTIONS.ltvWeight + lifecycleBonusCents(info?.lifecycleStage ?? null, MARKET_MAKER_ASSUMPTIONS);
      candidates.push({
        id: `ld-${l.id}`,
        source: 'lead',
        customerName: l.name,
        zone: info?.zone ?? null,
        estimatedValueCents: base,
        customerLtvCents: ltv,
        lifecycleStage: info?.lifecycleStage ?? null,
        valueScoreCents,
        decision: 'hold',
        reason: `Open lead (${l.stage}) requesting this category.`,
      });
    }

    candidates.sort((a, b) => b.valueScoreCents - a.valueScoreCents);
    const openSlots = Math.max(bottleneck.capacityUnits - (bottleneck.demandUnits - candidates.length), 0);
    const prioritizeCount = Math.min(candidates.length, Math.max(openSlots, 1));
    candidates.forEach((c, i) => {
      if (i < prioritizeCount) {
        c.decision = 'prioritize';
        c.reason = `Highest long-term value (rank ${i + 1} of ${candidates.length}) for the ${openSlots || 1} realistic open slot(s) left this window.`;
      } else if (i < prioritizeCount + 2) {
        c.decision = 'hold';
        c.reason = `Next in line if a prioritized booking cancels or reschedules.`;
      } else {
        c.decision = 'defer';
        c.reason = `Lower long-term value than the ${prioritizeCount} customers being prioritized — better to waitlist than to displace them.`;
      }
    });

    const prioritized = candidates.filter((c) => c.decision === 'prioritize');
    const deferred = candidates.filter((c) => c.decision === 'defer');

    recommendations.booking.push(
      prioritized.length > 0
        ? `Offer the next ${prioritized.length} ${bottleneck.serviceType} slot(s) to: ${prioritized.map((c) => c.customerName).join(', ')} — ranked by long-term value, not first-come order.`
        : `${bottleneck.serviceType} is at ${bottleneck.utilizationPct}% utilization with no scored demand pool yet — new requests should go straight to the waitlist.`,
    );
    const prioritizedZones = Array.from(new Set(prioritized.map((c) => c.zone).filter((z): z is string => !!z)));
    if (prioritizedZones.length > 0) {
      recommendations.booking.push(
        `These prioritized slots cluster in ${prioritizedZones.join(', ')} — route the technician's day around that zone instead of criss-crossing for lower-value stops.`,
      );
    }
    if (deferred.length > 0) {
      recommendations.booking.push(
        `Move ${deferred.length} lower-value ${bottleneck.serviceType} request(s) to the waitlist rather than scheduling them ahead of the customers above: ${deferred.map((c) => c.customerName).join(', ')}.`,
      );
    }

    recommendations.pricing.push(
      `${bottleneck.serviceType} is effectively sold out this week (${bottleneck.utilizationPct}% utilization). Consider a ${MARKET_MAKER_ASSUMPTIONS.surgePricingPct}% premium on new ${bottleneck.serviceType} quotes until capacity opens up — protects margin on the scarce hours instead of racing to fill them.`,
    );

    recommendations.marketing.push(
      `Pause any active campaign generating more ${bottleneck.serviceType} leads this week — every new lead just lengthens a queue you can't staff.`,
    );
    if (slackBucket && slackBucket.serviceType !== bottleneck.serviceType) {
      recommendations.marketing.push(
        `Redirect that spend toward ${slackBucket.serviceType}, which has the most open capacity right now (${slackBucket.utilizationPct}% utilization).`,
      );
    }

    const skilledNames = technicians
      .filter((t) => (t.skills ?? []).includes(bottleneck.serviceType))
      .map((t) => t.member_name || t.member_email)
      .join(', ');
    recommendations.dispatch.push(
      bottleneck.techniciansSkilled <= 1
        ? `Only ${bottleneck.techniciansSkilled} technician (${skilledNames || 'unnamed'}) covers ${bottleneck.serviceType} — a single absence would zero out this category's capacity. This is the real constraint, not any one job.`
        : `${bottleneck.techniciansSkilled} technicians cover ${bottleneck.serviceType}: ${skilledNames}.`,
    );
    if (slackBucket && slackBucket.serviceType !== bottleneck.serviceType && slackBucket.techniciansSkilled > 0) {
      recommendations.dispatch.push(
        `Consider cross-training a technician from ${slackBucket.serviceType} (currently ${slackBucket.utilizationPct}% utilized) into ${bottleneck.serviceType} to relieve the bottleneck long-term.`,
      );
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    bottleneck,
    slackBucket,
    allBuckets: sorted,
    candidates,
    recommendations,
    assumptions: MARKET_MAKER_ASSUMPTIONS,
  };
}

export function formatCents(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

export const DECISION_LABELS: Record<AllocationDecision, string> = {
  prioritize: 'Prioritize',
  hold: 'Hold in line',
  defer: 'Defer to waitlist',
};

export const DECISION_COLORS: Record<AllocationDecision, string> = {
  prioritize: 'bg-success-500/10 text-success-500',
  hold: 'bg-warning-500/10 text-warning-500',
  defer: 'bg-bg-tertiary text-text-secondary',
};
