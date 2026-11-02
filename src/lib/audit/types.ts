// Types mirror supabase/functions/_shared/audit (service.ts reportDto etc.). Kept as a separate copy: the Edge Function
// code is Deno and is not importable from the Vite bundle.
export type Condition = 'business_hours' | 'lunch' | 'after_hours';
export type Band = 'strong' | 'fair' | 'leaking' | 'critical';
export interface Range { low: number; point: number; high: number }
export interface SubScore { score: number | null; weight: number; basis: string; calls: number[] }
export interface Finding { id: string; severity: 'good' | 'info' | 'warn' | 'critical'; title: string; detail: string; evidence: { slot: number; condition: Condition }[] }
export interface FixStep { id: string; title: string; detail: string; vireek_can_help: boolean }
export interface ScoreResult {
  total: number | null; band: Band | null; confidence: 'ok' | 'limited' | 'low';
  conclusive_calls: number; inconclusive_calls: number;
  sub: Record<'answer_rate' | 'speed_to_answer' | 'voicemail_quality' | 'after_hours_coverage' | 'booking_readiness', SubScore>;
  findings: Finding[]; fix_path: FixStep[];
}
export interface AssumptionRow { key: string; label: string; value: number; source: 'default' | 'owner'; unit?: string; min?: number; max?: number }
export interface RevenueAtRisk { monthly: Range; annual: Range; miss_rate: Range; sample_size: number; is_placeholder: boolean; assumptions: AssumptionRow[]; notes: string[] }
export interface BusinessHours { days: number[]; open: string; close: string }
export interface ProposedSlot { condition: Condition; scheduled_for: string; window_end?: string }
export interface PublicConfig {
  available: boolean; calls_available: boolean; turnstile_site_key: string | null; consent_version: string;
  consent: { otp_message: string; ai_test_calls: string; email_followup: string };
  trades: string[]; default_hours: BusinessHours;
}
export interface ReportCall { slot: number; condition: Condition; status: string; scheduled_for: string; window_end: string; answer_kind: string | null; ring_seconds: number | null; duration_seconds: number | null; skip_reason: string | null }
export interface Report {
  view: 'owner' | 'shared'; status: string; provisional: boolean; business_name: string; trade: string; timezone: string;
  created_at: string; expires_at: string; score: ScoreResult;
  timeline: { at: string; label: string; slot: number | null }[]; calls: ReportCall[]; not_tested: Condition[];
  revenue?: RevenueAtRisk; benchmark?: { n: number; total_p50: number } | null; can_cancel?: boolean; can_schedule?: boolean;
  share_enabled?: boolean; masked_phone?: string; masked_email?: string; followup_opt_in?: boolean; trial_url?: string;
}
export interface ApiError { error: string; message?: string }
