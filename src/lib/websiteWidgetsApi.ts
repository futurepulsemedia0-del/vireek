/**
 * Website Widgets — API layer. Every query is scoped by account_owner_id (and RLS enforces it again server-side).
 */

import { supabase } from '@/lib/supabase';
import {
  WIDGET_TYPES,
  normalizeSettings,
  type DailyStatRow,
  type ReadinessContext,
  type WidgetOptions,
  type WidgetRow,
  type WidgetSettings,
  type WidgetType,
} from '@/lib/websiteWidgets';

const COLUMNS =
  'id, account_owner_id, widget_type, public_key, enabled, brand_color, theme, display_mode, position, radius, title, subtitle, button_label, success_message, allowed_domains, options, last_seen_at, last_seen_host, updated_at';

export type WidgetMap = Record<WidgetType, WidgetRow | null>;

function toRow(data: unknown): WidgetRow {
  const r = data as WidgetRow;
  return { ...r, ...normalizeSettings(r.widget_type, r as Partial<WidgetSettings>) } as WidgetRow;
}

/** One entry per widget type; null = not configured yet. */
export async function fetchWidgets(accountOwnerId: string): Promise<WidgetMap> {
  const { data, error } = await supabase.from('website_widgets').select(COLUMNS).eq('account_owner_id', accountOwnerId);
  if (error) throw error;
  const map: WidgetMap = { booking: null, quote: null, reviews: null };
  for (const row of (data ?? []) as WidgetRow[]) {
    if (WIDGET_TYPES.includes(row.widget_type)) map[row.widget_type] = toRow(row);
  }
  return map;
}

/** Insert-or-update. public_key / widget_type / last_seen_* are managed by the database and cannot be written from the client. */
export async function saveWidget(accountOwnerId: string, s: WidgetSettings): Promise<WidgetRow> {
  const payload = {
    account_owner_id: accountOwnerId,
    widget_type: s.widget_type,
    enabled: s.enabled,
    brand_color: s.brand_color,
    theme: s.theme,
    display_mode: s.display_mode,
    position: s.position,
    radius: s.radius,
    title: s.title.trim(),
    subtitle: s.subtitle.trim(),
    button_label: s.button_label.trim(),
    success_message: s.success_message.trim(),
    allowed_domains: s.allowed_domains,
    options: s.options,
  };
  const { data, error } = await supabase
    .from('website_widgets')
    .upsert(payload, { onConflict: 'account_owner_id,widget_type' })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return toRow(data);
}

export async function rotateWidgetKey(type: WidgetType): Promise<string> {
  const { data, error } = await supabase.rpc('rotate_website_widget_key', { p_type: type });
  if (error) throw error;
  return data as string;
}

/** Daily counters for the last `days` UTC days (inclusive of today), all widgets of the account. */
export async function fetchWidgetStats(accountOwnerId: string, days: number): Promise<DailyStatRow[]> {
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('website_widget_daily_stats')
    .select('widget_id, day, views, opens, conversions')
    .eq('account_owner_id', accountOwnerId)
    .gte('day', since);
  if (error) throw error;
  return (data ?? []) as DailyStatRow[];
}

/** What the widgets depend on elsewhere in the product (booking switch, services, synced reviews). */
export async function fetchReadinessContext(accountOwnerId: string): Promise<ReadinessContext> {
  const [profile, reviews] = await Promise.all([
    supabase.from('business_profile').select('booking_enabled, booking_slug, services_offered').eq('user_id', accountOwnerId).maybeSingle(),
    supabase.from('reviews').select('id', { count: 'exact', head: true }).eq('user_id', accountOwnerId),
  ]);
  if (profile.error) throw profile.error;
  const p = profile.data as { booking_enabled: boolean | null; booking_slug: string | null; services_offered: string[] | null } | null;
  return {
    bookingEnabled: !!p?.booking_enabled,
    bookingSlug: p?.booking_slug ?? null,
    serviceCount: p?.services_offered?.length ?? 0,
    reviewCount: reviews.count ?? 0,
  };
}

/** Real data (hours, busy times, services, ratings) for the live preview — works before the widget is saved/enabled. */
export async function fetchPreviewData(type: WidgetType, options: WidgetOptions): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('preview_website_widget_data', { p_type: type, p_options: options });
  if (error) throw error;
  return (data ?? {}) as Record<string, unknown>;
}
