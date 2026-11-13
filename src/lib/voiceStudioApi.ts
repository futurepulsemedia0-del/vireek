/**
 * Voice Studio - client API (consent, live-voice sync, test call, blind votes, experiments).
 *
 * Edge functions: voice-consent, voice-studio-sync, voice-studio-test-call, voice-experiment.
 * Tables read/written directly (RLS-protected): voice_clone_consents, voice_ab_votes, voice_experiments.
 */

import { supabase } from '@/lib/supabase';
import type { Tuning } from '../../supabase/functions/_shared/voice-studio/logic';

/** Invoke an edge function and surface its `{ error }` message as a thrown Error. */
async function call<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let msg = 'Something went wrong. Please try again.';
    try {
      const j = await (error as { context?: Response }).context?.json();
      if (j?.error) msg = j.error;
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }
  return data as T;
}

/* -------------------------------------------------------------------------- */
/* Voice clone consent                                                         */
/* -------------------------------------------------------------------------- */

export type ConsentRelationship = 'self' | 'employee_written_consent';
export type ConsentStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

export interface ConsentRow {
  id: string;
  voice_owner_name: string;
  relationship: ConsentRelationship;
  status: ConsentStatus;
  liveness_phrase: string;
  failure_reason: string | null;
  approved_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface StartConsentInput {
  voiceOwnerName: string;
  relationship: ConsentRelationship;
  attested: boolean;
}

export interface StartConsentResult {
  consentId: string;
  phrase: string;
  consentText: string;
  expiresInMinutes: number;
}

const CONSENT_COLUMNS =
  'id,voice_owner_name,relationship,status,liveness_phrase,failure_reason,approved_at,revoked_at,created_at';

/** Newest consent record of the account, or null when none exists. */
export async function latestConsent(): Promise<ConsentRow | null> {
  const { data, error } = await supabase
    .from('voice_clone_consents')
    .select(CONSENT_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error('Could not load voice cloning consent.');
  return (data ?? null) as ConsentRow | null;
}

export const startConsent = (input: StartConsentInput) =>
  call<StartConsentResult>('voice-consent', {
    action: 'start',
    voiceOwnerName: input.voiceOwnerName,
    relationship: input.relationship,
    attested: input.attested,
  });

export const revokeConsent = (consentId: string) =>
  call<{ ok: true }>('voice-consent', { action: 'revoke', consentId });

/* -------------------------------------------------------------------------- */
/* Live voice sync + test call                                                 */
/* -------------------------------------------------------------------------- */

export interface VoiceSnapshot {
  voiceId?: string;
  [key: string]: unknown;
}

export interface SyncResult {
  /** Present (true) when nothing was changed - a preview of the change. */
  dryRun?: boolean;
  current?: VoiceSnapshot | null;
  proposed?: VoiceSnapshot | null;
  /** Present (true) after the live assistant was updated. */
  applied?: boolean;
  /** True when the live assistant was re-read and matches what was applied. */
  verified?: boolean;
  firstMessageUnchanged?: boolean;
}

/** apply=false: dry run (preview). apply=true: update the live assistant. useClone: use the consented cloned voice. */
export const syncVoice = (apply: boolean, useClone = false) =>
  call<SyncResult>('voice-studio-sync', { apply, useClone });

/** Calls the owner's own escalation phone with the chosen voice. */
export const sendTestCall = (voiceKey: string, tuning: Tuning) =>
  call<{ ok: true }>('voice-studio-test-call', { voiceKey, tuning });

/* -------------------------------------------------------------------------- */
/* Blind A/B votes                                                             */
/* -------------------------------------------------------------------------- */

export async function castVote(sessionId: string, voiceKey: string): Promise<void> {
  const { error } = await supabase.from('voice_ab_votes').insert({ session_id: sessionId, voice_key: voiceKey });
  if (error) {
    if (error.code === '23505') throw new Error('You already voted in this session.');
    if (error.code === '42501') throw new Error("You don't have permission to vote.");
    throw new Error('Could not save your vote.');
  }
}

export async function sessionVotes(sessionId: string): Promise<{ voice_key: string }[]> {
  const { data, error } = await supabase.from('voice_ab_votes').select('voice_key').eq('session_id', sessionId);
  if (error) throw new Error('Could not load the votes.');
  return (data ?? []) as { voice_key: string }[];
}

/* -------------------------------------------------------------------------- */
/* Voice experiments                                                           */
/* -------------------------------------------------------------------------- */

export interface ExperimentRow {
  id: string;
  name: string;
  status: 'draft' | 'running' | 'stopped' | 'completed';
  stop_reason: string | null;
  created_at: string;
}

export interface ExperimentReport {
  name: string;
  status: string;
  minPerArm: number;
  decision: { status: 'insufficient_data' | 'no_difference' | 'winner' | 'stop_guardrail'; arm?: string };
  arms: {
    key: string;
    voiceKey: string;
    calls: number;
    bookings: number;
    hangups: number;
    bookingRate: number;
    hangupRate: number;
  }[];
}

export async function listExperiments(): Promise<ExperimentRow[]> {
  const { data, error } = await supabase
    .from('voice_experiments')
    .select('id,name,status,stop_reason,created_at')
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw new Error('Could not load experiments.');
  return (data ?? []) as ExperimentRow[];
}

export const createExperiment = (name: string, voiceKeys: string[], minPerArm: number) =>
  call<{ id: string }>('voice-experiment', {
    action: 'create',
    name,
    minPerArm,
    arms: voiceKeys.map((voiceKey) => ({ voiceKey })),
  });

export const startExperiment = (id: string) => call<{ ok: true }>('voice-experiment', { action: 'start', id });
export const stopExperiment = (id: string) => call<{ ok: true }>('voice-experiment', { action: 'stop', id });
export const experimentReport = (id: string) => call<ExperimentReport>('voice-experiment', { action: 'report', id });
