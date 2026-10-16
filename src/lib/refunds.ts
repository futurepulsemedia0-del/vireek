import { supabase } from '@/lib/supabase';
import type { ReasonCode, Refund, RefundablePayment } from '@/lib/refundMath';

export * from '@/lib/refundMath';

export class RefundError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'RefundError';
    this.status = status;
  }
}

export interface RefundOutcome {
  refund: Refund;
  warning: 'status_unknown' | 'accounting_pending' | null;
  message: string | null;
}

/** supabase.functions.invoke hides the JSON body of non-2xx replies in error.context. */
async function readFunctionError(error: unknown): Promise<RefundError> {
  const ctx = (error as { context?: unknown })?.context;
  if (ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: string };
      if (body?.error) return new RefundError(body.error, ctx.status);
    } catch {
      /* body was not JSON */
    }
    return new RefundError('The refund could not be processed. Please try again.', ctx.status);
  }
  return new RefundError('Could not reach the server. Check your connection and retry — retrying is safe.');
}

async function callRefundFunction(body: Record<string, unknown>): Promise<RefundOutcome> {
  const { data, error } = await supabase.functions.invoke('issue-refund', { body });
  if (error) throw await readFunctionError(error);
  const d = data as { refund?: Refund; warning?: RefundOutcome['warning']; message?: string } | null;
  if (!d?.refund) throw new RefundError('Unexpected response from the server.');
  return { refund: d.refund, warning: d.warning ?? null, message: d.message ?? null };
}

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function fetchRefundablePayments(opts: { search?: string; paymentId?: string } = {}): Promise<RefundablePayment[]> {
  const { data, error } = await supabase.rpc('get_refundable_payments', {
    p_search: opts.search?.trim() || null,
    p_limit: 100,
    p_payment_id: opts.paymentId ?? null,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as RefundablePayment[];
}

export async function fetchRefunds(limit = 200): Promise<Refund[]> {
  const { data, error } = await supabase.from('refunds').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as Refund[];
}

export function issueRefund(input: {
  paymentRequestId: string;
  amountCents: number;
  reasonCode: ReasonCode;
  reasonNote: string | null;
  notifyCustomer: boolean;
  idempotencyKey: string;
}): Promise<RefundOutcome> {
  return callRefundFunction({
    payment_request_id: input.paymentRequestId,
    amount_cents: input.amountCents,
    reason_code: input.reasonCode,
    reason_note: input.reasonNote,
    notify_customer: input.notifyCustomer,
    idempotency_key: input.idempotencyKey,
  });
}

export function resumeRefund(refundId: string): Promise<RefundOutcome> {
  return callRefundFunction({ action: 'resume', refund_id: refundId });
}
