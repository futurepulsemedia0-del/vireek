// src/lib/outcomeProof/api.ts - data access for the outcome proof kit. Tenant and permission are resolved server-side
// (get_account_owner_id / reports_can_access); the owner id below is only used to filter reads that RLS already restricts.
import { supabase } from '@/lib/supabase';
import { sha256Hex, type ProofCase, type ProofConsent, type ProofSource } from './method';
import { mapCase, mapConsent, mapSource, strOrNull, type Row } from './mappers';

export { mapCase, mapConsent, mapSource } from './mappers';

export const CONSENT_TEXT_VERSION = 'draft-0';
/**
 * [COUNSEL] Placeholder wording. It must be replaced by counsel-approved text and the version bumped before any real customer
 * is asked to consent. The hash of whatever text was shown is stored with each consent.
 */
export const CONSENT_TEXT = [
  'I confirm I am authorised to speak for this business.',
  'I agree that Vireek may publish the figures in this case study, calculated from my own account records as shown.',
  'Only the items I tick below (business name, my name, quote) may be shown.',
  'I understand the figures are not independently audited unless the document says so, and that I can withdraw this consent at any time. Withdrawal stops future use; it cannot recall material already published.',
].join('\n');
export const consentTextSha256 = (): string => sha256Hex(CONSENT_TEXT);

const permissionMessage = 'You don’t have permission to use customer outcome cases.';
function fail(error: { code?: string; message: string }): never {
  if (error.code === '42501') throw new Error(permissionMessage);
  throw new Error(error.message);
}

export async function listCases(): Promise<ProofCase[]> {
  const { data, error } = await supabase.from('outcome_cases').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) fail(error);
  return (data ?? []).map((r) => mapCase(r as Row));
}

export interface CaseBundle { case: ProofCase; sources: ProofSource[]; consents: ProofConsent[]; businessName: string | null }

export async function loadCase(id: string, ownerId: string): Promise<CaseBundle> {
  const [c, s, k, p] = await Promise.all([
    supabase.from('outcome_cases').select('*').eq('id', id).single(),
    // 5000 is the per-case ceiling enforced by outcome_case_create().
    supabase.from('outcome_case_sources').select('*').eq('case_id', id).limit(5000),
    supabase.from('outcome_case_consents').select('*').eq('case_id', id).order('decided_at', { ascending: true }).order('id', { ascending: true }),
    supabase.from('profiles').select('company_name').eq('id', ownerId).maybeSingle(),
  ]);
  if (c.error) fail(c.error);
  if (s.error) fail(s.error);
  if (k.error) fail(k.error);
  return {
    case: mapCase(c.data as Row), sources: (s.data ?? []).map((r) => mapSource(r as Row)), consents: (k.data ?? []).map((r) => mapConsent(r as Row)),
    businessName: strOrNull((p.data as Row | null)?.company_name),
  };
}

export async function createCase(input: { title: string; start: string; end: string; currency: string; costCents: number | null }): Promise<string> {
  const { data, error } = await supabase.rpc('outcome_case_create', { p_title: input.title, p_start: input.start, p_end: input.end, p_currency: input.currency, p_cost_cents: input.costCents });
  if (error) fail(error);
  return String(data);
}

export interface ConsentInput {
  caseId: string; decision: 'granted' | 'revoked'; allowBusinessName: boolean; allowPersonName: boolean; allowQuote: boolean;
  quote: string | null; signerName: string; signerRole: string | null;
}
export async function setConsent(i: ConsentInput): Promise<void> {
  const { error } = await supabase.rpc('outcome_case_set_consent', {
    p_case: i.caseId, p_decision: i.decision, p_allow_business_name: i.allowBusinessName, p_allow_person_name: i.allowPersonName, p_allow_quote: i.allowQuote,
    p_quote: i.quote, p_signer_name: i.signerName, p_signer_role: i.signerRole, p_text_version: CONSENT_TEXT_VERSION, p_text_sha256: consentTextSha256(),
  });
  if (error) fail(error);
}

export async function logExport(caseId: string, format: 'markdown' | 'pdf'): Promise<void> {
  const { error } = await supabase.rpc('outcome_case_log_export', { p_case: caseId, p_format: format });
  if (error) fail(error);
}
