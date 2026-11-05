// src/lib/pricePolicyApi.ts
// Data access for Price-First Playbook policies and metrics. Tenant isolation is enforced by RLS
// (user_id = get_account_owner_id()); the owner id is fetched from the same SQL helper so team
// members write rows under the account owner, exactly like the other account-scoped tables.

import { supabase } from '@/lib/supabase';
import {
  summarizePriceConversations,
  type PriceEvent,
  type PriceMetrics,
} from '../../supabase/functions/_shared/price-playbook/engine';
import type { PricePolicyPayload, PricePolicyRecord } from '@/lib/pricePolicy';

export const METRICS_WINDOW_DAYS = 30;
const MAX_EVENTS = 5000;

export interface BookItemOption {
  id: string;
  service_name: string;
  pricing_model: 'flat' | 'starting_at' | 'range' | 'hourly';
  price_cents: number;
  price_max_cents: number | null;
}

export async function fetchOwnerId(): Promise<string> {
  const { data, error } = await supabase.rpc('get_account_owner_id');
  if (error || typeof data !== 'string') throw new Error('owner_unavailable');
  return data;
}

export async function fetchPolicies(): Promise<PricePolicyRecord[]> {
  const { data, error } = await supabase.from('price_policies').select('*').order('display_name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as PricePolicyRecord[];
}

export async function fetchBookItems(): Promise<BookItemOption[]> {
  const { data, error } = await supabase
    .from('price_book_items')
    .select('id, service_name, pricing_model, price_cents, price_max_cents')
    .eq('active', true)
    .order('service_name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as BookItemOption[];
}

export async function savePolicy(payload: PricePolicyPayload, id: string | null): Promise<void> {
  if (id) {
    // user_id is immutable; never send it on update.
    const { user_id: _omit, ...rest } = payload;
    void _omit;
    const { error } = await supabase.from('price_policies').update(rest).eq('id', id);
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await supabase.from('price_policies').insert(payload);
  if (error) throw new Error(error.code === '23505' ? 'duplicate_service' : error.message);
}

export async function setPolicyActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('price_policies').update({ active }).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deletePolicy(id: string): Promise<void> {
  const { error } = await supabase.from('price_policies').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export interface MetricsResult {
  metrics: PriceMetrics;
  truncated: boolean;
}

export async function fetchMetrics(now: Date = new Date()): Promise<MetricsResult> {
  const since = new Date(now.getTime() - METRICS_WINDOW_DAYS * 86_400_000).toISOString();
  const [events, calls] = await Promise.all([
    supabase
      .from('price_playbook_events')
      .select('conversation_key, stage, ticket_cents, occurred_at')
      .gte('occurred_at', since)
      .order('occurred_at', { ascending: false })
      .limit(MAX_EVENTS),
    supabase.from('calls').select('id', { count: 'exact', head: true }).gte('call_datetime', since),
  ]);
  if (events.error) throw new Error(events.error.message);
  if (calls.error) throw new Error(calls.error.message);
  const rows = (events.data ?? []) as PriceEvent[];
  return {
    metrics: summarizePriceConversations(rows, calls.count ?? 0),
    truncated: rows.length >= MAX_EVENTS,
  };
}

// ---------------------------------------------------------------------------
// Value claims & fast next steps (one row per account; nothing is claimed unless turned on)
// ---------------------------------------------------------------------------

import { DEFAULT_PLAYBOOK_SETTINGS, type PlaybookSettings } from '../../supabase/functions/_shared/price-playbook/engine';

export async function fetchPlaybookSettings(): Promise<PlaybookSettings> {
  const { data, error } = await supabase
    .from('price_playbook_settings')
    .select('licensed_techs, warranty_months, on_time_guarantee, same_day_diagnostic_enabled, human_callback_enabled, financing_min_cents')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PlaybookSettings | null) ?? DEFAULT_PLAYBOOK_SETTINGS;
}

export async function savePlaybookSettings(ownerId: string, s: PlaybookSettings): Promise<void> {
  const { error } = await supabase.from('price_playbook_settings').upsert({ user_id: ownerId, ...s }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
}
