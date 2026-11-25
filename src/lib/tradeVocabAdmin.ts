import { supabase } from '@/lib/supabase';
import type { EntryDraft, EvalResult } from '@/lib/tradeVocabModel';
import { parseSynonymInput } from '@/lib/tradeVocabModel';

export interface VocabEntryRow {
  id: string;
  trade: string;
  dialect: string;
  term: string;
  category: string;
  synonyms: string[];
  pronunciation_hint: string | null;
  boost: number;
  status: 'active' | 'retired';
  updated_at: string;
}

export interface VocabVersionRow {
  id: string;
  trade: string;
  dialect: string;
  version: number;
  content_hash: string;
  note: string | null;
  created_at: string;
}

export interface VocabEvalRow {
  id: string;
  version_id: string | null;
  label: string;
  dataset_ref: string | null;
  n_calls: number;
  n_ref_words: number;
  n_term_occurrences: number;
  baseline_wer: number;
  biased_wer: number;
  baseline_term_recall: number | null;
  biased_term_recall: number | null;
  notes: string | null;
  created_at: string;
}

export interface PublishResult {
  version_id: string;
  version_no: number;
  content_sha256: string;
  entry_count: number;
  created: boolean;
}

// All reads go through RLS (staff only); all writes go through SECURITY DEFINER RPCs that re-check staff and re-validate input.

export async function fetchVocabEntries(trade: string, dialect: string): Promise<VocabEntryRow[]> {
  const { data, error } = await supabase
    .from('trade_vocab_entries')
    .select('id, trade, dialect, term, category, synonyms, pronunciation_hint, boost, status, updated_at')
    .eq('trade', trade)
    .eq('dialect', dialect)
    .order('term', { ascending: true })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as VocabEntryRow[];
}

export async function saveVocabEntry(args: { id: string | null; trade: string; dialect: string; draft: EntryDraft; status: 'active' | 'retired' }): Promise<string> {
  const { data, error } = await supabase.rpc('trade_vocab_upsert_entry', {
    p_id: args.id,
    p_trade: args.trade,
    p_dialect: args.dialect,
    p_term: args.draft.term,
    p_category: args.draft.category,
    p_synonyms: parseSynonymInput(args.draft.synonymsText),
    p_pronunciation_hint: args.draft.pronunciationHint.trim() === '' ? null : args.draft.pronunciationHint,
    p_boost: args.draft.boost,
    p_status: args.status,
  });
  if (error) throw error;
  return data as string;
}

export async function publishVocab(trade: string, dialect: string, note: string): Promise<PublishResult> {
  const { data, error } = await supabase.rpc('trade_vocab_publish', { p_trade: trade, p_dialect: dialect, p_note: note.trim() === '' ? null : note });
  if (error) throw error;
  const row = (data ?? [])[0] as PublishResult | undefined;
  if (!row) throw new Error('publish returned no row');
  return row;
}

export async function fetchVocabVersions(trade: string, dialect: string): Promise<VocabVersionRow[]> {
  const { data, error } = await supabase
    .from('trade_vocab_versions')
    .select('id, trade, dialect, version, content_hash, note, created_at')
    .eq('trade', trade)
    .eq('dialect', dialect)
    .order('version', { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as VocabVersionRow[];
}

export async function fetchVocabEvalRuns(trade: string, dialect: string): Promise<VocabEvalRow[]> {
  const { data, error } = await supabase
    .from('trade_vocab_eval_runs')
    .select('id, version_id, label, dataset_ref, n_calls, n_ref_words, n_term_occurrences, baseline_wer, biased_wer, baseline_term_recall, biased_term_recall, notes, created_at')
    .eq('trade', trade)
    .eq('dialect', dialect)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as VocabEvalRow[];
}

export async function recordVocabEval(args: { trade: string; dialect: string; versionId: string | null; label: string; datasetRef: string; notes: string; result: EvalResult }): Promise<string> {
  const { data, error } = await supabase.rpc('trade_vocab_record_eval', {
    p_trade: args.trade,
    p_dialect: args.dialect,
    p_version_id: args.versionId,
    p_label: args.label,
    p_dataset_ref: args.datasetRef.trim() === '' ? null : args.datasetRef,
    p_n_calls: args.result.n_calls,
    p_n_ref_words: args.result.n_ref_words,
    p_n_term_occurrences: args.result.n_term_occurrences,
    p_baseline_wer: args.result.baseline_wer,
    p_biased_wer: args.result.biased_wer,
    p_baseline_term_recall: args.result.baseline_term_recall,
    p_biased_term_recall: args.result.biased_term_recall,
    p_notes: args.notes.trim() === '' ? null : args.notes,
  });
  if (error) throw error;
  return data as string;
}
