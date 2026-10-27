import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/invoices';
import { parseMoneyInput, type InvoicePayment, type InvoiceRefund, type PaymentMethod } from '@/lib/invoiceDetail';

// ============================================================
// Types
// ============================================================

export const MIN_SPLIT_PAYERS = 2;
export const MAX_SPLIT_PAYERS = 10;

export type SplitRole = 'customer' | 'insurer' | 'landlord' | 'tenant' | 'property_manager' | 'warranty' | 'other';

export const SPLIT_ROLE_LABELS: Record<SplitRole, string> = {
  customer: 'Customer',
  insurer: 'Insurer',
  landlord: 'Landlord',
  tenant: 'Tenant',
  property_manager: 'Property manager',
  warranty: 'Warranty company',
  other: 'Other',
};

export type ShareType = 'fixed' | 'percent' | 'remainder';

export const SHARE_TYPE_LABELS: Record<ShareType, string> = {
  fixed: 'Fixed amount',
  percent: 'Percent of total',
  remainder: 'Remainder',
};

export interface SplitPayer {
  id: string;
  user_id: string;
  invoice_id: string;
  sort_order: number;
  role: SplitRole;
  name: string;
  email: string | null;
  phone: string | null;
  share_type: ShareType;
  share_value: number | null;
  amount_cents: number;
  plan_total_cents: number;
  public_token: string;
  stripe_payment_intent_id: string | null;
  needs_review: boolean;
  link_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One editable row in the split editor. Values stay as the raw strings the user typed. */
export interface SplitDraftRow {
  key: string;
  id?: string;
  role: SplitRole;
  name: string;
  email: string;
  phone: string;
  shareType: ShareType;
  shareValue: string;
}

export interface SplitPayerInput {
  id?: string;
  role: SplitRole;
  name: string;
  email: string | null;
  phone: string | null;
  share_type: ShareType;
  share_value: string | null;
  amount_cents: number;
}

// ============================================================
// Pure logic (unit-tested)
// ============================================================

export type AllocationResult = { ok: true; amounts: number[] } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** "33.33" or "50%" -> hundredths of a percent (3333). null unless 0.01–100 with at most 2 decimals. */
export function parsePercentInput(raw: string): number | null {
  const value = raw.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  const hundredths = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return hundredths > 0 && hundredths <= 10000 ? hundredths : null;
}

/**
 * Turns the editor rows into exact cents that add up to `totalCents`.
 *  - fixed:     an exact dollar amount
 *  - percent:   a share of the invoice total (largest-remainder rounding, so no cent is lost)
 *  - remainder: whatever is left after every other share (at most one payer)
 * Without a remainder payer the shares must cover the total exactly.
 */
export function allocateSplit(totalCents: number, rows: Pick<SplitDraftRow, 'shareType' | 'shareValue'>[]): AllocationResult {
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) return fail('This invoice has no amount to split.');
  if (rows.length < MIN_SPLIT_PAYERS) return fail('Add at least two payers.');
  if (rows.length > MAX_SPLIT_PAYERS) return fail(`A split can have at most ${MAX_SPLIT_PAYERS} payers.`);

  const amounts: number[] = rows.map(() => 0);
  const pct: { i: number; h: number }[] = [];
  let fixedSum = 0;
  let remainderIdx = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.shareType === 'fixed') {
      const parsed = parseMoneyInput(row.shareValue, totalCents);
      if (!parsed.ok) return fail(`Payer ${i + 1}: ${parsed.error}`);
      amounts[i] = parsed.cents;
      fixedSum += parsed.cents;
    } else if (row.shareType === 'percent') {
      const h = parsePercentInput(row.shareValue);
      if (h === null) return fail(`Payer ${i + 1}: enter a percentage from 0.01 to 100.`);
      pct.push({ i, h });
    } else {
      if (remainderIdx !== -1) return fail('Only one payer can cover the remainder.');
      remainderIdx = i;
    }
  }

  const floors = pct.map((p) => Math.floor((totalCents * p.h) / 10000));
  pct.forEach((p, k) => { amounts[p.i] = floors[k]; });
  const floorSum = floors.reduce((a, b) => a + b, 0);

  if (remainderIdx !== -1) {
    const rest = totalCents - fixedSum - floorSum;
    if (rest <= 0) return fail(`The other payers already cover ${formatCents(fixedSum + floorSum)}, so nothing is left for the remainder.`);
    amounts[remainderIdx] = rest;
  } else {
    const target = totalCents - fixedSum;
    const sumH = pct.reduce((a, p) => a + p.h, 0);
    const exact = pct.length > 0 ? sumH * totalCents === target * 10000 : target === 0;
    if (!exact) {
      if (fixedSum === 0) return fail(`Percentages add up to ${(sumH / 100).toFixed(2).replace(/\.?0+$/, '')}%. They must total exactly 100%.`);
      const assigned = fixedSum + Math.round((totalCents * sumH) / 10000);
      return fail(
        assigned === totalCents
          ? 'These shares do not add up to the invoice total. Let one payer cover the remainder.'
          : `Shares add up to ${formatCents(assigned)} but the invoice total is ${formatCents(totalCents)}.`,
      );
    }
    // Largest-remainder: hand the leftover cents to the biggest fractional parts (ties: first payer).
    let left = target - floorSum;
    const order = pct.map((p) => ({ i: p.i, frac: (totalCents * p.h) % 10000 })).sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (const o of order) {
      if (left <= 0) break;
      amounts[o.i] += 1;
      left -= 1;
    }
  }

  if (amounts.some((a) => a <= 0)) return fail('Every payer must owe more than $0.00.');
  return { ok: true, amounts };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type DraftValidation = { ok: true; amounts: number[]; payload: SplitPayerInput[] } | { ok: false; error: string };

/** Validates contact fields + shares and builds the exact payload the `save_invoice_split` RPC expects. */
export function validateSplitDraft(rows: SplitDraftRow[], totalCents: number): DraftValidation {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const name = r.name.trim();
    if (!name) return fail(`Payer ${i + 1}: enter a name.`);
    if (name.length > 120) return fail(`Payer ${i + 1}: the name is too long.`);
    const email = r.email.trim();
    if (email && (email.length > 254 || !EMAIL_RE.test(email))) return fail(`Payer ${i + 1}: enter a valid email or leave it empty.`);
    if (r.phone.trim().length > 40) return fail(`Payer ${i + 1}: the phone number is too long.`);
  }
  const allocation = allocateSplit(totalCents, rows);
  if (!allocation.ok) return allocation;

  const payload = rows.map((r, i): SplitPayerInput => {
    const h = r.shareType === 'percent' ? parsePercentInput(r.shareValue) : null;
    return {
      ...(r.id ? { id: r.id } : {}),
      role: r.role,
      name: r.name.trim(),
      email: r.email.trim() || null,
      phone: r.phone.trim() || null,
      share_type: r.shareType,
      share_value: h === null ? null : (h / 100).toFixed(2),
      amount_cents: allocation.amounts[i],
    };
  });
  return { ok: true, amounts: allocation.amounts, payload };
}

export type PayerState = 'unpaid' | 'partial' | 'paid';

export interface PayerStanding {
  payer: SplitPayer;
  paidCents: number;
  refundedCents: number;
  netPaidCents: number;
  remainingCents: number;
  /** Net paid above the planned share (e.g. the insurer paid more than estimated). */
  overCents: number;
  state: PayerState;
}

/** Each payer's progress, derived from the same payments/refunds the invoice ledger uses. */
export function computePayerStandings(
  payers: SplitPayer[],
  payments: Pick<InvoicePayment, 'id' | 'amount_cents' | 'payer_id'>[],
  refunds: Pick<InvoiceRefund, 'payment_id' | 'amount_cents'>[],
): PayerStanding[] {
  return [...payers]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((payer) => {
      const own = payments.filter((p) => p.payer_id === payer.id);
      const ids = new Set(own.map((p) => p.id));
      const paidCents = own.reduce((s, p) => s + p.amount_cents, 0);
      const refundedCents = refunds.filter((r) => ids.has(r.payment_id)).reduce((s, r) => s + r.amount_cents, 0);
      const netPaidCents = paidCents - refundedCents;
      const state: PayerState = netPaidCents >= payer.amount_cents ? 'paid' : netPaidCents > 0 ? 'partial' : 'unpaid';
      return {
        payer,
        paidCents,
        refundedCents,
        netPaidCents,
        remainingCents: Math.max(0, payer.amount_cents - netPaidCents),
        overCents: Math.max(0, netPaidCents - payer.amount_cents),
        state,
      };
    });
}

/** Net money paid on the invoice that is not attributed to any current payer (e.g. recorded before the split). */
export function unattributedNetCents(
  payers: Pick<SplitPayer, 'id'>[],
  payments: Pick<InvoicePayment, 'id' | 'amount_cents' | 'payer_id'>[],
  refunds: Pick<InvoiceRefund, 'payment_id' | 'amount_cents'>[],
): number {
  const known = new Set(payers.map((p) => p.id));
  const loose = payments.filter((p) => !p.payer_id || !known.has(p.payer_id));
  const ids = new Set(loose.map((p) => p.id));
  return loose.reduce((s, p) => s + p.amount_cents, 0) - refunds.filter((r) => ids.has(r.payment_id)).reduce((s, r) => s + r.amount_cents, 0);
}

/** True when the invoice total changed after the split was saved (links stop accepting money until re-saved). */
export function isSplitStale(payers: Pick<SplitPayer, 'plan_total_cents'>[], totalCents: number): boolean {
  return payers.length > 0 && payers.some((p) => p.plan_total_cents !== totalCents);
}

export function getSplitPayLink(token: string): string {
  return `${window.location.origin}/pay-share/${token}`;
}

let rowSeq = 0;
export function newDraftRow(init: Partial<Omit<SplitDraftRow, 'key'>> = {}): SplitDraftRow {
  rowSeq += 1;
  return { key: `row-${rowSeq}`, role: 'other', name: '', email: '', phone: '', shareType: 'fixed', shareValue: '', ...init };
}

export function draftFromPayers(payers: SplitPayer[]): SplitDraftRow[] {
  return [...payers]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((p) =>
      newDraftRow({
        id: p.id,
        role: p.role,
        name: p.name,
        email: p.email ?? '',
        phone: p.phone ?? '',
        shareType: p.share_type,
        shareValue: p.share_type === 'fixed' ? (p.amount_cents / 100).toFixed(2) : p.share_type === 'percent' ? String(Number(p.share_value ?? 0)) : '',
      }),
    );
}

export interface SplitPreset {
  id: string;
  label: string;
  hint: string;
  rows: Pick<SplitDraftRow, 'role' | 'shareType' | 'shareValue'>[];
}

export const SPLIT_PRESETS: SplitPreset[] = [
  {
    id: 'customer-insurer',
    label: 'Customer + insurer',
    hint: 'The insurer pays a set amount; the customer pays the rest.',
    rows: [
      { role: 'insurer', shareType: 'fixed', shareValue: '' },
      { role: 'customer', shareType: 'remainder', shareValue: '' },
    ],
  },
  {
    id: 'landlord-tenant',
    label: 'Landlord + tenant',
    hint: 'Split 50 / 50. Change the percentages as needed.',
    rows: [
      { role: 'landlord', shareType: 'percent', shareValue: '50' },
      { role: 'tenant', shareType: 'percent', shareValue: '50' },
    ],
  },
  {
    id: 'custom',
    label: 'Custom',
    hint: 'Two payers to start. Add up to ten.',
    rows: [
      { role: 'customer', shareType: 'percent', shareValue: '50' },
      { role: 'other', shareType: 'percent', shareValue: '50' },
    ],
  },
];

export function rowsFromPreset(presetId: string): SplitDraftRow[] {
  const preset = SPLIT_PRESETS.find((p) => p.id === presetId) ?? SPLIT_PRESETS[2];
  return preset.rows.map((r) => newDraftRow({ ...r }));
}

// ─── Data access (reads scoped to the account owner; writes only through RPCs) ───

export async function fetchSplitPayers(ownerId: string, invoiceId: string): Promise<SplitPayer[]> {
  const { data, error } = await supabase
    .from('invoice_split_payers')
    .select('*')
    .eq('invoice_id', invoiceId)
    .eq('user_id', ownerId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []) as SplitPayer[];
}

export async function saveInvoiceSplit(invoiceId: string, payers: SplitPayerInput[]): Promise<void> {
  const { error } = await supabase.rpc('save_invoice_split', { p_invoice_id: invoiceId, p_payers: payers });
  if (error) throw error;
}

export async function clearInvoiceSplit(invoiceId: string): Promise<void> {
  const { error } = await supabase.rpc('clear_invoice_split', { p_invoice_id: invoiceId });
  if (error) throw error;
}

export async function recordSplitPayment(input: {
  payerId: string;
  amountCents: number;
  method: PaymentMethod;
  reference?: string;
  note?: string;
  paidAt?: string;
}): Promise<void> {
  const { error } = await supabase.rpc('record_split_payment', {
    p_payer_id: input.payerId,
    p_amount_cents: input.amountCents,
    p_method: input.method,
    p_reference: input.reference?.trim() || null,
    p_paid_at: input.paidAt ?? null,
    p_note: input.note?.trim() || null,
  });
  if (error) throw error;
}

/** supabase.functions.invoke hides the JSON body of non-2xx replies in error.context. */
async function readEmailError(error: unknown): Promise<Error> {
  const ctx = (error as { context?: unknown })?.context;
  if (ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: string };
      if (body?.error) return new Error(body.error);
    } catch {
      /* body was not JSON */
    }
    return new Error('Could not send the email. Please try again.');
  }
  return new Error('Could not reach the server. Check your connection and try again.');
}

export async function emailSplitLink(payerId: string): Promise<{ recipient: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('invoice-split-email', {
    body: { payer_id: payerId },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) throw await readEmailError(error);
  const payload = data as { ok?: boolean; recipient?: string; error?: string } | null;
  if (!payload?.ok) throw new Error(payload?.error ?? 'Could not send the email.');
  return { recipient: payload.recipient ?? '' };
}
