import { supabase } from '@/lib/supabase';
import {
  gateMessage, type FinancingProduct, type FinancingStatus, type FunnelReport, type InsuranceStatus,
} from '@/lib/financingPartners';

export interface Gate { allowed: boolean; reason: string | null }
export interface Disclosure { version: string; product: FinancingProduct; body: string; counsel_reviewed: boolean }

export interface QuoteOffer {
  id: string; quote_id: string; partner_key: string; partner_name: string; amount_cents: number; currency: string;
  status: FinancingStatus; needs_review: boolean; expires_at: string; created_at: string; funded_at: string | null;
}
export interface SendableQuote { id: string; customer_name: string; status: string; line_items: { quantity: number; unit_price_cents: number }[] | null; tax_percent: number | null; sent_at: string | null }
export interface InsuranceReferral { id: string; line: string; partner_key: string; status: InsuranceStatus; contact_shared: boolean; created_at: string }
export interface AuditEvent { id: number; actor_kind: string; action: string; entity_type: string; from_status: string | null; to_status: string | null; created_at: string }
export interface WcOverview {
  computed: { data_sufficiency: 'insufficient' | 'limited' | 'established'; currency: string; signals: Record<string, string | number> };
  consent: { active: boolean; granted_at: string | null; expires_at: string | null; scopes: string[]; disclosure_version: string | null };
}
export interface PublicQuoteFinancing {
  available: boolean; offer_token?: string; status?: FinancingStatus; amount_cents?: number; currency?: string;
  partner_name?: string; disclosure_version?: string; disclosure_body?: string; expires_at?: string;
}

const ERROR_COPY: Record<string, string> = {
  forbidden: 'You don’t have permission to do that.',
  owner_required: 'Only the account owner can do that.',
  quote_not_found: 'That quote can’t be financed (it must be sent or accepted).',
  amount_unavailable: 'This quote has no fixed total yet. Add line items first.',
  below_minimum: 'This quote is below the partner’s minimum amount.',
  above_maximum: 'This quote is above the partner’s maximum amount.',
  disclosure_unavailable: 'Required disclosure text isn’t published yet.',
  disclosure_mismatch: 'The disclosure was updated. Reload and review it again.',
  acknowledgement_required: 'Please confirm you have read the disclosure.',
  consent_required: 'Consent is required before sharing anything.',
  recently_shared: 'Data was already shared with this partner in the last 24 hours.',
  insufficient_data: 'There isn’t enough business history yet to share anything useful.',
  nothing_to_share: 'None of the selected items are available yet.',
  already_referred: 'You already have an open referral for this coverage.',
  invalid_scope: 'Choose valid items to share.',
  not_cancelable: 'This offer can no longer be canceled.',
  not_found: 'Not found.',
  not_open: 'This offer is no longer open.',
};

async function describe(e: unknown): Promise<string> {
  if (e && typeof e === 'object') {
    const ctx = (e as { context?: unknown }).context;
    if (ctx instanceof Response) {
      try {
        const body = (await ctx.clone().json()) as { error?: unknown; reason?: unknown };
        if (body.error === 'unavailable') return gateMessage(typeof body.reason === 'string' ? body.reason : null);
        if (typeof body.error === 'string') return ERROR_COPY[body.error] ?? body.error;
      } catch { /* fall through */ }
    }
  }
  return 'Something went wrong. Please try again.';
}

function rpcResult<T extends { ok?: boolean; error?: string; reason?: string }>(data: T | null, error: unknown, fallback: string): T {
  if (error || !data) throw new Error(fallback);
  if (data.ok === false) {
    throw new Error(data.error === 'unavailable' ? gateMessage(data.reason) : ERROR_COPY[data.error ?? ''] ?? fallback);
  }
  return data;
}

export async function fetchGate(product: FinancingProduct): Promise<Gate> {
  const { data, error } = await supabase.rpc('my_financing_gate', { p_product: product });
  if (error || !data) throw new Error('Could not check availability.');
  return data as Gate;
}

export async function fetchDisclosure(product: FinancingProduct): Promise<Disclosure | null> {
  const { data, error } = await supabase.rpc('get_financing_disclosure', { p_product: product });
  if (error) throw new Error('Could not load the disclosure.');
  return (data as Disclosure | null) ?? null;
}

export async function fetchQuoteOffers(): Promise<QuoteOffer[]> {
  const { data, error } = await supabase
    .from('quote_financing_offers')
    .select('id, quote_id, partner_key, partner_name, amount_cents, currency, status, needs_review, expires_at, created_at, funded_at')
    .order('created_at', { ascending: false }).limit(200);
  if (error) throw new Error('Could not load financing offers.');
  return (data ?? []) as QuoteOffer[];
}

export async function fetchSendableQuotes(): Promise<SendableQuote[]> {
  const { data, error } = await supabase
    .from('quotes').select('id, customer_name, status, line_items, tax_percent, sent_at')
    .in('status', ['sent', 'accepted']).order('created_at', { ascending: false }).limit(50);
  if (error) throw new Error('Could not load quotes.');
  return (data ?? []) as SendableQuote[];
}

export async function createQuoteOffer(quoteId: string, partnerKey?: string): Promise<{ offer_id: string; existing: boolean }> {
  const { data, error } = await supabase.functions.invoke('financing-partner-offer', { body: { quote_id: quoteId, partner_key: partnerKey } });
  if (error) throw new Error(await describe(error));
  return data as { offer_id: string; existing: boolean };
}

export async function cancelQuoteOffer(offerId: string): Promise<void> {
  const { data, error } = await supabase.rpc('cancel_quote_financing_offer', { p_offer: offerId });
  rpcResult(data as { ok: boolean; error?: string }, error, 'Could not cancel the offer.');
}

export async function fetchFunnelReport(from: Date, to: Date): Promise<FunnelReport> {
  const { data, error } = await supabase.rpc('financing_funnel_report', { p_from: from.toISOString(), p_to: to.toISOString() });
  return rpcResult(data as FunnelReport & { ok: boolean }, error, 'Could not load the report.');
}

export async function fetchWorkingCapitalOverview(partnerKey: string): Promise<WcOverview> {
  const { data, error } = await supabase.rpc('get_working_capital_overview', { p_partner_key: partnerKey });
  return rpcResult(data as WcOverview & { ok: boolean }, error, 'Could not load working-capital signals.');
}

export async function setWorkingCapitalConsent(input: { partnerKey: string; grant: boolean; scopes: string[]; disclosureVersion: string }): Promise<void> {
  const { data, error } = await supabase.rpc('set_working_capital_consent', {
    p_partner_key: input.partnerKey, p_grant: input.grant, p_scopes: input.scopes, p_disclosure_version: input.disclosureVersion,
  });
  rpcResult(data as { ok: boolean; error?: string }, error, 'Could not update consent.');
}

export async function shareWorkingCapital(partnerKey: string): Promise<void> {
  const { error } = await supabase.functions.invoke('financing-partner-wc-share', { body: { partner_key: partnerKey } });
  if (error) throw new Error(await describe(error));
}

export async function fetchInsuranceReferrals(): Promise<InsuranceReferral[]> {
  const { data, error } = await supabase.from('insurance_referrals')
    .select('id, line, partner_key, status, contact_shared, created_at').order('created_at', { ascending: false }).limit(100);
  if (error) throw new Error('Could not load referrals.');
  return (data ?? []) as InsuranceReferral[];
}

export async function createInsuranceReferral(input: { line: string; disclosureVersion: string; shareEmail: boolean; partnerKey?: string }): Promise<void> {
  const { error } = await supabase.functions.invoke('financing-partner-insurance', {
    body: { line: input.line, acknowledged: true, disclosure_version: input.disclosureVersion, share_email: input.shareEmail, partner_key: input.partnerKey },
  });
  if (error) throw new Error(await describe(error));
}

export async function fetchAuditEvents(): Promise<AuditEvent[]> {
  const { data, error } = await supabase.from('financing_audit_events')
    .select('id, actor_kind, action, entity_type, from_status, to_status, created_at').order('id', { ascending: false }).limit(100);
  if (error) throw new Error('Could not load the audit trail.');
  return ((data ?? []) as AuditEvent[]).map((a) => ({ ...a, id: Number(a.id) }));
}

export async function fetchPublicQuoteFinancing(quoteToken: string): Promise<PublicQuoteFinancing> {
  const { data, error } = await supabase.rpc('get_public_quote_financing', { p_quote_token: quoteToken });
  if (error || !data) return { available: false };
  return data as PublicQuoteFinancing;
}

export async function openPartnerApplication(input: { offerToken: string; disclosureVersion: string }): Promise<string> {
  const { data, error } = await supabase.rpc('customer_open_financing_application', {
    p_offer_token: input.offerToken, p_disclosure_version: input.disclosureVersion, p_acknowledged: true,
  });
  const r = rpcResult(data as { ok: boolean; error?: string; application_url?: string }, error, 'Could not open the application.');
  if (!r.application_url || !r.application_url.startsWith('https://')) throw new Error('The application link is unavailable.');
  return r.application_url;
}
