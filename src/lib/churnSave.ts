import { supabase } from '@/lib/supabase';

/**
 * Churn-save — staff client library for /staff/churn-save.
 * All writes go through audited SECURITY DEFINER RPCs (staff_churn_save_*); the database
 * enforces the same ceilings as validateDraft, which only exists for fast form feedback.
 */

export type OfferKind = 'pause' | 'downgrade' | 'discount';
export const OFFER_KINDS: OfferKind[] = ['pause', 'downgrade', 'discount'];
export const REASONS = ['too_expensive', 'missing_features', 'not_using', 'switching', 'closing_business', 'technical_issues', 'other'] as const;
export const BANDS = ['healthy', 'watch', 'at_risk', 'critical', 'new'] as const;
export const DOWNGRADE_PLANS = ['starter', 'professional'] as const;

/** Hard ceilings (mirror the CHECK constraints in 20290305000000_churn_save_offers.sql). */
export const LIMITS = { maxDiscountPercent: 50, maxDiscountMonths: 6, maxPauseMonths: 3, maxPerAccount: 3, maxCooldownDays: 730, maxWindowDays: 365 } as const;

export interface OfferStats {
  presented: number;
  declined: number;
  accepted: number;
  failed: number;
  in_cap_window: number;
  retention_cohort_30d: number;
  retained_30d: number;
}

export interface StaffOffer extends OfferStats {
  id: string;
  kind: OfferKind;
  name: string;
  enabled: boolean;
  priority: number;
  target_reasons: string[];
  target_bands: string[];
  pause_months: number | null;
  downgrade_plan: string | null;
  discount_percent: number | null;
  discount_months: number | null;
  max_per_account: number;
  cooldown_days: number;
  cap_total: number | null;
  cap_window_days: number;
  starts_at: string | null;
  ends_at: string | null;
}

export interface ChurnSaveOverview {
  days: number;
  settings: { enabled: boolean; global_cooldown_days: number };
  offers: StaffOffer[];
  reasons: { reason: string; presented: number; accepted: number; declined: number }[];
  bands: { band: string; presented: number; accepted: number }[];
  recent: { id: string; offer_name: string; kind: string; status: string; reason: string | null; risk_band: string | null; account: string; created_at: string }[];
  audit: { id: string; action: string; offer_id: string | null; actor_email: string | null; created_at: string }[];
}

const n = (v: unknown, d = 0) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};
const nullableN = (v: unknown) => (v === null || v === undefined || v === '' ? null : n(v));
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

export function parseOverview(raw: unknown): ChurnSaveOverview {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const settings = (o.settings && typeof o.settings === 'object' ? o.settings : {}) as Record<string, unknown>;
  return {
    days: n(o.days, 90),
    settings: { enabled: settings.enabled !== false, global_cooldown_days: n(settings.global_cooldown_days, 90) },
    offers: list(o.offers).map((r) => ({
      id: String(r.id),
      kind: (OFFER_KINDS as string[]).includes(String(r.kind)) ? (r.kind as OfferKind) : 'pause',
      name: String(r.name ?? ''),
      enabled: r.enabled === true,
      priority: n(r.priority, 100),
      target_reasons: arr(r.target_reasons),
      target_bands: arr(r.target_bands),
      pause_months: nullableN(r.pause_months),
      downgrade_plan: typeof r.downgrade_plan === 'string' ? r.downgrade_plan : null,
      discount_percent: nullableN(r.discount_percent),
      discount_months: nullableN(r.discount_months),
      max_per_account: n(r.max_per_account, 1),
      cooldown_days: n(r.cooldown_days, 180),
      cap_total: nullableN(r.cap_total),
      cap_window_days: n(r.cap_window_days, 30),
      starts_at: typeof r.starts_at === 'string' ? r.starts_at : null,
      ends_at: typeof r.ends_at === 'string' ? r.ends_at : null,
      presented: n(r.presented),
      declined: n(r.declined),
      accepted: n(r.accepted),
      failed: n(r.failed),
      in_cap_window: n(r.in_cap_window),
      retention_cohort_30d: n(r.retention_cohort_30d),
      retained_30d: n(r.retained_30d),
    })),
    reasons: list(o.reasons).map((r) => ({ reason: String(r.reason), presented: n(r.presented), accepted: n(r.accepted), declined: n(r.declined) })),
    bands: list(o.bands).map((r) => ({ band: String(r.band), presented: n(r.presented), accepted: n(r.accepted) })),
    recent: list(o.recent).map((r) => ({
      id: String(r.id),
      offer_name: String(r.offer_name ?? ''),
      kind: String(r.kind ?? ''),
      status: String(r.status ?? ''),
      reason: typeof r.reason === 'string' ? r.reason : null,
      risk_band: typeof r.risk_band === 'string' ? r.risk_band : null,
      account: String(r.account ?? ''),
      created_at: String(r.created_at ?? ''),
    })),
    audit: list(o.audit).map((r) => ({
      id: String(r.id),
      action: String(r.action ?? ''),
      offer_id: typeof r.offer_id === 'string' ? r.offer_id : null,
      actor_email: typeof r.actor_email === 'string' ? r.actor_email : null,
      created_at: String(r.created_at ?? ''),
    })),
  };
}

/** Percentage 0-100, or null when the denominator is 0 (never show a fake 0%). */
export function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

// ---------------------------------------------------------------------------
// Form draft
// ---------------------------------------------------------------------------

export interface OfferDraft {
  id?: string;
  kind: OfferKind;
  name: string;
  enabled: boolean;
  priority: string;
  target_reasons: string[];
  target_bands: string[];
  pause_months: string;
  downgrade_plan: string;
  discount_percent: string;
  discount_months: string;
  max_per_account: string;
  cooldown_days: string;
  cap_total: string;
  cap_window_days: string;
  starts_at: string;
  ends_at: string;
}

export const emptyDraft = (kind: OfferKind = 'discount'): OfferDraft => ({
  kind,
  name: '',
  enabled: false,
  priority: '100',
  target_reasons: [],
  target_bands: [],
  pause_months: '1',
  downgrade_plan: 'starter',
  discount_percent: '20',
  discount_months: '3',
  max_per_account: '1',
  cooldown_days: '180',
  cap_total: '',
  cap_window_days: '30',
  starts_at: '',
  ends_at: '',
});

const toLocalInput = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');

export function offerToDraft(o: StaffOffer): OfferDraft {
  return {
    id: o.id,
    kind: o.kind,
    name: o.name,
    enabled: o.enabled,
    priority: String(o.priority),
    target_reasons: o.target_reasons,
    target_bands: o.target_bands,
    pause_months: o.pause_months === null ? '1' : String(o.pause_months),
    downgrade_plan: o.downgrade_plan ?? 'starter',
    discount_percent: o.discount_percent === null ? '20' : String(o.discount_percent),
    discount_months: o.discount_months === null ? '3' : String(o.discount_months),
    max_per_account: String(o.max_per_account),
    cooldown_days: String(o.cooldown_days),
    cap_total: o.cap_total === null ? '' : String(o.cap_total),
    cap_window_days: String(o.cap_window_days),
    starts_at: toLocalInput(o.starts_at),
    ends_at: toLocalInput(o.ends_at),
  };
}

export type DraftErrors = Partial<Record<keyof OfferDraft, string>>;

const intIn = (v: string, min: number, max: number) => /^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max;

/** Returns i18n keys (under staff.errors.*) per invalid field. Empty object = valid. */
export function validateDraft(d: OfferDraft): DraftErrors {
  const e: DraftErrors = {};
  const name = d.name.trim();
  if (name.length < 3 || name.length > 80) e.name = 'name';
  if (!intIn(d.priority, 1, 1000)) e.priority = 'priority';
  if (d.kind === 'pause' && !intIn(d.pause_months, 1, LIMITS.maxPauseMonths)) e.pause_months = 'pauseMonths';
  if (d.kind === 'downgrade' && !(DOWNGRADE_PLANS as readonly string[]).includes(d.downgrade_plan)) e.downgrade_plan = 'plan';
  if (d.kind === 'discount') {
    const p = Number(d.discount_percent);
    if (!/^\d+(\.\d{1,2})?$/.test(d.discount_percent.trim()) || p <= 0 || p > LIMITS.maxDiscountPercent) e.discount_percent = 'percent';
    if (!intIn(d.discount_months, 1, LIMITS.maxDiscountMonths)) e.discount_months = 'discountMonths';
  }
  if (!intIn(d.max_per_account, 1, LIMITS.maxPerAccount)) e.max_per_account = 'perAccount';
  if (!intIn(d.cooldown_days, 0, LIMITS.maxCooldownDays)) e.cooldown_days = 'cooldown';
  if (d.cap_total.trim() !== '' && !intIn(d.cap_total, 1, 1_000_000)) e.cap_total = 'capTotal';
  if (!intIn(d.cap_window_days, 1, LIMITS.maxWindowDays)) e.cap_window_days = 'window';
  if (d.starts_at && d.ends_at && Date.parse(d.ends_at) <= Date.parse(d.starts_at)) e.ends_at = 'dates';
  return e;
}

/** Builds the RPC payload: only the fields of the chosen kind are sent, the rest are explicit nulls. */
export function draftToPayload(d: OfferDraft): Record<string, unknown> {
  const iso = (v: string) => (v ? new Date(v).toISOString() : null);
  return {
    ...(d.id ? { id: d.id } : {}),
    kind: d.kind,
    name: d.name.trim(),
    enabled: d.enabled,
    priority: Number(d.priority),
    target_reasons: d.target_reasons,
    target_bands: d.target_bands,
    pause_months: d.kind === 'pause' ? Number(d.pause_months) : null,
    downgrade_plan: d.kind === 'downgrade' ? d.downgrade_plan : null,
    discount_percent: d.kind === 'discount' ? Number(d.discount_percent) : null,
    discount_months: d.kind === 'discount' ? Number(d.discount_months) : null,
    max_per_account: Number(d.max_per_account),
    cooldown_days: Number(d.cooldown_days),
    cap_total: d.cap_total.trim() === '' ? null : Number(d.cap_total),
    cap_window_days: Number(d.cap_window_days),
    starts_at: iso(d.starts_at),
    ends_at: iso(d.ends_at),
  };
}

// ---------------------------------------------------------------------------
// RPCs
// ---------------------------------------------------------------------------

export async function fetchChurnSaveOverview(days = 90): Promise<ChurnSaveOverview> {
  const { data, error } = await supabase.rpc('staff_churn_save_overview', { p_days: days });
  if (error) throw new Error(error.message);
  return parseOverview(data);
}

export async function saveOffer(draft: OfferDraft): Promise<void> {
  const errors = validateDraft(draft);
  if (Object.keys(errors).length > 0) throw new Error('invalid_offer');
  const { error } = await supabase.rpc('staff_churn_save_upsert_offer', { p_offer: draftToPayload(draft) });
  if (error) throw new Error(error.message);
}

export async function saveSettings(enabled: boolean, globalCooldownDays: number): Promise<void> {
  const { error } = await supabase.rpc('staff_churn_save_set_settings', { p_enabled: enabled, p_global_cooldown_days: globalCooldownDays });
  if (error) throw new Error(error.message);
}
