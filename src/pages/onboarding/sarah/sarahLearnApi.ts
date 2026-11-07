import { supabase } from '@/lib/supabase';
import { trackEvent } from '@/lib/analytics';
import type { LearnField, LearnRun, LearnSource } from './sarahLearnLogic';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export interface StartInput {
  websiteUrl: string;
  pastedText: string;
  ownPropertyConfirmed: boolean;
  locale: 'en' | 'es';
  parentRunId?: string;
}

export type StartEvent =
  | { step: 'run'; run_id: string }
  | { step: 'fetch'; url: string; status: 'fetched' | 'blocked_robots' | 'failed'; code?: string }
  | { step: 'extract'; done: number; total: number }
  | { step: 'done'; run_id: string; fields: number; sources: number; ms: number }
  | { step: 'error'; message: string };

export class ApiError extends Error {}

async function authToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('Not signed in.');
  return token;
}

/** Streams REAL progress events from sarah-learn-start (no fake timers). */
export async function startRun(input: StartInput, onEvent: (e: StartEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/sarah-learn-start`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await authToken()}`, apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({
      website_url: input.websiteUrl,
      pasted_text: input.pastedText,
      own_property_confirmed: input.ownPropertyConfirmed,
      locale: input.locale,
      parent_run_id: input.parentRunId,
    }),
  });
  if (!res.ok || !res.body) {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(j?.error ?? 'Could not start. Please try again.');
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!line.startsWith('data:')) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as StartEvent);
      } catch {
        // ignore malformed chunk
      }
    }
  }
}

async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let msg = 'Something went wrong. Please try again.';
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      const j = (await ctx.json().catch(() => null)) as { error?: string } | null;
      if (j?.error) msg = j.error;
    }
    throw new ApiError(msg);
  }
  return data as T;
}

export interface InterviewQuestionDto {
  id: string;
  key: string;
  text: string;
  choices: { value: string; label: string }[];
}
export interface InterviewState {
  question: InterviewQuestionDto | null;
  remaining: number;
  answered: number;
  max_questions: number;
  estimate_seconds: number;
  done: boolean;
}

export const interview = (runId: string, action: 'next' | 'answer' | 'skip', questionId?: string, answer?: string) =>
  invoke<InterviewState>('sarah-learn-interview', { run_id: runId, action, question_id: questionId, answer });

export interface ScenarioResultDto {
  id: string;
  category: string;
  critical: boolean;
  caller: string;
  reply: string;
  passed: boolean;
  failures: string[];
}
export interface ReadinessResponse {
  scorecard: { total: number; passed: number; rate: number; criticalFailed: string[]; meetsThreshold: boolean; passed_gate: boolean };
  results: ScenarioResultDto[];
}
export const runReadiness = (runId: string) => invoke<ReadinessResponse>('sarah-learn-readiness', { run_id: runId });

export async function loadLatestRun(): Promise<LearnRun | null> {
  const { data, error } = await supabase
    .from('sarah_learn_runs')
    .select('id,status,locale,website_url,started_at,first_draft_at,readiness_passed,readiness_score,test_call_confirmed_at,live_at')
    .neq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new ApiError(error.message);
  return (data as LearnRun | null) ?? null;
}

export async function loadRunDetail(runId: string): Promise<{ run: LearnRun; fields: LearnField[]; sources: LearnSource[]; results: ScenarioResultDto[] }> {
  const [run, fields, sources, results] = await Promise.all([
    supabase.from('sarah_learn_runs').select('id,status,locale,website_url,started_at,first_draft_at,readiness_passed,readiness_score,test_call_confirmed_at,live_at').eq('id', runId).single(),
    supabase.from('sarah_learn_fields').select('id,key,value,prev_value,confidence,assumed,sensitive,origin,source_id,citation,status,edit_count').eq('run_id', runId),
    supabase.from('sarah_learn_sources').select('id,kind,url,label,status,error_code').eq('run_id', runId),
    supabase.from('sarah_learn_scenario_results').select('scenario_id,category,critical,caller_text,reply_text,passed,failures').eq('run_id', runId).order('ran_at'),
  ]);
  if (run.error) throw new ApiError(run.error.message);
  if (fields.error) throw new ApiError(fields.error.message);
  if (sources.error) throw new ApiError(sources.error.message);
  if (results.error) throw new ApiError(results.error.message);
  return {
    run: run.data as LearnRun,
    fields: (fields.data ?? []) as LearnField[],
    sources: (sources.data ?? []) as LearnSource[],
    results: (results.data ?? []).map((r) => ({ id: r.scenario_id as string, category: r.category as string, critical: !!r.critical, caller: r.caller_text as string, reply: r.reply_text as string, passed: !!r.passed, failures: (r.failures as string[]) ?? [] })),
  };
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new ApiError(error.message);
  return data as T;
}

export const setField = (runId: string, key: string, value: unknown, action: 'approve' | 'edit' | 'reject') =>
  rpc<void>('sarah_learn_set_field', { p_run: runId, p_key: key, p_value: value ?? null, p_action: action });
export const bulkApprove = (runId: string) => rpc<number>('sarah_learn_bulk_approve', { p_run: runId });
export const confirmTestCall = (runId: string) => rpc<void>('sarah_learn_confirm_test_call', { p_run: runId });
export const goLive = (runId: string) => rpc<{ live?: boolean; already_live?: boolean; time_to_live_ms?: number }>('sarah_learn_go_live', { p_run: runId });
export const deleteRun = (runId: string) => rpc<void>('sarah_learn_delete_run', { p_run: runId });
export const deleteAll = () => rpc<number>('sarah_learn_delete_all', {});
export const refreshSuggestions = () => rpc<number>('sarah_learn_refresh_suggestions', {});
export const decideSuggestion = (id: string, decision: 'approve' | 'dismiss', answer?: string) =>
  rpc<void>('sarah_learn_decide_suggestion', { p_id: id, p_decision: decision, p_answer: answer ?? null });

export interface Suggestion {
  id: string;
  kind: string;
  payload: { question?: string; asked_count?: number };
}
export async function loadSuggestions(): Promise<Suggestion[]> {
  const { data, error } = await supabase.from('sarah_learn_suggestions').select('id,kind,payload').eq('status', 'pending').order('created_at', { ascending: false }).limit(10);
  if (error) throw new ApiError(error.message);
  return (data ?? []) as Suggestion[];
}

/** Consent-gated (trackEvent is a no-op until analytics consent). Never sends content or PII. */
export function track(event: string, params: Record<string, number | string | boolean> = {}): void {
  trackEvent(`sarah_learn_${event}`, params);
}
