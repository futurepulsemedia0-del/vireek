/**
 * Agent Disagreement Chamber — pure, deterministic, explainable.
 *
 * Specialist agents (revenue, dispatch, finance, quality) each optimise a
 * different objective, so they can disagree. This module never hides that:
 * it lays out every position, finds the exact points of conflict, quantifies
 * the financial and operational trade-off, then applies a CEO arbitration whose
 * rules are written out below and readable in code.
 *
 * Scope: outbound campaign go / no-go decisions.
 * No I/O here; agentChamberApi.ts gathers signals and persists cases.
 */

export type AgentRole = 'revenue' | 'dispatch' | 'finance' | 'quality';
export type Stance = 'support' | 'conditional' | 'oppose';
export type Focus = 'revenue' | 'capacity' | 'margin' | 'quality';
export type CeoAction = 'launch' | 'launch_capped' | 'defer';

export interface AgentPosition {
  role: AgentRole;
  agentName: string;
  objective: string;
  focus: Focus;
  stance: Stance;
  proposal: string;
  reason: string;
}

export interface Conflict {
  between: [supporter: AgentRole, opposer: AgentRole];
  focus: Focus;
  description: string;
}

export interface CampaignSignals {
  campaignName: string;
  audienceSize: number;
  conversionPct: number;
  avgTicketCents: number;
  hoursPerJob: number;
  freeTechnicianHours: number;
  technicianCount: number;
  unassignedSoonJobs: number;
  marginPct: number | null;
  callbackPct: number | null;
  constitutionBlocked: boolean;
}

export interface Tradeoff {
  fullBookings: number;
  fullRevenueCents: number;
  hoursNeeded: number;
  hoursUsable: number;
  cappedBookings: number;
  cappedRevenueCents: number;
  cappedAudience: number;
  marginCents: number | null;
}

export interface CeoDecision {
  action: CeoAction;
  audienceCap: number | null;
  headline: string;
  reasons: string[];
  confidence: 'low' | 'medium' | 'high';
}

export interface ChamberCase {
  title: string;
  positions: AgentPosition[];
  conflicts: Conflict[];
  tradeoff: Tradeoff;
  ceo: CeoDecision;
}

export const CHAMBER = {
  marginFloorPct: 25,
  callbackCeilingPct: 15,
  capacityBufferPct: 10,
  minCappedShare: 0.4,
  minSamples: 10,
  weeklyHoursPerTechnician: 40,
  defaultHoursPerJob: 2,
  defaultConversionPct: 25,
  urgentWindowHours: 48,
} as const;

const AGENTS: Record<AgentRole, { name: string; objective: string }> = {
  revenue: { name: 'Revenue Agent', objective: 'Maximise booked revenue from the campaign.' },
  dispatch: { name: 'Dispatch Agent', objective: 'Keep every job on time with a technician assigned.' },
  finance: { name: 'Finance Agent', objective: 'Protect gross margin and cash.' },
  quality: { name: 'Quality Agent', objective: 'Protect the first-visit fix rate and SLA commitments.' },
};

const round1 = (x: number) => Math.round(x * 10) / 10;
const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

export function tradeoffOf(s: CampaignSignals): Tradeoff {
  const conv = Math.max(0, s.conversionPct) / 100;
  const hoursPerJob = Math.max(s.hoursPerJob, 0.1);
  const usable = s.freeTechnicianHours * (1 - CHAMBER.capacityBufferPct / 100);

  const fullBookings = s.audienceSize * conv;
  const cappedBookings = Math.max(0, Math.min(fullBookings, usable / hoursPerJob));
  const fullRevenueCents = Math.round(fullBookings * s.avgTicketCents);

  return {
    fullBookings: round1(fullBookings),
    fullRevenueCents,
    hoursNeeded: round1(fullBookings * hoursPerJob),
    hoursUsable: round1(usable),
    cappedBookings: round1(cappedBookings),
    cappedRevenueCents: Math.round(cappedBookings * s.avgTicketCents),
    cappedAudience: conv > 0 ? Math.floor(cappedBookings / conv) : 0,
    marginCents: s.marginPct === null ? null : Math.round((fullRevenueCents * s.marginPct) / 100),
  };
}

function dispatchPosition(s: CampaignSignals, t: Tradeoff): AgentPosition {
  const base = { role: 'dispatch' as const, agentName: AGENTS.dispatch.name, objective: AGENTS.dispatch.objective, focus: 'capacity' as const };
  const load = `${t.hoursNeeded}h of work against ${t.hoursUsable}h of usable technician time`;

  if (s.technicianCount === 0) {
    return { ...base, stance: 'oppose', proposal: 'Hold the campaign', reason: 'There are no technicians on the team.' };
  }
  if (s.unassignedSoonJobs > 0) {
    return {
      ...base, stance: 'oppose', proposal: 'Hold the campaign',
      reason: `${s.unassignedSoonJobs} job(s) start within ${CHAMBER.urgentWindowHours}h with no technician assigned.`,
    };
  }
  if (t.hoursNeeded > t.hoursUsable) {
    return {
      ...base, stance: 'oppose', proposal: 'Protect the current schedule',
      reason: `${load}: ${round1(t.hoursNeeded - t.hoursUsable)}h short.`,
    };
  }
  if (t.hoursNeeded > 0.8 * t.hoursUsable) {
    return { ...base, stance: 'conditional', proposal: 'Book only if the schedule holds', reason: `${load}: fits, but leaves little slack.` };
  }
  return { ...base, stance: 'support', proposal: 'Book the campaign into the current schedule', reason: `${load}: fits.` };
}

function financePosition(s: CampaignSignals): AgentPosition {
  const base = { role: 'finance' as const, agentName: AGENTS.finance.name, objective: AGENTS.finance.objective, focus: 'margin' as const };
  if (s.marginPct === null) {
    return { ...base, stance: 'conditional', proposal: 'Proceed once margin is confirmed', reason: 'No margin history yet, so the campaign’s margin effect cannot be confirmed.' };
  }
  const margin = round1(s.marginPct);
  if (s.marginPct < CHAMBER.marginFloorPct) {
    return { ...base, stance: 'oppose', proposal: 'Hold discounting until pricing is reviewed', reason: `Gross margin is ${margin}%, below the ${CHAMBER.marginFloorPct}% floor.` };
  }
  return { ...base, stance: 'support', proposal: 'Proceed', reason: `Gross margin of ${margin}% clears the ${CHAMBER.marginFloorPct}% floor.` };
}

function qualityPosition(s: CampaignSignals): AgentPosition {
  const base = { role: 'quality' as const, agentName: AGENTS.quality.name, objective: AGENTS.quality.objective, focus: 'quality' as const };
  if (s.callbackPct === null) {
    return { ...base, stance: 'conditional', proposal: 'Proceed once callback data exists', reason: 'No callback history yet.' };
  }
  const cb = round1(s.callbackPct);
  if (s.callbackPct > CHAMBER.callbackCeilingPct) {
    return { ...base, stance: 'oppose', proposal: 'Fix quality before adding demand', reason: `Callback rate is ${cb}%, above the ${CHAMBER.callbackCeilingPct}% ceiling.` };
  }
  return { ...base, stance: 'support', proposal: 'Proceed', reason: `Callback rate of ${cb}% is within the ceiling.` };
}

export function positionsFor(s: CampaignSignals, t: Tradeoff): AgentPosition[] {
  const revenue: AgentPosition = {
    role: 'revenue',
    agentName: AGENTS.revenue.name,
    objective: AGENTS.revenue.objective,
    focus: 'revenue',
    stance: 'support',
    proposal: `Launch “${s.campaignName}” to ${s.audienceSize.toLocaleString('en-US')} contacts`,
    reason: `About ${t.fullBookings} bookings worth ${dollars(t.fullRevenueCents)}.`,
  };
  return [revenue, dispatchPosition(s, t), financePosition(s), qualityPosition(s)];
}

function conflictBetween(supporter: AgentPosition, opposer: AgentPosition): Conflict {
  return {
    between: [supporter.role, opposer.role],
    focus: opposer.focus,
    description: `${supporter.agentName} says “${supporter.proposal}”, but ${opposer.agentName} opposes it: ${opposer.reason}`,
  };
}

/** Every supporter–opposer pair is a conflict. Conditional positions are not conflicts. */
export function conflictsOf(positions: AgentPosition[]): Conflict[] {
  const out: Conflict[] = [];
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      const a = positions[i];
      const b = positions[j];
      if (a.stance === 'support' && b.stance === 'oppose') out.push(conflictBetween(a, b));
      else if (a.stance === 'oppose' && b.stance === 'support') out.push(conflictBetween(b, a));
    }
  }
  return out;
}

function deferWith(confidence: CeoDecision['confidence'], reasons: string[]): CeoDecision {
  return { action: 'defer', audienceCap: null, headline: 'Defer the campaign', reasons, confidence };
}

/** CEO arbitration. Rules run in priority order; the first blocking rule wins. */
export function arbitrate(s: CampaignSignals, t: Tradeoff, conflicts: Conflict[]): CeoDecision {
  const confidence: CeoDecision['confidence'] = conflicts.length === 0 ? 'high' : conflicts.length === 1 ? 'medium' : 'low';
  const tradeLine = `Full launch: ${t.fullBookings} bookings, ${dollars(t.fullRevenueCents)}, needs ${t.hoursNeeded}h against ${t.hoursUsable}h usable.`;

  if (s.constitutionBlocked) {
    return deferWith(confidence, ['A constitution rule blocks this campaign right now.', tradeLine]);
  }
  if (s.unassignedSoonJobs > 0) {
    return deferWith(confidence, [`${s.unassignedSoonJobs} job(s) start within ${CHAMBER.urgentWindowHours}h with no technician. Fill them before adding demand.`, tradeLine]);
  }
  if (s.callbackPct !== null && s.callbackPct > CHAMBER.callbackCeilingPct) {
    return deferWith(confidence, [`Callback rate ${round1(s.callbackPct)}% is above the ${CHAMBER.callbackCeilingPct}% ceiling. Fix quality first.`, tradeLine]);
  }
  if (s.marginPct !== null && s.marginPct < CHAMBER.marginFloorPct) {
    return deferWith(confidence, [`Gross margin ${round1(s.marginPct)}% is below the ${CHAMBER.marginFloorPct}% floor. Review pricing before discounting demand.`, tradeLine]);
  }
  if (t.hoursNeeded <= t.hoursUsable) {
    return {
      action: 'launch',
      audienceCap: null,
      headline: 'Launch the full campaign',
      reasons: [`The full audience fits the schedule with a ${CHAMBER.capacityBufferPct}% buffer.`, tradeLine],
      confidence,
    };
  }

  const capShare = t.fullRevenueCents > 0 ? t.cappedRevenueCents / t.fullRevenueCents : 0;
  if (t.cappedAudience > 0 && capShare >= CHAMBER.minCappedShare) {
    return {
      action: 'launch_capped',
      audienceCap: t.cappedAudience,
      headline: `Launch to ${t.cappedAudience} contacts`,
      reasons: [
        `The schedule absorbs about ${t.cappedBookings} bookings, which keeps ${Math.round(capShare * 100)}% of the full revenue.`,
        tradeLine,
      ],
      confidence,
    };
  }

  return deferWith(confidence, [
    `A capped launch would keep only ${Math.round(capShare * 100)}% of the revenue, below the ${Math.round(CHAMBER.minCappedShare * 100)}% minimum.`,
    tradeLine,
  ]);
}

export function buildChamberCase(s: CampaignSignals): ChamberCase {
  const tradeoff = tradeoffOf(s);
  const positions = positionsFor(s, tradeoff);
  const conflicts = conflictsOf(positions);
  return {
    title: `Campaign: ${s.campaignName}`,
    positions,
    conflicts,
    tradeoff,
    ceo: arbitrate(s, tradeoff, conflicts),
  };
}

// ============================================================
// SIGNALS FROM RAW DATA
// ============================================================

export interface ChamberRaw {
  scheduledJobs: { scheduled_datetime: string; duration_minutes: number | null; assigned_technician_id: string | null }[];
  completedJobs: { duration_minutes: number | null; invoice_amount: number | null }[];
  outcomes: { revenue_cents: number | null; cost_cents: number | null; caused_callback: boolean; is_rework: boolean }[];
  technicianCount: number;
  quoteWinRatePct: number | null;
}

export interface CampaignForm {
  campaignName: string;
  audienceSize: number;
  conversionPct: number | null;
  constitutionBlocked: boolean;
}

/** Builds campaign signals from raw rows. `scheduledJobs` covers the next 7 days. */
export function deriveCampaignSignals(raw: ChamberRaw, form: CampaignForm, now: number = Date.now()): CampaignSignals {
  const durations = raw.completedJobs.map((j) => j.duration_minutes ?? 0).filter((d) => d > 0);
  const hoursPerJob = durations.length > 0
    ? durations.reduce((s, d) => s + d, 0) / durations.length / 60
    : CHAMBER.defaultHoursPerJob;

  const tickets = raw.completedJobs.map((j) => j.invoice_amount ?? 0).filter((v) => v > 0);
  const avgTicketCents = tickets.length > 0
    ? Math.round((tickets.reduce((s, v) => s + v, 0) / tickets.length) * 100)
    : 0;

  const bookedHours = raw.scheduledJobs.reduce(
    (s, j) => s + (j.duration_minutes ?? CHAMBER.defaultHoursPerJob * 60) / 60,
    0,
  );
  const capacity = raw.technicianCount * CHAMBER.weeklyHoursPerTechnician;

  const soon = now + CHAMBER.urgentWindowHours * 3_600_000;
  const unassignedSoonJobs = raw.scheduledJobs.filter((j) => {
    const at = Date.parse(j.scheduled_datetime);
    return j.assigned_technician_id === null && at >= now && at <= soon;
  }).length;

  const priced = raw.outcomes.filter((o) => !o.is_rework && (o.revenue_cents ?? 0) > 0 && o.cost_cents !== null);
  const revenue = priced.reduce((s, o) => s + (o.revenue_cents ?? 0), 0);
  const cost = priced.reduce((s, o) => s + (o.cost_cents ?? 0), 0);
  const marginPct = priced.length >= CHAMBER.minSamples && revenue > 0 ? (1 - cost / revenue) * 100 : null;

  const fresh = raw.outcomes.filter((o) => !o.is_rework);
  const callbackPct = fresh.length >= CHAMBER.minSamples
    ? (fresh.filter((o) => o.caused_callback).length / fresh.length) * 100
    : null;

  return {
    campaignName: form.campaignName.trim() || 'Untitled campaign',
    audienceSize: Math.max(0, Math.round(form.audienceSize)),
    conversionPct: form.conversionPct ?? raw.quoteWinRatePct ?? CHAMBER.defaultConversionPct,
    avgTicketCents,
    hoursPerJob,
    freeTechnicianHours: Math.max(0, round1(capacity - bookedHours)),
    technicianCount: raw.technicianCount,
    unassignedSoonJobs,
    marginPct,
    callbackPct,
    constitutionBlocked: form.constitutionBlocked,
  };
}
