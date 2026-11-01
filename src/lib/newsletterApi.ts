import { supabase } from '@/lib/supabase';

export const NEWSLETTER_CONSENT_TEXT =
  'Yes, email me new Vireek articles and playbooks. I can unsubscribe at any time. See the Privacy Policy.';

export type NewsletterResult = { ok: true; already?: boolean } | { ok: false; message: string };

const GENERIC = 'Something went wrong. Please try again in a moment.';

async function call(body: Record<string, unknown>): Promise<NewsletterResult> {
  try {
    const { data, error } = await supabase.functions.invoke('blog-newsletter', { body });
    if (!error && data?.success) return { ok: true, already: Boolean(data.already) };
    const response = (error as { context?: Response } | null)?.context;
    const payload = response && typeof response.json === 'function' ? await response.json().catch(() => null) : data;
    return { ok: false, message: typeof payload?.message === 'string' ? payload.message : GENERIC };
  } catch {
    return { ok: false, message: GENERIC };
  }
}

/** Step 1 of double opt-in: server stores a pending row and emails a confirmation link. */
export const subscribeToNewsletter = (email: string, source: string, website = '') =>
  call({ action: 'subscribe', email, source, consent: true, consentVersion: 'v1', website });
export const confirmNewsletter = (token: string) => call({ action: 'confirm', token });
export const unsubscribeNewsletter = (token: string) => call({ action: 'unsubscribe', token });
