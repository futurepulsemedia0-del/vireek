import { supabase } from '@/lib/supabase';
import { GENERIC_ERROR, interpretResponse, type SalesPayload, type SubmitResult } from '@/lib/contactSales';

/** Sends the inquiry to the contact-sales Edge Function and normalizes every outcome. */
export async function submitSalesInquiry(payload: SalesPayload): Promise<SubmitResult> {
  try {
    const { data, error } = await supabase.functions.invoke('contact-sales', { body: payload });
    if (!error) return interpretResponse(200, data);

    // Non-2xx: supabase-js hands us the raw Response on error.context, so we can read our JSON error body.
    const response = (error as { context?: Response }).context;
    if (response && typeof response.json === 'function') {
      const body = await response.json().catch(() => null);
      return interpretResponse(response.status, body);
    }
    return { kind: 'error', message: GENERIC_ERROR };
  } catch {
    return { kind: 'error', message: GENERIC_ERROR };
  }
}
