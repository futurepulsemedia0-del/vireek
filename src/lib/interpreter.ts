import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  INTERP_LANGUAGES,
  INTERP_META,
  NON_ENGLISH,
  DEFAULT_GREETINGS,
  interpLabel,
  normalizeInterpLang,
  type InterpLang,
  type NonEnglish,
} from '../../supabase/functions/_shared/interpreter/languages';
import { detectEmergency } from '../../supabase/functions/_shared/interpreter/safety';
import { identifyLanguage } from '../../supabase/functions/_shared/interpreter/langid';
import { extractCritical } from '../../supabase/functions/_shared/interpreter/critical';

export { INTERP_LANGUAGES, INTERP_META, NON_ENGLISH, DEFAULT_GREETINGS, interpLabel, normalizeInterpLang, detectEmergency, identifyLanguage, extractCritical };
export type { InterpLang, NonEnglish };

export type InterpMode = 'assistant' | 'bridge_consecutive' | 'bridge_simultaneous' | 'captions';
export const MODE_LABELS: Record<InterpMode, string> = {
  assistant: 'Sarah handles the call in the caller’s language',
  bridge_consecutive: 'Interpreter bridge (one person at a time)',
  bridge_simultaneous: 'Interpreter bridge (simultaneous, if fast enough)',
  captions: 'Live captions only',
};

/** Languages shown as Beta in every picker until a measured eval says otherwise (see docs/INTERPRETER.md). */
export const BETA_NOTE = 'Beta: not yet verified on real calls. Critical details are always read back.';

export interface InterpreterSettings {
  user_id: string;
  enabled: boolean;
  enabled_languages: NonEnglish[];
  default_mode: InterpMode;
  greetings: Partial<Record<InterpLang, string>>;
  bridge_number: string | null;
  retention_days: number;
  training_opt_in: boolean;
  recording_state: string | null;
}

export interface InterpreterTurn {
  id: number;
  session_id: string;
  seq: number;
  speaker: 'caller' | 'staff';
  from_lang: InterpLang;
  to_lang: InterpLang;
  original: string;
  translated: string | null;
  asr_confidence: number | null;
  mt_confidence: number | null;
  action: string;
  reason: string | null;
  emergency: string[];
  added_ms: number | null;
  flags: string[];
  created_at: string;
}

export interface InterpreterSessionRow {
  id: string;
  call_id: string | null;
  vapi_call_id: string | null;
  mode: InterpMode;
  caller_language: InterpLang;
  status: 'pending' | 'active' | 'ended' | 'failed';
  degraded: boolean;
  p50_added_ms: number | null;
  handoff_reason: string | null;
}

const SETTINGS_COLUMNS = 'user_id, enabled, enabled_languages, default_mode, greetings, bridge_number, retention_days, training_opt_in, recording_state';

export const DEFAULT_SETTINGS = (userId: string): InterpreterSettings => ({
  user_id: userId, enabled: false, enabled_languages: ['es'], default_mode: 'assistant', greetings: {}, bridge_number: null,
  retention_days: 90, training_opt_in: false, recording_state: null,
});

export async function loadInterpreterSettings(): Promise<InterpreterSettings> {
  const { data: owner, error: ownerErr } = await supabase.rpc('get_account_owner_id');
  if (ownerErr || typeof owner !== 'string') throw new Error('Could not resolve the account.');
  const { data, error } = await supabase.from('interpreter_settings').select(SETTINGS_COLUMNS).eq('user_id', owner).maybeSingle();
  if (error) throw error;
  return (data as InterpreterSettings | null) ?? DEFAULT_SETTINGS(owner);
}

export async function saveInterpreterSettings(s: InterpreterSettings): Promise<void> {
  const { error } = await supabase.from('interpreter_settings').upsert({ ...s, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw error;
}

export async function loadCallTurns(callId: string): Promise<{ session: InterpreterSessionRow | null; turns: InterpreterTurn[] }> {
  const { data: session, error } = await supabase
    .from('interpreter_sessions')
    .select('id, call_id, vapi_call_id, mode, caller_language, status, degraded, p50_added_ms, handoff_reason')
    .eq('call_id', callId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!session) return { session: null, turns: [] };
  const { data: turns, error: tErr } = await supabase
    .from('interpreter_turns')
    .select('id, session_id, seq, speaker, from_lang, to_lang, original, translated, asr_confidence, mt_confidence, action, reason, emergency, added_ms, flags, created_at')
    .eq('session_id', session.id).order('seq', { ascending: true }).limit(500);
  if (tErr) throw tErr;
  return { session: session as InterpreterSessionRow, turns: (turns ?? []) as InterpreterTurn[] };
}

/** vapi_call_id -> session, for badges on the live board. Refreshes on realtime changes. */
export function useInterpreterSessions(enabled: boolean): Record<string, InterpreterSessionRow> {
  const [map, setMap] = useState<Record<string, InterpreterSessionRow>>({});
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      const { data } = await supabase.from('interpreter_sessions')
        .select('id, call_id, vapi_call_id, mode, caller_language, status, degraded, p50_added_ms, handoff_reason')
        .in('status', ['pending', 'active']).limit(200);
      if (alive) setMap(Object.fromEntries(((data ?? []) as InterpreterSessionRow[]).filter((r) => r.vapi_call_id).map((r) => [r.vapi_call_id as string, r])));
    };
    void load();
    const ch = supabase.channel('interpreter-sessions').on('postgres_changes', { event: '*', schema: 'public', table: 'interpreter_sessions' }, () => void load()).subscribe();
    return () => { alive = false; void supabase.removeChannel(ch); };
  }, [enabled]);
  return map;
}

export interface TranslateResponse {
  translated: string;
  confidence: number;
  latency_ms: number;
  verification: { critical_ok: boolean; missing: string[]; extra: string[]; glossary_misses: string[]; length_ok: boolean };
}

export async function translateLine(text: string, from: InterpLang, to: InterpLang, speaker: 'caller' | 'staff'): Promise<TranslateResponse> {
  const { data, error } = await supabase.functions.invoke('interpreter', { body: { action: 'translate', text, from, to, speaker } });
  if (error || !data || data.error) throw new Error(data?.error ?? 'Translation is unavailable right now.');
  return data as TranslateResponse;
}

export async function startBridge(vapiCallId: string, callerLanguage: InterpLang, mode?: InterpMode): Promise<void> {
  const { data, error } = await supabase.functions.invoke('interpreter', { body: { action: 'start_bridge', vapi_call_id: vapiCallId, caller_language: callerLanguage, mode } });
  if (error || !data?.ok) throw new Error(data?.error ?? 'Could not connect the interpreter.');
}

export async function setSession(sessionId: string, patch: { mode?: InterpMode; caller_language?: InterpLang }): Promise<void> {
  const { data, error } = await supabase.functions.invoke('interpreter', { body: { action: 'set_session', session_id: sessionId, ...patch } });
  if (error || !data?.ok) throw new Error(data?.error ?? 'Could not update the session.');
}
