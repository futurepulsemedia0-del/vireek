// src/lib/directMailApi.ts
//
// Supabase access for Direct Mail. Reads go through RLS-scoped tables (account owner + manager only);
// every write goes through a SECURITY DEFINER RPC or an edge function. See 20271102000000_direct_mail_channel.sql.

import { supabase } from '@/lib/supabase';
import {
  chunk,
  dollarsToCents,
  directMailErrorMessage,
  parseReport,
  withTrackingCodes,
  type Campaign,
  type CampaignDraft,
  type CampaignReportRow,
  type DirectMailSettings,
  type MailAddress,
  type Piece,
} from '@/lib/directMail';

const PIECE_COLUMNS =
  'id,campaign_id,tracking_code,recipient_name,line1,line2,city,state,zip,status,provider_url,expected_delivery,cost_cents,cost_estimated,last_error,scan_count,submitted_at,delivered_at';

const fail = (error: { code?: string; message?: string }, fallback: string): never => {
  throw new Error(directMailErrorMessage(error, fallback));
};

export async function fetchSettings(): Promise<DirectMailSettings> {
  const { data, error } = await supabase.rpc('direct_mail_settings_get');
  if (error) fail(error, 'Could not load direct mail settings.');
  return data as DirectMailSettings;
}

export async function saveReturnAddress(a: MailAddress, landingPageId: string | null): Promise<void> {
  const { error } = await supabase.rpc('direct_mail_settings_save', {
    p_name: a.name, p_line1: a.line1, p_line2: a.line2, p_city: a.city, p_state: a.state, p_zip: a.zip,
    p_landing_page_id: landingPageId,
  });
  if (error) fail(error, 'Could not save the return address.');
}

type SettingsAction =
  | { action: 'save_key'; api_key: string; webhook_secret?: string }
  | { action: 'save_webhook_secret'; webhook_secret: string }
  | { action: 'rotate_webhook_token' }
  | { action: 'clear_key' };

export async function updateProvider(body: SettingsAction): Promise<DirectMailSettings | null> {
  const { data, error } = await supabase.functions.invoke('direct-mail-settings', { body });
  const code = (data as { error?: string } | null)?.error;
  if (error || code) throw new Error(directMailErrorMessage(code ?? error?.message, 'Could not update the print provider settings.'));
  return ((data as { settings?: DirectMailSettings } | null)?.settings) ?? null;
}

export async function listCampaigns(ownerId: string): Promise<Campaign[]> {
  const { data, error } = await supabase
    .from('direct_mail_campaigns')
    .select('*')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) fail(error, 'Could not load campaigns.');
  return (data ?? []) as unknown as Campaign[];
}

export async function saveCampaign(id: string | null, d: CampaignDraft): Promise<Campaign> {
  const cap = d.budget_cap.trim() ? dollarsToCents(d.budget_cap) : null;
  const { data, error } = await supabase.rpc('direct_mail_campaign_save', {
    p_id: id, p_name: d.name.trim(), p_landing_page_id: d.landing_page_id || null, p_size: d.size, p_mail_type: d.mail_type,
    p_headline: d.headline.trim(), p_offer: d.offer.trim(), p_cta: d.cta.trim(), p_phone: d.phone.trim(),
    p_accent_color: d.accent_color, p_est_unit_cost_cents: dollarsToCents(d.est_unit_cost) ?? 0, p_budget_cap_cents: cap,
  });
  if (error) fail(error, 'Could not save the campaign.');
  return data as unknown as Campaign;
}

export async function deleteCampaign(id: string): Promise<void> {
  const { error } = await supabase.rpc('direct_mail_campaign_delete', { p_id: id });
  if (error) fail(error, 'Could not delete the campaign.');
}

export async function setCampaignStatus(id: string, status: 'paused' | 'cancelled'): Promise<Campaign> {
  const { data, error } = await supabase.rpc('direct_mail_campaign_set_status', { p_id: id, p_status: status });
  if (error) fail(error, 'Could not update the campaign.');
  return data as unknown as Campaign;
}

export interface AddPiecesSummary { inserted: number; invalid: number; duplicates: number; suppressed: number }

/** Adds recipients in chunks of 1000, retrying the (astronomically rare) tracking-code collisions. */
export async function addRecipients(campaignId: string, recipients: MailAddress[]): Promise<AddPiecesSummary> {
  const summary: AddPiecesSummary = { inserted: 0, invalid: 0, duplicates: 0, suppressed: 0 };
  for (const part of chunk(recipients, 1000)) {
    let pending = part;
    for (let attempt = 0; attempt < 3 && pending.length > 0; attempt++) {
      const withCodes = withTrackingCodes(pending);
      const { data, error } = await supabase.rpc('direct_mail_add_pieces', {
        p_campaign_id: campaignId,
        p_pieces: withCodes.map((r) => ({ tracking_code: r.tracking_code, name: r.name, line1: r.line1, line2: r.line2, city: r.city, state: r.state, zip: r.zip })),
      });
      if (error) fail(error, 'Could not add recipients.');
      const res = data as { invalid: number; duplicates: number; suppressed: number; collisions: number; inserted_codes: string[] };
      summary.inserted += res.inserted_codes.length;
      summary.invalid += res.invalid;
      summary.duplicates += res.duplicates;
      summary.suppressed += res.suppressed;
      if (!res.collisions) break;
      const done = new Set(res.inserted_codes);
      // Only rows that collided on the code are retried (duplicates/suppressed were already counted).
      pending = withCodes.filter((r) => !done.has(r.tracking_code)).slice(0, res.collisions);
    }
  }
  return summary;
}

export async function listPieces(campaignId: string, page: number, pageSize: number, status: string | null): Promise<{ rows: Piece[]; total: number }> {
  let q = supabase.from('direct_mail_pieces').select(PIECE_COLUMNS, { count: 'exact' }).eq('campaign_id', campaignId);
  if (status) q = q.eq('status', status);
  const { data, error, count } = await q.order('created_at', { ascending: true }).order('id').range(page * pageSize, page * pageSize + pageSize - 1);
  if (error) fail(error, 'Could not load mailers.');
  return { rows: (data ?? []) as unknown as Piece[], total: count ?? 0 };
}

export async function suppressPiece(pieceId: string): Promise<void> {
  const { error } = await supabase.rpc('direct_mail_suppress_piece', { p_piece_id: pieceId, p_reason: 'do_not_mail' });
  if (error) fail(error, 'Could not add this address to the do-not-mail list.');
}

export interface SendResult { status: string; processed: number; submitted: number; failed: number; remaining: number; reason?: string }

export async function sendCampaign(campaignId: string): Promise<SendResult> {
  const { data, error } = await supabase.functions.invoke('direct-mail-send', { body: { campaign_id: campaignId } });
  const code = (data as { error?: string } | null)?.error;
  if (error || code) throw new Error(directMailErrorMessage(code ?? error?.message, 'Sending failed. Nothing was lost — you can resume.'));
  return data as SendResult;
}

export async function recordResponse(code: string, kind: string, note: string): Promise<{ campaign_name: string; recipient_name: string }> {
  const { data, error } = await supabase.rpc('direct_mail_record_response', { p_code: code, p_kind: kind, p_note: note || null });
  if (error) fail(error, 'Could not log the response.');
  return data as { campaign_name: string; recipient_name: string };
}

export async function fetchReport(days: number): Promise<CampaignReportRow[]> {
  const { data, error } = await supabase.rpc('direct_mail_report', { p_days: days });
  if (error) fail(error, 'Could not load results.');
  return parseReport(data);
}

export async function listLandingOptions(ownerId: string): Promise<{ id: string; title: string; slug: string; status: string }[]> {
  const { data, error } = await supabase.from('landing_pages').select('id,title,slug,status').eq('user_id', ownerId).order('updated_at', { ascending: false }).limit(100);
  if (error) fail(error, 'Could not load landing pages.');
  return (data ?? []) as { id: string; title: string; slug: string; status: string }[];
}

export async function listCustomersForMail(ownerId: string): Promise<{ name: string | null; address: string | null }[]> {
  const { data, error } = await supabase
    .from('customers').select('name,address').eq('user_id', ownerId).not('address', 'is', null).limit(5000);
  if (error) fail(error, 'Could not load customers.');
  return (data ?? []) as { name: string | null; address: string | null }[];
}
