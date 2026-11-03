import { supabase } from '@/lib/supabase';
import {
  DEFAULT_TUNING, SCENARIOS, normalizeSamples, sanitizeTuning,
  type Scenario, type Tuning,
} from '../../supabase/functions/_shared/voice-studio/logic';

export interface VoiceOption {
  key: string; name: string; accent: string; gender: 'female' | 'male'; tags: string[];
}

// Keys MUST match the CHECK on business_profile.assistant_voice / voice_studio_profiles.voice_key.
export const VOICE_CATALOG: VoiceOption[] = [
  { key: 'sarah-warm-f-us', name: 'Sarah', accent: 'US', gender: 'female', tags: ['Warm'] },
  { key: 'aria-friendly-f-us', name: 'Aria', accent: 'US', gender: 'female', tags: ['Upbeat'] },
  { key: 'maya-calm-f-uk', name: 'Maya', accent: 'UK', gender: 'female', tags: ['Calm'] },
  { key: 'miles-confident-m-us', name: 'Miles', accent: 'US', gender: 'male', tags: ['Confident'] },
  { key: 'jay-easygoing-m-us', name: 'Jay', accent: 'US', gender: 'male', tags: ['Easygoing'] },
  { key: 'oliver-polished-m-uk', name: 'Oliver', accent: 'UK', gender: 'male', tags: ['Polished'] },
];

export interface ScenarioProfile { voiceKey: string; tuning: Tuning }
export interface PreviewResult { url: string; latencyMs: number; costCents: number | null; spoken: string; phone: boolean }

export async function getOwnerId(): Promise<string> {
  const { data, error } = await supabase.rpc('get_account_owner_id');
  if (error || typeof data !== 'string') throw new Error('Could not resolve account.');
  return data;
}

export async function loadProfiles(): Promise<Partial<Record<Scenario, ScenarioProfile>>> {
  const { data, error } = await supabase
    .from('voice_studio_profiles').select('scenario, voice_key, tuning').is('location_id', null);
  if (error) throw new Error('Could not load voice settings.');
  const out: Partial<Record<Scenario, ScenarioProfile>> = {};
  for (const r of data ?? []) {
    if ((SCENARIOS as readonly string[]).includes(r.scenario)) {
      out[r.scenario as Scenario] = { voiceKey: r.voice_key, tuning: sanitizeTuning(r.tuning) };
    }
  }
  return out;
}

export async function saveProfile(scenario: Scenario, voiceKey: string, tuning: Tuning): Promise<void> {
  const clean = sanitizeTuning(tuning);
  const patch = { voice_key: voiceKey, tuning: clean };
  const upd = () => supabase.from('voice_studio_profiles').update(patch)
    .eq('scenario', scenario).is('location_id', null).select('id');

  let { data, error } = await upd();
  if (error) throw new Error('Could not save voice settings.');
  if (!data?.length) {
    const ins = await supabase.from('voice_studio_profiles').insert({ scenario, ...patch });
    if (ins.error) {
      if (ins.error.code !== '23505') throw new Error('Could not save voice settings.');
      ({ data, error } = await upd()); // lost an insert race: update the winner's row
      if (error || !data?.length) throw new Error('Could not save voice settings.');
    }
  }
  if (scenario === 'default') {
    const owner = await getOwnerId();
    const { error: bpErr } = await supabase.from('business_profile').update({ assistant_voice: voiceKey }).eq('user_id', owner);
    if (bpErr) throw new Error('Saved, but could not update the live assistant voice.');
  }
}

async function errorMessage(error: unknown): Promise<string> {
  try {
    const ctx = (error as { context?: Response }).context;
    const j = ctx ? await ctx.json() : null;
    if (j && typeof j.error === 'string') return j.error;
  } catch { /* fall through */ }
  return 'Preview failed. Try again.';
}

function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

/** 8 kHz, 300–3400 Hz band-limit + loudness normalization. Approximates, not equals, a real carrier path. */
export async function toPhoneBandwidth(blob: Blob): Promise<Blob> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 8000)), 8000);
    const src = off.createBufferSource(); src.buffer = decoded;
    const hp = off.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300;
    const lp = off.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3400;
    src.connect(hp); hp.connect(lp); lp.connect(off.destination); src.start();
    const rendered = await off.startRendering();
    return encodeWav(normalizeSamples(rendered.getChannelData(0)), 8000);
  } finally { void ctx.close(); }
}

export async function previewVoice(a: { voiceKey: string; text: string; tuning: Tuning; phone: boolean }): Promise<PreviewResult> {
  const { data, error } = await supabase.functions.invoke('voice-studio-preview', {
    body: { voiceKey: a.voiceKey, text: a.text, tuning: sanitizeTuning(a.tuning) },
  });
  if (error) throw new Error(await errorMessage(error));
  if (!data?.audio_base64) throw new Error('Preview failed. Try again.');
  const bytes = Uint8Array.from(atob(data.audio_base64), (c) => c.charCodeAt(0));
  let blob = new Blob([bytes], { type: data.mime || 'audio/mpeg' });
  if (a.phone) blob = await toPhoneBandwidth(blob);
  return { url: URL.createObjectURL(blob), latencyMs: data.latency_ms ?? 0, costCents: data.est_cost_cents ?? null, spoken: data.spoken_text ?? '', phone: a.phone };
}

export { DEFAULT_TUNING };
