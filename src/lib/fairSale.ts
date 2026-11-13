/**
 * Fair Sale Protocol — client data layer.
 * All writes go through SECURITY DEFINER RPCs (20281102000100_fair_sale_protocol.sql); reads use RLS.
 * Keep CONFIG_BOUNDS in sync with the CHECK constraints of public.fair_sale_settings.
 */
import { supabase } from '@/lib/supabase';

export class FairSaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FairSaleError';
  }
}

export interface FairSaleConfig {
  largeJobCents: number;
  largeDepositCents: number;
  largeDepositPercent: number;
  scopeEscalationPercent: number;
  pauseThresholdCents: number;
  pauseHours: number;
  managerApprovalDepositCents: number;
  managerApprovalFinancing: boolean;
  confusionRepeatThreshold: number;
}

/** [min, max] in raw units (cents / percent / hours / count). */
export const CONFIG_BOUNDS = {
  largeJobCents: [50000, 2000000],
  largeDepositCents: [10000, 1000000],
  largeDepositPercent: [5, 50],
  scopeEscalationPercent: [10, 100],
  pauseThresholdCents: [50000, 1000000],
  pauseHours: [12, 168],
  managerApprovalDepositCents: [10000, 1000000],
  confusionRepeatThreshold: [2, 4],
} as const;

export type ReviewDecision = 'approved' | 'changes_requested' | 'declined';

export interface FairSaleReview {
  id: string;
  session_id: string;
  kind: string;
  reason: string;
  blocking: boolean;
  status: 'open' | ReviewDecision;
  requested_at: string;
  decided_at: string | null;
  decided_by_email: string | null;
  decision_notes: string | null;
  self_review: boolean;
}

export interface FairSaleEvent {
  id: number;
  session_id: string;
  event_type: string;
  protection: string | null;
  choice: string | null;
  signal_codes: string[];
  actor_type: string;
  created_at: string;
}

/** Strips the `fair_sale_xxx:` prefix the RPCs raise with. */
function cleanMessage(raw: string | undefined): string {
  const m = (raw ?? '').trim();
  if (!m) return 'Request failed.';
  if (/^fair_sale_forbidden$/i.test(m)) return 'You do not have permission to do this.';
  return m.replace(/^fair_sale_[a-z_]+:\s*/i, '');
}

export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export async function fetchSettings(): Promise<FairSaleConfig> {
  const { data, error } = await supabase.rpc('fair_sale_get_settings');
  if (error) throw new FairSaleError(cleanMessage(error.message));
  return data as FairSaleConfig;
}

export async function saveSettings(config: FairSaleConfig): Promise<FairSaleConfig> {
  const { data, error } = await supabase.rpc('fair_sale_save_settings', { p: config });
  if (error) throw new FairSaleError(cleanMessage(error.message));
  return data as FairSaleConfig;
}

export async function listReviews(limit = 100): Promise<FairSaleReview[]> {
  const { data, error } = await supabase
    .from('fair_sale_reviews')
    .select('id, session_id, kind, reason, blocking, status, requested_at, decided_at, decided_by_email, decision_notes, self_review')
    .order('requested_at', { ascending: false })
    .limit(limit);
  if (error) throw new FairSaleError(cleanMessage(error.message));
  return (data ?? []) as FairSaleReview[];
}

export async function decideReview(reviewId: string, decision: ReviewDecision, notes: string): Promise<void> {
  const { error } = await supabase.rpc('fair_sale_decide_review', { p_review: reviewId, p_decision: decision, p_notes: notes });
  if (error) throw new FairSaleError(cleanMessage(error.message));
}

export async function listEvents(limit = 100): Promise<FairSaleEvent[]> {
  const { data, error } = await supabase
    .from('fair_sale_events')
    .select('id, session_id, event_type, protection, choice, signal_codes, actor_type, created_at')
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw new FairSaleError(cleanMessage(error.message));
  return (data ?? []) as FairSaleEvent[];
}

/** Returns the first tampered event id, or null when the session's chain is intact. */
export async function verifyChain(sessionId: string): Promise<number | null> {
  const { data, error } = await supabase.rpc('fair_sale_verify_chain', { p_session: sessionId });
  if (error) throw new FairSaleError(cleanMessage(error.message));
  return data === null || data === undefined ? null : Number(data);
}

/** Public (no sign-in): customer withdraws a trusted-contact consent with the token from their link. */
export async function revokeWithToken(token: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('fair-sale-public', { body: { action: 'revoke', token } });
  if (error) throw new FairSaleError(error.message);
  if (!(data as { ok?: boolean } | null)?.ok) throw new FairSaleError('revoke_failed');
}
