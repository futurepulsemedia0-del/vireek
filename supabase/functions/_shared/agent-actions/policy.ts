// supabase/functions/_shared/agent-actions/policy.ts
//
// Pure decision function. No I/O, no clock, no randomness: given the same inputs it always answers the same,
// which is what makes "an agent cannot exceed its scope" provable by test.
//
// Hard blocks can never be overridden (not even by a human approval): paused account, tool disabled, missing
// scope, suspected injection, untrusted-denied, `block` limits. Soft escalations only move an action from
// "auto" to "needs a human"; a human approval clears them.

import type { Autonomy, Limit, Measures, PolicySnapshot, ToolDefinition, UntrustedSource } from './types.ts';
import { minAutonomy } from './types.ts';

export const INJECTION_BLOCK_SCORE = 70;
export const DEFAULT_RATE = { agentCalls: 30, windowSec: 60 } as const;

export interface Reservation {
  kind: 'spend_cents' | 'messages' | 'rate_calls';
  amount: number;
  checks: { agentId: string | null; toolSlug: string | null; windowSec: number; cap: number; onExceed: 'block' | 'approval' }[];
}

export type PolicyDecision =
  | { decision: 'block'; code: string; reasons: string[] }
  | { decision: 'proceed'; autonomy: Autonomy; escalations: string[]; reservations: Reservation[] };

export interface PolicyArgs {
  mode: 'propose' | 'approve';
  tool: ToolDefinition;
  input: unknown;
  agentId: string;
  sources: readonly UntrustedSource[];
  snapshot: PolicySnapshot;
  /** `agent_auto_actions` kill switch (global or this account): no autonomous execution, humans still can. */
  autoStopped: boolean;
  nowMs: number;
  injectionBlockScore?: number;
}

type WindowedLimit = Extract<Limit, { windowSec: number }>;
const applies = (l: Limit, agentId: string, slug: string) => (l.agentId === null || l.agentId === agentId) && (l.toolSlug === null || l.toolSlug === slug);

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Fails closed: an unknown time zone counts as "outside the window". */
export function insideTimeWindow(w: { days: number[]; startMin: number; endMin: number; tz: string }, nowMs: number): boolean {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: w.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowMs));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const day = DOW[get('weekday')];
    const minutes = Number(get('hour')) * 60 + Number(get('minute'));
    if (day === undefined || Number.isNaN(minutes)) return false;
    if (w.startMin <= w.endMin) return w.days.includes(day) && minutes >= w.startMin && minutes < w.endMin;
    // window crosses midnight: the part after midnight belongs to the previous day's window
    return (w.days.includes(day) && minutes >= w.startMin) || (w.days.includes((day + 6) % 7) && minutes < w.endMin);
  } catch { return false; }
}

export function evaluatePolicy(a: PolicyArgs): PolicyDecision {
  const { tool, snapshot: snap } = a;
  const block = (code: string, ...reasons: string[]): PolicyDecision => ({ decision: 'block', code, reasons });

  if (!snap.moduleEnabled) return block('module_disabled', 'Agent actions are not enabled for this account.');
  if (snap.paused) return block('account_paused', 'The account owner paused all agent actions.');
  if (snap.toolPolicy && !snap.toolPolicy.enabled) return block('tool_disabled', `${tool.slug} is disabled for this account.`);

  const missing = tool.scopes.filter((sc) => !(sc in snap.agentGrants));
  if (missing.length) return block('scope_denied', `Agent lacks scope: ${missing.join(', ')}`);

  const tainted = a.sources.length > 0;
  const maxScore = a.sources.reduce((m, s) => Math.max(m, s.injectionScore), 0);
  if (maxScore >= (a.injectionBlockScore ?? INJECTION_BLOCK_SCORE)) return block('injection_suspected', 'External content looks like an attempt to instruct the agent.');
  if (tainted && tool.untrusted === 'deny') return block('untrusted_denied', `${tool.slug} may not be driven by external content.`);

  const measures: Measures = tool.measure ? tool.measure(a.input) : {};
  const escalations: string[] = [];
  const reservations: Reservation[] = [];
  const relevant = snap.limits.filter((l) => applies(l, a.agentId, tool.slug));

  for (const l of relevant) {
    if (l.kind === 'discount_pct' && (measures.discountPct ?? 0) > l.max) {
      if (l.onExceed === 'block') return block('discount_cap', `Discount exceeds the ${l.max}% cap.`);
      escalations.push('discount_cap');
    }
    if (l.kind === 'time_window' && !insideTimeWindow(l, a.nowMs)) {
      if (l.onExceed === 'block') return block('outside_time_window', 'Outside the allowed time window.');
      escalations.push('time_window');
    }
  }

  const reserve = (kind: 'spend_cents' | 'messages', amount: number | undefined) => {
    if (!amount || amount <= 0) return;
    const checks = relevant.filter((l): l is WindowedLimit => l.kind === kind)
      .map((l) => ({ agentId: l.agentId, toolSlug: l.toolSlug, windowSec: l.windowSec, cap: l.max, onExceed: l.onExceed }));
    reservations.push({ kind, amount, checks });
  };
  reserve('spend_cents', measures.spendCents);
  reserve('messages', measures.messages);

  const rate = relevant.filter((l): l is WindowedLimit => l.kind === 'rate_calls')
    .map((l) => ({ agentId: l.agentId, toolSlug: l.toolSlug, windowSec: l.windowSec, cap: l.max, onExceed: 'block' as const }));
  rate.push({ agentId: a.agentId, toolSlug: null, windowSec: DEFAULT_RATE.windowSec, cap: DEFAULT_RATE.agentCalls, onExceed: 'block' });
  reservations.push({ kind: 'rate_calls', amount: 1, checks: rate });

  if (a.mode === 'approve') return { decision: 'proceed', autonomy: 'require_approval', escalations: [], reservations };

  let autonomy = minAutonomy(tool.maxAutonomy, snap.toolPolicy?.autonomy ?? tool.defaultAutonomy, ...tool.scopes.map((sc) => snap.agentGrants[sc]));
  if (tainted && tool.untrusted === 'approval') autonomy = minAutonomy(autonomy, 'require_approval');
  if (autonomy === 'auto_notify' && a.autoStopped) { autonomy = 'require_approval'; escalations.push('auto_actions_stopped'); }
  return { decision: 'proceed', autonomy, escalations, reservations };
}
