// supabase/functions/_shared/pbx/runtime.ts
// DB + Twilio helpers shared by pbx-voice (Twilio webhooks) and pbx-actions (signed-in users).

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { pickOutboundCallerId } from './logic.ts';
import { twilioApi, twilioDownload } from './twilio.ts';

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;

// Twilio's public sample hold music. Replace it with licensed music in Phone System -> Settings.
export const FALLBACK_HOLD_MUSIC = 'https://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3';
export const TERMINAL = ['completed', 'no_answer', 'busy', 'failed', 'canceled'];

export const hook = (action: string, q: Record<string, string> = {}) =>
  `${Deno.env.get('PBX_WEBHOOK_BASE') ?? ''}?${new URLSearchParams({ action, ...q })}`;
export const clientIdentity = (extensionId: string) => `pbx_${extensionId}`;

export async function loadSettings(a: SupabaseClient, owner: string): Promise<Row> {
  const { data } = await a.from('pbx_settings').select('*').eq('account_owner_id', owner).maybeSingle();
  return {
    timezone: 'America/New_York', recording_mode: 'off', recording_announcement: true,
    recording_retention_days: 365, default_hold_music_url: null,
    voicemail_greeting: 'Please leave a message after the tone.', voicemail_transcribe: true,
    park_timeout_seconds: 120, outbound_country_codes: ['+1'], ...(data ?? {}),
  };
}

export async function lineE164(a: SupabaseClient, lineId: string | null): Promise<string | null> {
  if (!lineId) return null;
  const { data } = await a.from('pbx_lines').select('phone_numbers(phone_number)').eq('id', lineId).maybeSingle();
  const pn = (data as Row | null)?.phone_numbers;
  return (Array.isArray(pn) ? pn[0]?.phone_number : pn?.phone_number) ?? null;
}

/** Caller ID for legs we place on behalf of a call: the line that was dialled, else any usable one. */
export async function callerIdFor(a: SupabaseClient, call: Row, ext?: Row): Promise<string> {
  const viaLine = await lineE164(a, call.line_id);
  if (viaLine) return viaLine;
  if (ext) { const r = await resolveCallerId(a, ext); if (r) return r.e164; }
  return call.from_number ?? '';
}

export async function resolveCallerId(a: SupabaseClient, ext: Row): Promise<{ lineId: string; e164: string } | null> {
  const { data: mem } = await a.from('pbx_line_members').select('line_id, can_dial_out').eq('extension_id', ext.id);
  const ids = (mem ?? []).map((m: Row) => m.line_id);
  if (!ids.length) return null;
  const { data: lines } = await a
    .from('pbx_lines').select('id, allow_outbound, enabled, phone_numbers(phone_number)')
    .in('id', ids).eq('account_owner_id', ext.account_owner_id);
  return pickOutboundCallerId({
    preferredLineId: ext.outbound_line_id ?? null,
    memberships: (mem ?? []).map((m: Row) => ({ lineId: m.line_id, canDialOut: m.can_dial_out })),
    lines: (lines ?? []).map((l: Row) => {
      const pn = Array.isArray(l.phone_numbers) ? l.phone_numbers[0] : l.phone_numbers;
      return { id: l.id, e164: pn?.phone_number ?? '', allowOutbound: l.allow_outbound, enabled: l.enabled };
    }),
  });
}

export interface LegArgs {
  role: 'agent' | 'consult' | 'customer';
  target: { extensionId?: string | null; number?: string | null };
  from: string;
  ringSeconds: number;
  joinAction: 'agent-join' | 'pstn-join';
  round?: number;
}

/** Inserts the leg row, then asks Twilio to dial it. Returns false if Twilio refused. */
export async function createLeg(a: SupabaseClient, call: Row, args: LegArgs): Promise<boolean> {
  const { data: leg, error } = await a.from('pbx_call_legs').insert({
    account_owner_id: call.account_owner_id, call_id: call.id, extension_id: args.target.extensionId ?? null,
    role: args.role, target_number: args.target.number ?? null, status: 'queued', round: args.round ?? 0,
  }).select('id').single();
  if (error || !leg) throw new Error(`leg insert failed: ${error?.message}`);
  const q = { call: call.id, leg: leg.id };
  try {
    const res = await twilioApi('Calls.json', { form: {
      To: args.target.number ?? `client:${clientIdentity(args.target.extensionId as string)}`,
      From: args.from,
      Url: hook(args.joinAction, q), Method: 'POST',
      StatusCallback: hook('leg-status', q), StatusCallbackMethod: 'POST',
      StatusCallbackEvent: 'initiated ringing answered completed',
      Timeout: String(args.ringSeconds),
    } });
    await a.from('pbx_call_legs').update({ call_sid: res.sid }).eq('id', leg.id);
    return true;
  } catch (e) {
    console.error(JSON.stringify({ event: 'pbx_leg_create_failed', error: String(e) }));
    await a.from('pbx_call_legs').update({ status: 'failed', ended_at: new Date().toISOString() }).eq('id', leg.id);
    return false;
  }
}

/** Updates a live call (redirect to new TwiML). Swallows "call already ended". */
export async function twilioApiSafe(path: string, form: Record<string, string>): Promise<void> {
  try { await twilioApi(path, { form }); } catch (e) { console.error(JSON.stringify({ event: 'pbx_call_update_failed', error: String(e) })); }
}
export const endLeg = (callSid: string, status: 'completed' | 'canceled') =>
  twilioApi(`Calls/${callSid}.json`, { form: { Status: status } });

/** Stops every ringing / live leg of a call (optionally keeping one). */
export async function cancelLegs(a: SupabaseClient, callId: string, exceptLegId?: string): Promise<void> {
  const { data } = await a.from('pbx_call_legs').select('id, call_sid, status')
    .eq('call_id', callId).in('status', ['queued', 'ringing', 'in_progress']);
  for (const l of (data ?? []) as Row[]) {
    if (l.id === exceptLegId) continue;
    if (l.call_sid) { try { await endLeg(l.call_sid, l.status === 'in_progress' ? 'completed' : 'canceled'); } catch { /* already gone */ } }
    await a.from('pbx_call_legs').update({
      status: l.status === 'in_progress' ? 'completed' : 'canceled', ended_at: new Date().toISOString(),
    }).eq('id', l.id).in('status', ['queued', 'ringing', 'in_progress']);
  }
}

export async function confSid(a: SupabaseClient, call: Row): Promise<string | null> {
  if (call.conference_sid) return call.conference_sid;
  const r = await twilioApi(`Conferences.json?${new URLSearchParams({ FriendlyName: call.conference_name, Status: 'in-progress' })}`);
  const sid: string | null = r?.conferences?.[0]?.sid ?? null;
  if (sid) await a.from('pbx_calls').update({ conference_sid: sid }).eq('id', call.id);
  return sid;
}

export const setHold = (cs: string, callSid: string, hold: boolean, music: string) =>
  twilioApi(`Conferences/${cs}/Participants/${callSid}.json`, {
    form: hold ? { Hold: 'true', HoldUrl: music, HoldMethod: 'GET' } : { Hold: 'false' },
  });

export const setEndOnExit = (cs: string, callSid: string, v: boolean) =>
  twilioApi(`Conferences/${cs}/Participants/${callSid}.json`, { form: { EndConferenceOnExit: String(v) } });

/** Moves a Twilio-hosted recording into the private bucket, then (by default) deletes the Twilio copy. */
export async function storeMedia(a: SupabaseClient, path: string, twilioRecordingUrl: string, recordingSid: string): Promise<number> {
  const bytes = await twilioDownload(twilioRecordingUrl);
  const { error } = await a.storage.from('pbx-media').upload(path, bytes, { contentType: 'audio/mpeg', upsert: false });
  if (error && !/exists|duplicate/i.test(error.message)) throw new Error(`storage upload failed: ${error.message}`);
  if (Deno.env.get('PBX_KEEP_TWILIO_RECORDINGS') !== 'true') {
    try { await twilioApi(`Recordings/${recordingSid}.json`, { method: 'DELETE' }); } catch { /* retention on Twilio side */ }
  }
  return bytes.length;
}
