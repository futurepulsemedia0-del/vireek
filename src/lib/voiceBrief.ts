// src/lib/voiceBrief.ts — client API for the audio Morning Brief and phone enrolment.
import { supabase } from '@/lib/supabase';

export type VoiceLang = 'en' | 'es' | 'fr';
export interface VoicePrefs {
  brief_enabled: boolean;
  send_hour: number;
  quiet_start: number;
  quiet_end: number;
  skip_when_quiet: boolean;
  language: VoiceLang;
  voice_choice: 'sarah' | 'custom';
  speed: number;
  channel_push: boolean;
  channel_whatsapp: boolean;
  channel_email: boolean;
  channel_in_app: boolean;
  whatsapp_number: string | null;
  daily_cost_cap_cents: number;
}
export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  brief_enabled: false, send_hour: 7, quiet_start: 21, quiet_end: 7, skip_when_quiet: true, language: 'en', voice_choice: 'sarah',
  speed: 1, channel_push: true, channel_whatsapp: false, channel_email: false, channel_in_app: true, whatsapp_number: null, daily_cost_cap_cents: 50,
};
export interface EvidenceItem { key: string; label: string; value: string | number; href: string }
export interface BriefView {
  id: string; date: string; status: string; language: string; voice: string; script: string | null; wordCount: number | null;
  evidence: EvidenceItem[]; audioSeconds: number | null; costCents: number; cacheHit: boolean; delivered: Record<string, { ok: boolean; detail?: string }>;
}
export interface PhoneNumber { id: string; masked: string; verified: boolean; hasPin: boolean; locked: boolean }

const E164 = /^\+[1-9][0-9]{7,14}$/;
export const isE164 = (s: string) => E164.test(s);

export async function loadVoicePrefs(userId: string): Promise<VoicePrefs | null> {
  const { data, error } = await supabase.from('voice_preferences').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data ? ({ ...DEFAULT_VOICE_PREFS, ...data } as VoicePrefs) : null;
}

export async function saveVoicePrefs(userId: string, ownerId: string, p: VoicePrefs): Promise<void> {
  const { speed, ...rest } = p;
  const row = { ...rest, speed: Math.min(1.2, Math.max(0.7, speed)), whatsapp_number: p.whatsapp_number?.trim() || null };
  const existing = await supabase.from('voice_preferences').select('user_id').eq('user_id', userId).maybeSingle();
  const { error } = existing.data
    ? await supabase.from('voice_preferences').update({ ...row, updated_at: new Date().toISOString() }).eq('user_id', userId)
    : await supabase.from('voice_preferences').insert({ ...row, user_id: userId, account_owner_id: ownerId });
  if (error) throw error;
}

async function call<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let msg = 'Something went wrong. Please try again.';
    try { const j = await (error as { context?: Response }).context?.json(); if (j?.error) msg = j.error; } catch { /* keep default */ }
    throw new Error(msg);
  }
  return data as T;
}

export const fetchLatestBrief = () => call<{ brief: BriefView | null; audioUrl: string | null }>('voice-brief', { mode: 'get' });
export const previewBrief = () => call<{ brief: BriefView | null; audioUrl: string | null }>('voice-brief', { mode: 'preview' });
export const playSample = (voice_choice: string, language: string) =>
  call<{ audioUrl: string; transcript: string; voice: string }>('voice-brief', { mode: 'sample', voice_choice, language });

export const phoneStatus = () => call<{ numbers: PhoneNumber[] }>('voice-account', { action: 'status' });
export const sendPhoneCode = (phone: string) => call<{ ok: true }>('voice-account', { action: 'send_code', phone });
export const enrollPhone = (phone: string, code: string, pin: string) => call<{ ok: true; masked: string }>('voice-account', { action: 'enroll', phone, code, pin });
export const removePhone = (id: string) => call<{ ok: true }>('voice-account', { action: 'remove', id });

/** Which word is being spoken, estimated from playback position (the audio has no word timestamps). */
export function activeWordIndex(wordCount: number, currentTime: number, duration: number): number {
  if (!wordCount || !duration || duration <= 0) return -1;
  return Math.min(wordCount - 1, Math.max(0, Math.floor((currentTime / duration) * wordCount)));
}
