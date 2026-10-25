// src/lib/payApi.ts — Supabase / edge-function access for Vireek Pay & Capital.
// Every function throws PayError with a message that is safe to show. Pure logic: pay.ts.
import { supabase } from '@/lib/supabase';
import {
  describePayError,
  type CapitalApplication, type CapitalOffer, type CardTransaction, type ControlRow, type DisclosureDoc, type EwaQuote,
  type InstantQuote, type PayProduct, type PrescreenResponse, type ProductAvailability, type SettlementRow, type SpendCard,
  type TransferKind, type TransferRow,
} from '@/lib/pay';

export class PayError extends Error {
  constructor(message: string, public code?: string, public extra?: Record<string, unknown>) {
    super(message);
    this.name = 'PayError';
  }
}

interface DbError { message?: string; code?: string }
function dbFail(error: DbError | null | undefined, fallback: string): never {
  if (error?.code === '42501') throw new PayError('You do not have access to this.', 'forbidden');
  if (error?.code === '22023' || error?.code === 'P0002') throw new PayError(error.message || fallback, error.code);
  throw new PayError(fallback);
}

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let payload: { error?: string; reason?: string; disclosure_key?: string } | null = null;
    try { payload = await (error as { context?: Response }).context?.json(); } catch { /* not JSON */ }
    const code = payload?.error === 'unavailable' && payload.reason ? 'unavailable' : payload?.error;
    throw new PayError(describePayError(code), payload?.error, { reason: payload?.reason, disclosure_key: payload?.disclosure_key });
  }
  if (data?.error) throw new PayError(describePayError(data.error), data.error, data);
  return data as T;
}

// ---- availability + disclosures ---------------------------------------------------------------
export async function fetchAvailability(): Promise<ProductAvailability[]> {
  const { data, error } = await supabase.rpc('pay_get_my_availability');
  if (error) dbFail(error, 'Could not load availability.');
  return (data ?? []) as ProductAvailability[];
}

export async function fetchDisclosure(key: string): Promise<DisclosureDoc | null> {
  const { data, error } = await supabase.rpc('pay_get_disclosure', { p_key: key });
  if (error) dbFail(error, 'Could not load the terms.');
  return (data as DisclosureDoc | null) ?? null;
}

export async function acceptDisclosure(d: Pick<DisclosureDoc, 'key' | 'content_sha256'>): Promise<void> {
  const { data, error } = await supabase.rpc('pay_accept_disclosure', { p_key: d.key, p_expected_sha256: d.content_sha256 });
  if (error) dbFail(error, 'Could not record your acceptance.');
  if (data?.status === 'stale_version') throw new PayError('The terms were updated. Please read the new version.', 'stale_version');
  if (data?.status !== 'accepted') throw new PayError('Could not record your acceptance.');
}

// ---- technician: payouts + EWA ----------------------------------------------------------------
export const quoteEwa = () => invoke<EwaQuote>('pay-transfer-request', { action: 'quote', kind: 'earned_wage_advance' });
export const quoteInstant = () => invoke<InstantQuote>('pay-transfer-request', { action: 'quote', kind: 'instant_payout' });
export const ensureSandboxAccount = (kind: TransferKind) => invoke<{ account: { last4: string | null } }>('pay-transfer-request', { action: 'ensure_sandbox_account', kind });

export const requestTransfer = (i: { kind: TransferKind; idempotencyKey: string; amountCents?: number; payRunItemId?: string }) =>
  invoke<{ transfer: TransferRow; sandbox: boolean; replayed?: boolean }>('pay-transfer-request', {
    action: 'request', kind: i.kind, idempotency_key: i.idempotencyKey, amount_cents: i.amountCents, pay_run_item_id: i.payRunItemId,
  });

const TRANSFER_COLS = 'id, kind, status, amount_cents, fee_cents, receive_cents, sandbox, holder_name, failure_code, created_at, settled_at';
export async function listTransfers(limit = 50): Promise<TransferRow[]> {
  const { data, error } = await supabase.from('pay_transfers').select(TRANSFER_COLS).order('created_at', { ascending: false }).limit(limit);
  if (error) dbFail(error, 'Could not load transfers.');
  return (data ?? []) as TransferRow[];
}

// ---- manager: settlement ------------------------------------------------------------------------
export async function listFinalPayRuns(): Promise<{ id: string; pay_period_start: string; pay_period_end: string; pay_date: string; status: string }[]> {
  const { data, error } = await supabase.from('pay_runs').select('id, pay_period_start, pay_period_end, pay_date, status')
    .in('status', ['approved', 'paid']).order('pay_date', { ascending: false }).limit(8);
  if (error) dbFail(error, 'Could not load pay runs.');
  return data ?? [];
}

export async function fetchSettlement(payRunId: string): Promise<SettlementRow[]> {
  const { data, error } = await supabase.rpc('pay_run_settlement', { p_pay_run_id: payRunId });
  if (error) dbFail(error, 'Could not load the settlement.');
  return ((data ?? []) as SettlementRow[]).map((r) => ({
    ...r, net_pay_cents: Number(r.net_pay_cents), instant_paid_cents: Number(r.instant_paid_cents),
    outstanding_advance_cents: Number(r.outstanding_advance_cents), recommended_recovery_cents: Number(r.recommended_recovery_cents),
    disbursement_due_cents: Number(r.disbursement_due_cents),
  }));
}

export async function recordAdvanceRecovery(payRunId: string): Promise<number> {
  const { data, error } = await supabase.rpc('pay_record_advance_recovery', { p_pay_run_id: payRunId });
  if (error) dbFail(error, 'Could not record recoveries.');
  if (data?.status !== 'recorded') throw new PayError(data?.status === 'run_not_final' ? 'The pay run must be approved first.' : 'Could not record recoveries.');
  return Number(data.recovered_cents ?? 0);
}

// ---- manager: cards -------------------------------------------------------------------------------
const CARD_COLS = 'id, team_member_id, holder_name, card_type, brand, last4, status, per_txn_limit_cents, daily_limit_cents, monthly_limit_cents, allowed_mcc, blocked_mcc, receipt_required_over_cents, sandbox';
export async function listCards(): Promise<SpendCard[]> {
  const { data, error } = await supabase.from('spend_cards').select(CARD_COLS).order('created_at', { ascending: false });
  if (error) dbFail(error, 'Could not load cards.');
  return (data ?? []) as SpendCard[];
}

export async function listCardTransactions(limit = 40): Promise<CardTransaction[]> {
  const { data, error } = await supabase.from('card_transactions')
    .select('id, user_id, card_id, status, decline_code, amount_cents, merchant_name, mcc, memo, receipt_path, sandbox, created_at')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) dbFail(error, 'Could not load card activity.');
  return (data ?? []) as CardTransaction[];
}

export interface CardLimitsBody {
  per_txn_limit_cents: number; daily_limit_cents: number; monthly_limit_cents: number;
  allowed_mcc?: string[]; blocked_mcc?: string[]; receipt_required_over_cents?: number;
}
export const createCard = (b: CardLimitsBody & { holder_name?: string; team_member_id?: string | null; card_type?: 'virtual' | 'physical' }) =>
  invoke<{ card: { id: string } }>('pay-card-manage', { action: 'create', ...b });
export const setCardStatus = (cardId: string, status: 'active' | 'frozen' | 'canceled') =>
  invoke<{ ok: true }>('pay-card-manage', { action: 'set_status', card_id: cardId, status });
export const updateCardLimits = (cardId: string, b: CardLimitsBody) => invoke<{ ok: true }>('pay-card-manage', { action: 'update_limits', card_id: cardId, ...b });
export const simulatePurchase = (cardId: string, b: { amount_cents: number; mcc?: string; merchant_name?: string }) =>
  invoke<{ approved: boolean; message: string; declineCode: string | null; receiptRequired: boolean }>('pay-card-manage', { action: 'simulate_purchase', card_id: cardId, ...b });

export async function updateTransactionMeta(id: string, patch: { memo?: string; receiptPath?: string; jobId?: string }): Promise<void> {
  const { data, error } = await supabase.rpc('card_update_transaction_meta', {
    p_txn_id: id, p_memo: patch.memo ?? null, p_receipt_path: patch.receiptPath ?? null, p_job_id: patch.jobId ?? null,
  });
  if (error) dbFail(error, 'Could not save.');
  if (data?.status !== 'updated') throw new PayError('Could not save.');
}

/** Uploads to the private card-receipts bucket under <ownerId>/<txnId>/<file>; returns the object path. */
export async function uploadReceipt(ownerId: string, txnId: string, file: File): Promise<string> {
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  const path = `${ownerId}/${txnId}/${Date.now()}_${safe}`;
  const { error } = await supabase.storage.from('card-receipts').upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw new PayError('Could not upload the receipt.');
  return path;
}

// ---- manager: capital -----------------------------------------------------------------------------
export const prescreenCapital = () => invoke<PrescreenResponse>('capital-manage', { action: 'prescreen' });
export const submitCapital = (applicationId: string, requestedAmountCents: number, invoiceIds: string[]) =>
  invoke<{ outcome: string; sandbox: boolean; declineReasons: string[] }>('capital-manage', {
    action: 'submit', application_id: applicationId, requested_amount_cents: requestedAmountCents, invoice_ids: invoiceIds,
  });
export const acceptCapitalOffer = (applicationId: string, offerId: string) => invoke<{ ok: true }>('capital-manage', { action: 'accept_offer', application_id: applicationId, offer_id: offerId });
export const withdrawCapital = (applicationId: string) => invoke<{ ok: true }>('capital-manage', { action: 'withdraw', application_id: applicationId });

export async function listCapital(): Promise<{ applications: CapitalApplication[]; offers: CapitalOffer[] }> {
  const [a, o] = await Promise.all([
    supabase.from('capital_applications').select('id, status, sandbox, requested_amount_cents, created_at, decline_reasons').order('created_at', { ascending: false }).limit(20),
    supabase.from('capital_offers').select('id, application_id, status, sandbox, offered_amount_cents, total_repayment_cents, finance_charge_cents, term_days, estimated_apr_bps, repayment_description, terms_url, expires_at').order('created_at', { ascending: false }).limit(20),
  ]);
  if (a.error) dbFail(a.error, 'Could not load applications.');
  if (o.error) dbFail(o.error, 'Could not load offers.');
  return { applications: (a.data ?? []) as CapitalApplication[], offers: (o.data ?? []) as CapitalOffer[] };
}

// ---- staff ---------------------------------------------------------------------------------------------
export interface AuditRow { id: number; subject: string; action: string; reason: string | null; created_at: string; actor_email: string | null }
export interface FrozenRow { tenant_id: string; product: string; reason: string; set_at: string; email: string | null; company_name: string | null }
export interface DisclosureRow { key: string; version: number; title: string; legal_reviewed: boolean; reviewed_by: string | null; published_at: string }

export async function staffListControls(): Promise<ControlRow[]> {
  const { data, error } = await supabase.rpc('staff_pay_list_controls');
  if (error) dbFail(error, 'Could not load controls.');
  return (data ?? []) as ControlRow[];
}
export async function staffUpdateControl(product: PayProduct, patch: Record<string, unknown>, reason: string): Promise<void> {
  const { error } = await supabase.rpc('staff_pay_update_control', { p_product: product, p_patch: patch, p_reason: reason });
  if (error) dbFail(error, 'Could not update the control.');
}
export async function staffKillAll(reason: string): Promise<number> {
  const { data, error } = await supabase.rpc('staff_pay_kill_all', { p_reason: reason });
  if (error) dbFail(error, 'Could not kill the products.');
  return Number(data ?? 0);
}
export async function staffListAudit(): Promise<AuditRow[]> {
  const { data, error } = await supabase.rpc('staff_pay_list_audit', { p_limit: 40 });
  if (error) dbFail(error, 'Could not load the audit log.');
  return (data ?? []) as AuditRow[];
}
export async function staffListFrozen(): Promise<FrozenRow[]> {
  const { data, error } = await supabase.rpc('staff_pay_list_frozen_tenants');
  if (error) dbFail(error, 'Could not load frozen tenants.');
  return (data ?? []) as FrozenRow[];
}
export async function staffSetFreeze(tenantId: string, product: string, frozen: boolean, reason: string): Promise<void> {
  const { error } = await supabase.rpc('staff_pay_set_tenant_freeze', { p_tenant: tenantId, p_product: product, p_frozen: frozen, p_reason: reason });
  if (error) dbFail(error, 'Could not change the freeze.');
}
export async function staffListDisclosures(): Promise<DisclosureRow[]> {
  const { data, error } = await supabase.from('pay_disclosures').select('key, version, title, legal_reviewed, reviewed_by, published_at').order('key').order('version', { ascending: false });
  if (error) dbFail(error, 'Could not load disclosures.');
  return (data ?? []) as DisclosureRow[];
}
export async function staffMarkReviewed(key: string, version: number, reviewerRef: string): Promise<void> {
  const { error } = await supabase.rpc('staff_pay_mark_disclosure_reviewed', { p_key: key, p_version: version, p_reviewer_ref: reviewerRef });
  if (error) dbFail(error, 'Could not mark as reviewed.');
}
