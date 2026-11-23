import { supabase } from '../supabase';
import { parseOverview, type LaborOverview } from './overview';
import type { WorkerClassification } from './evaluate';
import type { RuleTopic } from './rules';

export async function fetchLaborOverview(from: string, to: string): Promise<LaborOverview> {
  const { data, error } = await supabase.rpc('labor_signals_overview', { p_from: from, p_to: to });
  if (error) throw error;
  return parseOverview(data);
}

export async function setWorkerClassification(employeeId: string, classification: WorkerClassification, basisNote: string): Promise<void> {
  const { error } = await supabase.rpc('set_worker_classification', {
    p_employee_id: employeeId,
    p_classification: classification,
    p_basis_note: basisNote.trim() || null,
  });
  if (error) throw error;
}

export async function saveLaborRuleConfig(args: {
  topic: RuleTopic;
  jurisdiction: string;
  enabled: boolean;
  params: object;
  citation: string | null;
  sourceUrl: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc('save_labor_rule_config', {
    p_topic: args.topic,
    p_jurisdiction: args.jurisdiction,
    p_enabled: args.enabled,
    p_params: args.params,
    p_citation: args.citation,
    p_source_url: args.sourceUrl,
  });
  if (error) throw error;
}

export async function recordLaborRuleReview(topic: RuleTopic, counselReviewer: string, verifiedOn: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('record_labor_rule_review', {
    p_topic: topic,
    p_counsel_reviewer: counselReviewer.trim() || null,
    p_verified_on: verifiedOn || null,
    p_note: note.trim() || null,
  });
  if (error) throw error;
}

export async function reviewLaborSignal(signalKey: string, status: 'open' | 'acknowledged' | 'no_action_needed' | 'sent_to_counsel', note: string): Promise<void> {
  const { error } = await supabase.rpc('review_labor_signal', { p_signal_key: signalKey, p_status: status, p_note: note.trim() || null });
  if (error) throw error;
}

/** Maps a server error to an i18n key under `laborSignals:errors.*`. Never shows raw database text. */
export function laborErrorKey(err: unknown): 'permission' | 'range' | 'invalid' | 'notFound' | 'generic' {
  const e = (err ?? {}) as { code?: string; message?: string };
  if (e.code === '42501') return 'permission';
  if (e.code === 'P0002') return 'notFound';
  if (e.code === '22023') return /range/i.test(e.message ?? '') ? 'range' : 'invalid';
  return 'generic';
}
