import { supabase } from '@/lib/supabase';
import { acceptanceVersionIds, parseLegalAcceptanceState, type LegalAcceptanceState } from '@/lib/legalAcceptance';

/** null = could not be determined (network/RPC error or unreadable payload). */
export async function fetchLegalAcceptanceState(): Promise<LegalAcceptanceState | null> {
  const { data, error } = await supabase.rpc('legal_acceptance_status');
  if (error) return null;
  return parseLegalAcceptanceState(data);
}

export async function acceptRequiredLegal(state: LegalAcceptanceState): Promise<void> {
  const { error } = await supabase.rpc('accept_legal_versions', { p_version_ids: acceptanceVersionIds(state), p_source: 'gate' });
  if (error) throw new Error(error.message);
}

/** Best effort right after signup (the database only allows it for accounts created in the last 24 hours). */
export async function recordSignupAcceptance(): Promise<void> {
  try {
    await supabase.rpc('accept_current_legal_documents', { p_source: 'signup' });
  } catch {
    /* non-fatal: the re-acceptance gate is the safety net */
  }
}
