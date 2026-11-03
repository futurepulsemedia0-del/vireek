/**
 * AI agent callers - pure domain logic shared with the voice path.
 * Detection, settings, safety, funnel maths live in supabase/functions/_shared/agent-callers (no Deno imports) and are
 * re-exported here, exactly like callBlocklist re-exports callBlockEngine. Network access: agentCallersApi.ts.
 */
export {
  DEFAULT_AGENT_CALLER_SETTINGS,
  LIMITS as AGENT_CALLER_LIMITS,
  normalizeAgentCallerSettings,
  normalizeZip,
  type AgentCallerSettings,
  type ApprovalMode,
  type FlatPriceMode,
} from '../../supabase/functions/_shared/agent-callers/settings';
export {
  computeAgentFunnel,
  computeHumanWinRate,
  holdsExpiringSoon,
  type AgentEventType,
  type Funnel,
  type FunnelCall,
  type FunnelEvent,
} from '../../supabase/functions/_shared/agent-callers/funnel';

export type HoldStatus = 'held' | 'confirmed' | 'declined' | 'expired';

export interface AgentHold {
  id: string;
  code: string;
  status: HoldStatus;
  mode: 'hold' | 'book';
  service: string | null;
  zip: string | null;
  window_start: string;
  expires_at: string | null;
  platform_claimed: string | null;
  call_id: string | null;
}

export interface AgentCallRow {
  id: string;
  call_datetime: string;
  caller_kind: 'human' | 'ai_agent' | 'unknown' | null;
  caller_kind_confidence: number | null;
  agent_platform_claimed: string | null;
  status: string | null;
  booking_outcome: string | null;
}

export interface AgentQuotableItem {
  id: string;
  service_name: string;
  category: string | null;
  agent_quotable: boolean;
}

/** Settings form <-> RPC payload (snake_case keys expected by update_agent_caller_settings). */
export function settingsToPayload(s: import('../../supabase/functions/_shared/agent-callers/settings').AgentCallerSettings): Record<string, unknown> {
  return {
    enabled: s.enabled,
    approval_mode: s.approvalMode,
    max_holds_per_day: s.maxHoldsPerDay,
    hold_minutes: s.holdMinutes,
    flat_price_mode: s.flatPriceMode,
    flat_range_percent: s.flatRangePercent,
    blocked_zips: s.blockedZips,
    never_discuss: s.neverDiscuss,
    allow_sms_summary: s.allowSmsSummary,
    allow_email_summary: s.allowEmailSummary,
    max_quotes_per_caller_per_day: s.maxQuotesPerCallerPerDay,
    max_distinct_services_per_caller_per_day: s.maxDistinctServicesPerCallerPerDay,
    max_quotes_per_hour_tenant: s.maxQuotesPerHourTenant,
    max_summaries_per_day: s.maxSummariesPerDay,
    retention_days: s.retentionDays,
  };
}

/** One entry per non-empty line, trimmed and de-duplicated. */
export function parseLines(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
}

/** Caller lines of a call transcript ("what the agent asked"). */
export function callerLines(turns: { role: 'caller' | 'agent' | 'unknown'; text: string }[]): string[] {
  return turns.filter((t) => t.role === 'caller').map((t) => t.text.trim()).filter(Boolean);
}
