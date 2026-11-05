// supabase/functions/_shared/price-playbook/runtime.ts
//
// Database glue for the Price-First Playbook, shared by the voice tool (vapi-webhook) and the
// SMS/email auto-reply. All policy reads are tenant-scoped (service-role client, explicit user_id).
// Policy-read errors FAIL CLOSED: a policy can be stricter than the price book, so a read failure
// must never fall through to the price book.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { resolveCounterpartyState } from '../compliance-rules/jurisdiction.ts';
import { DEFAULT_PLAYBOOK_SETTINGS, applyPriceBookAmounts, composeFirstReply, composeGuidance, type Channel, type FirstReply, type PlaybookSettings, type PriceStage, type PricePolicy } from './engine.ts';
import { chooseState, figuresToLookupItems, matchPolicy, rowToPolicy, type PricePolicyRow } from './policy.ts';

const POLICY_COLUMNS =
  'service_key, display_name, trade, mode, keywords, source_kind, price_book_item_id, amount_low_cents, amount_high_cents, diagnostic_fee_cents, fee_credited_on_repair, written_price_before_work, includes, changes_price, verified_at, approved_states, legal_review_status, active';

export type PolicyLookup =
  | { kind: 'none' } // no policies configured, or none matches: caller keeps existing behaviour
  | { kind: 'error' } // could not read policies: caller must fail closed
  | { kind: 'matched'; policy: PricePolicy; reply: FirstReply; state: string | null; guidance: string };

export async function resolveJurisdictionState(
  admin: SupabaseClient,
  userId: string,
  hints: { explicitState?: string | null; address?: string | null; phone?: string | null },
): Promise<string | null> {
  const resolved = resolveCounterpartyState(hints);
  if (resolved.state && (resolved.basis === 'explicit' || resolved.basis === 'address')) return resolved.state;
  const { data } = await admin.from('compliance_profiles').select('business_state').eq('user_id', userId).maybeSingle();
  return chooseState(resolved, (data?.business_state as string | null | undefined) ?? null);
}

export async function loadPlaybookSettings(admin: SupabaseClient, userId: string): Promise<PlaybookSettings> {
  const { data, error } = await admin
    .from('price_playbook_settings')
    .select('licensed_techs, warranty_months, on_time_guarantee, same_day_diagnostic_enabled, human_callback_enabled, financing_min_cents')
    .eq('user_id', userId)
    .maybeSingle();
  // Failing to read settings only removes optional claims (value, next steps); it never adds any.
  if (error || !data) return DEFAULT_PLAYBOOK_SETTINGS;
  return {
    licensed_techs: data.licensed_techs === true,
    warranty_months: typeof data.warranty_months === 'number' ? data.warranty_months : null,
    on_time_guarantee: data.on_time_guarantee === true,
    same_day_diagnostic_enabled: data.same_day_diagnostic_enabled === true,
    human_callback_enabled: data.human_callback_enabled === true,
    financing_min_cents: typeof data.financing_min_cents === 'number' ? data.financing_min_cents : null,
  };
}

export async function lookupPolicyReply(
  admin: SupabaseClient,
  userId: string,
  needle: string,
  channel: Channel,
  state: string | null,
  answeredQuestionIds: ReadonlySet<string> = new Set(),
  hasMobileNumber = false,
): Promise<PolicyLookup> {
  const { data, error } = await admin.from('price_policies').select(POLICY_COLUMNS).eq('user_id', userId).eq('active', true);
  if (error) return { kind: 'error' };
  const rows = (data ?? []) as PricePolicyRow[];
  if (rows.length === 0) return { kind: 'none' };
  const row = matchPolicy(rows, needle);
  if (!row) return { kind: 'none' };

  let item: { pricing_model: 'flat' | 'starting_at' | 'range' | 'hourly'; price_cents: number; price_max_cents: number | null } | null = null;
  if (row.source_kind === 'price_book' && row.price_book_item_id) {
    const res = await admin
      .from('price_book_items')
      .select('pricing_model, price_cents, price_max_cents')
      .eq('id', row.price_book_item_id)
      .eq('user_id', userId)
      .eq('active', true)
      .maybeSingle();
    if (res.error) return { kind: 'error' };
    item = res.data ?? null;
  }
  const policy = applyPriceBookAmounts(rowToPolicy(row), item);
  const reply = composeFirstReply(policy, { state, now: new Date() }, channel, answeredQuestionIds);
  const settings = await loadPlaybookSettings(admin, userId);
  return { kind: 'matched', policy, reply, state, guidance: composeGuidance(reply.answer, settings, channel, hasMobileNumber) };
}

/** Logs spoken figures as lookups so ai-core/priceEnforcement grounds them (no false mismatch). */
export async function logPolicyLookup(
  admin: SupabaseClient,
  userId: string,
  externalCallId: string | null,
  query: string,
  m: Extract<PolicyLookup, { kind: 'matched' }>,
): Promise<void> {
  const items = figuresToLookupItems(m.policy.display_name, m.reply.answer.figures);
  if (items.length === 0) return;
  const { error } = await admin
    .from('price_lookup_log')
    .insert({ user_id: userId, external_call_id: externalCallId, query: query.slice(0, 500), matched_items: items });
  if (error) console.error(JSON.stringify({ event: 'price_policy_lookup_log_failed', error: error.message }));
}

export async function recordPlaybookEvents(
  admin: SupabaseClient,
  userId: string,
  channel: Channel,
  conversationKey: string,
  stages: { stage: PriceStage; service_key?: string | null; mode_used?: string | null; downgraded_reason?: string | null; ticket_cents?: number | null }[],
): Promise<void> {
  if (!conversationKey || stages.length === 0) return;
  const rows = stages.map((s) => ({
    user_id: userId,
    channel,
    conversation_key: conversationKey.slice(0, 200),
    service_key: s.service_key ?? null,
    mode_used: s.mode_used ?? null,
    downgraded_reason: s.downgraded_reason ?? null,
    stage: s.stage,
    ticket_cents: s.ticket_cents ?? null,
  }));
  // One insert per row: the unique partial indexes (one price_asked, one terminal stage per
  // conversation) make webhook retries idempotent; a duplicate (23505) is expected, not an error.
  for (const row of rows) {
    const { error } = await admin.from('price_playbook_events').insert(row);
    if (error && error.code !== '23505') {
      console.error(JSON.stringify({ event: 'price_playbook_event_failed', stage: row.stage, error: error.message }));
    }
  }
}

/**
 * End of a voice call: if a price was asked, record how it ended. `booked` wins over `abandoned`.
 * Idempotent: a conversation that already has a terminal event is left alone (webhook retries).
 */
export async function finalizePriceConversation(
  admin: SupabaseClient,
  userId: string,
  vapiCallId: string,
): Promise<'booked' | 'abandoned' | 'skipped'> {
  const { data, error } = await admin
    .from('price_playbook_events')
    .select('stage')
    .eq('user_id', userId)
    .eq('conversation_key', vapiCallId);
  if (error || !data || data.length === 0) return 'skipped';
  const stages = new Set(data.map((r: { stage: string }) => r.stage));
  if (!stages.has('price_asked') || stages.has('booked') || stages.has('abandoned')) return 'skipped';
  const { data: call } = await admin.from('calls').select('status').eq('user_id', userId).eq('vapi_call_id', vapiCallId).maybeSingle();
  const outcome = call?.status === 'booked' ? 'booked' : 'abandoned';
  await recordPlaybookEvents(admin, userId, 'voice', vapiCallId, [{ stage: outcome }]);
  return outcome;
}
