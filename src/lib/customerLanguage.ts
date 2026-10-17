import { supabase } from '@/lib/supabase';
import {
  LANGUAGE_META,
  SUPPORTED_LANGUAGES,
  languageOptionLabel,
  normalizeLanguage,
  sourceLabel,
  type LanguageCode,
  type LanguageSource,
} from '../../supabase/functions/_shared/i18n/languages';

/**
 * Customer language preference — client helpers.
 * Source of truth for codes/labels is the shared module also used by the Edge Functions.
 */
export { LANGUAGE_META, SUPPORTED_LANGUAGES, languageOptionLabel, normalizeLanguage, sourceLabel };
export type { LanguageCode, LanguageSource };

export const LANGUAGE_OPTIONS = SUPPORTED_LANGUAGES.map((code) => ({
  code,
  label: languageOptionLabel(code),
}));

/**
 * Staff change. Passing null clears the language (the assistant then adapts
 * on the next call and auto-detection may fill it again).
 * The database trigger records source = 'staff' and the timestamp.
 */
export async function updateCustomerLanguage(
  customerId: string,
  language: LanguageCode | null,
): Promise<boolean> {
  const { error } = await supabase
    .from('customers')
    .update({ preferred_language: language, preferred_language_source: language ? 'staff' : null })
    .eq('id', customerId);
  return !error;
}

/** Public (token-gated) lookups. They return null on any failure so pages simply keep the visitor's own language. */
export async function fetchPortalLanguage(token: string): Promise<LanguageCode | null> {
  const { data, error } = await supabase.rpc('get_portal_language', { p_token: token });
  return error ? null : normalizeLanguage(data);
}

export async function fetchInvoiceLanguage(token: string): Promise<LanguageCode | null> {
  const { data, error } = await supabase.rpc('get_invoice_language', { p_token: token });
  return error ? null : normalizeLanguage(data);
}

export async function savePortalLanguage(token: string, language: LanguageCode): Promise<boolean> {
  const { data, error } = await supabase.rpc('set_portal_language', {
    p_token: token,
    p_language: language,
  });
  return !error && Boolean(data);
}
