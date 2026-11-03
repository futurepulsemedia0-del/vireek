// supabase/functions/_shared/agent-callers/funnel.ts
// Pure funnel + win-rate maths for the dashboard: AI-agent leads vs human leads.
// calls -> quotes given -> holds -> confirmed jobs. Win rate = confirmed / calls (same denominator for both cohorts).

export interface FunnelCall {
  id: string;
  kind: "human" | "ai_agent" | "unknown";
  /** calls.status === 'booked' or booking_outcome === 'booked' (the existing definition of a won human lead). */
  booked: boolean;
}

export type AgentEventType =
  | "detected" | "quote_given" | "hold_created" | "hold_confirmed" | "hold_declined" | "hold_expired"
  | "summary_sent" | "summary_failed" | "injection_flagged" | "rate_limited" | "emergency_routed" | "refused_topic" | "out_of_area";

export interface FunnelEvent { callId: string; type: AgentEventType }

export interface FunnelStage { key: "calls" | "quotes" | "holds" | "confirmed"; count: number; /** share of the previous stage, null for the first. */ rate: number | null }
export interface Funnel { stages: FunnelStage[]; winRate: number | null; platforms: Record<string, number> }

const rate = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);

export function computeAgentFunnel(calls: FunnelCall[], events: FunnelEvent[], platformByCall: Record<string, string | null> = {}): Funnel {
  const agentIds = new Set(calls.filter((c) => c.kind === "ai_agent").map((c) => c.id));
  const has = (types: AgentEventType[]) => new Set(events.filter((e) => agentIds.has(e.callId) && types.includes(e.type)).map((e) => e.callId)).size;
  const quotes = has(["quote_given"]);
  const holds = has(["hold_created"]);
  // "Confirmed job": an owner-approved hold, an auto-booked hold, or the call row itself ended booked.
  const confirmedIds = new Set<string>(events.filter((e) => agentIds.has(e.callId) && e.type === "hold_confirmed").map((e) => e.callId));
  for (const c of calls) if (c.kind === "ai_agent" && c.booked) confirmedIds.add(c.id);
  const confirmed = confirmedIds.size;
  const platforms: Record<string, number> = {};
  for (const id of agentIds) {
    const p = platformByCall[id] ?? "unknown";
    platforms[p] = (platforms[p] ?? 0) + 1;
  }
  return {
    stages: [
      { key: "calls", count: agentIds.size, rate: null },
      { key: "quotes", count: quotes, rate: rate(quotes, agentIds.size) },
      { key: "holds", count: holds, rate: rate(holds, quotes) },
      { key: "confirmed", count: confirmed, rate: rate(confirmed, holds) },
    ],
    winRate: rate(confirmed, agentIds.size),
    platforms,
  };
}

/** Win rate of every non-agent call (human + unknown, because unknown is treated as human) on the same definition. */
export function computeHumanWinRate(calls: FunnelCall[]): { calls: number; won: number; winRate: number | null } {
  const human = calls.filter((c) => c.kind !== "ai_agent");
  const won = human.filter((c) => c.booked).length;
  return { calls: human.length, won, winRate: rate(won, human.length) };
}

/** Holds that expire within `withinMinutes` and are still awaiting a decision. */
export function holdsExpiringSoon<T extends { status: string; expiresAt: string }>(holds: T[], now: Date, withinMinutes = 15): T[] {
  const limit = now.getTime() + withinMinutes * 60_000;
  return holds.filter((h) => h.status === "held" && Date.parse(h.expiresAt) > now.getTime() && Date.parse(h.expiresAt) <= limit);
}
