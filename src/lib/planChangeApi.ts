// src/lib/planChangeApi.ts
//
// Thin client for the `manage-subscription-plan` edge function.
import { supabase } from '@/lib/supabase';
import type { PlanId } from '@/lib/pricing';
import { PlanChangeError, type PlanChangePreview, type SubscriptionState } from '@/lib/planChange';

const FUNCTION_NAME = 'manage-subscription-plan';

/** supabase-js hides non-2xx bodies inside error.context (a Response) — read it so users see the real reason. */
async function toPlanChangeError(error: unknown): Promise<PlanChangeError> {
  const context = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && context instanceof Response) {
    try {
      const body = (await context.clone().json()) as { error?: string; code?: string };
      if (body?.error) return new PlanChangeError(body.error, body.code);
    } catch {
      // fall through to the generic message
    }
  }
  return new PlanChangeError(
    error instanceof Error && error.message ? error.message : 'Could not reach billing. Please try again.',
  );
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T & { error?: string; code?: string }>(FUNCTION_NAME, { body });
  if (error) throw await toPlanChangeError(error);
  if (!data) throw new PlanChangeError('Billing returned an empty response.');
  if (typeof data === 'object' && 'error' in data && data.error) throw new PlanChangeError(data.error, data.code);
  return data as T;
}

export function fetchSubscriptionState(): Promise<SubscriptionState> {
  return call<SubscriptionState>({ action: 'state' });
}

export function previewPlanChange(planId: PlanId): Promise<PlanChangePreview> {
  return call<PlanChangePreview>({ action: 'preview', planId });
}

export function applyPlanChange(preview: PlanChangePreview): Promise<{ ok: true; kind: 'upgrade' | 'downgrade'; effectiveAt: string }> {
  return call({
    action: 'apply',
    planId: preview.targetPlanId,
    prorationDate: preview.prorationDate,
    expectedDueNowMinor: preview.dueNowMinor,
  });
}

export function cancelScheduledChange(): Promise<{ ok: true }> {
  return call({ action: 'cancel_scheduled' });
}

export async function startPlanCheckout(planId: PlanId): Promise<string> {
  const { url } = await call<{ url: string | null }>({ action: 'checkout', planId });
  if (!url) throw new PlanChangeError('Could not start checkout.');
  return url;
}
