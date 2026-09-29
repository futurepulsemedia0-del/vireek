/**
 * Live Multimodal Technician Copilot - client domain logic.
 *
 * A technician points the phone at a unit and asks a question. Each "turn"
 * sends up to 3 downscaled camera frames + a short 16 kHz WAV clip + the typed
 * question to the `live-copilot` Edge Function, which returns nameplate OCR,
 * sound analysis, ranked causes, test steps, safety warnings, parts, manual
 * references, history insights and a human-expert escalation recommendation.
 *
 * Human hand-off reuses Expert Assist (createExpertAssistRequest + photo/audio
 * messages) - no second escalation system to maintain.
 *
 * Server counterpart: supabase/functions/live-copilot (index.ts, normalize.ts).
 * Keep the types below in sync with normalize.ts.
 */

import { supabase } from '@/lib/supabase';
import { createExpertAssistRequest, sendAudioMessage, sendPhotoMessage } from '@/lib/expertAssist';

export type LiveSeverity = 'low' | 'medium' | 'high' | 'emergency';
export type LiveNecessity = 'likely' | 'possible' | 'if_confirmed';
export type LiveSoundClass =
  | 'none_detected' | 'normal' | 'grinding' | 'squealing' | 'rattling'
  | 'buzzing_humming' | 'clicking' | 'hissing' | 'banging' | 'gurgling' | 'unclear';

export interface LiveNameplate {
  legible: boolean;
  brand: string;
  model: string;
  serial: string;
  manufacture_date: string;
  ratings: string;
  refrigerant: string;
}

export interface LivePerception {
  transcript: string;
  nameplate: LiveNameplate;
  sound: { class: LiveSoundClass; description: string; anomalies: string[] };
  visual_findings: string[];
  error_codes: string[];
  capture_quality: { issues: string[]; retake_hint: string };
}

export interface LiveCause { cause: string; likelihood: number; reasoning: string; evidence: string[] }
export interface LiveStep { step: string; tool_needed: string; expected_result: string }
export interface LivePart { name: string; quantity: number; necessity: LiveNecessity }
export interface LiveManualRef { id: string; title: string; why: string }

export interface LiveResult {
  headline: string;
  spoken_answer: string;
  probable_causes: LiveCause[];
  test_steps: LiveStep[];
  safety_warnings: string[];
  parts_needed: LivePart[];
  history_insights: string[];
  manual_refs: LiveManualRef[];
  next_capture: string;
  missing_info: string[];
  severity: LiveSeverity;
  confidence: number;
  escalate: { recommended: boolean; reason: string };
  warnings: string[];
}

export interface LiveTurnResponse {
  session_id: string | null;
  seq: number;
  perception: LivePerception;
  result: LiveResult;
  equipment: { id: string | null; label: string | null; matched_by: 'serial' | 'model' | null; auto_matched: boolean };
  model: string;
  latency_ms: number;
  inputs: { frames: number; audio: boolean; manuals: number };
}

export const LIVE_LIMITS = {
  frames: 3,
  audioSeconds: 12,
  questionChars: 1500,
  frameMaxEdge: 1280,
  jpegQuality: 0.72,
} as const;

export const SOUND_LABELS: Record<LiveSoundClass, string> = {
  none_detected: 'No machine sound',
  normal: 'Normal operation',
  grinding: 'Grinding',
  squealing: 'Squealing',
  rattling: 'Rattling',
  buzzing_humming: 'Buzzing / humming',
  clicking: 'Clicking',
  hissing: 'Hissing',
  banging: 'Banging',
  gurgling: 'Gurgling',
  unclear: 'Unclear',
};

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

/** Downscales the current video frame to a JPEG (<= 1280 px longest edge, ~150-300 KB). */
export async function frameToBlob(video: HTMLVideoElement): Promise<Blob | null> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const scale = Math.min(1, LIVE_LIMITS.frameMaxEdge / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', LIVE_LIMITS.jpegQuality));
}

async function uploadLiveMedia(userId: string, blob: Blob, ext: string): Promise<string> {
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage
    .from('live-copilot-media')
    .upload(path, blob, { upsert: false, contentType: blob.type || undefined });
  if (error) throw error;
  return path;
}

/** One capture-and-ask turn. Uploads media to the caller's own folder, then invokes the Edge Function. */
export async function analyzeLiveTurn(input: {
  userId: string;
  sessionId: string | null;
  jobId: string | null;
  equipmentId: string | null;
  question: string;
  frames: Blob[];
  audio: Blob | null;
}): Promise<LiveTurnResponse> {
  const [framePaths, audioPath] = await Promise.all([
    Promise.all(input.frames.slice(0, LIVE_LIMITS.frames).map((f) => uploadLiveMedia(input.userId, f, 'jpg'))),
    input.audio ? uploadLiveMedia(input.userId, input.audio, 'wav') : Promise.resolve(null),
  ]);

  const { data, error } = await supabase.functions.invoke('live-copilot', {
    body: {
      sessionId: input.sessionId,
      jobId: input.jobId,
      equipmentId: input.equipmentId,
      question: input.question.trim().slice(0, LIVE_LIMITS.questionChars),
      framePaths,
      audioPath,
    },
  });
  if (error) {
    throw new Error(await functionErrorMessage(error, 'Could not reach the Live Copilot. Check your connection and try again.'));
  }
  if (data?.error) throw new Error(String(data.error));
  return data as LiveTurnResponse;
}

export async function finishLiveSession(
  sessionId: string,
  status: 'completed' | 'escalated',
  requestId?: string | null,
  note?: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('finish_live_copilot_session', {
    p_session_id: sessionId,
    p_status: status,
    p_request_id: requestId ?? null,
    p_note: note ?? null,
  });
  if (error) throw error;
}

/**
 * Hands the live session to a human expert via Expert Assist. The latest frame
 * and the ORIGINAL recording (WebM/MP4 - what expert-assist-media accepts) are
 * attached to the thread best-effort; the summary note is the first message.
 */
export async function escalateLiveSession(input: {
  userId: string;
  sessionId: string | null;
  jobId: string | null;
  turn: LiveTurnResponse;
  frame: Blob | null;
  rawAudio: Blob | null;
}): Promise<string> {
  const { turn } = input;
  const top = turn.result.probable_causes[0];
  const np = turn.perception.nameplate;
  const note = [
    `Live Copilot escalation - ${turn.result.severity.toUpperCase()}, confidence ${Math.round(turn.result.confidence * 100)}%.`,
    turn.result.headline,
    top ? `Top suspect: ${top.cause} (${Math.round(top.likelihood * 100)}%).` : '',
    np.legible ? `Nameplate: ${[np.brand, np.model, np.serial ? `SN ${np.serial}` : ''].filter(Boolean).join(' ')}.` : '',
    turn.perception.sound.class !== 'none_detected' ? `Sound: ${SOUND_LABELS[turn.perception.sound.class]}. ${turn.perception.sound.description}` : '',
    turn.perception.error_codes.length ? `Error codes: ${turn.perception.error_codes.join(', ')}.` : '',
    turn.perception.transcript ? `Technician said: "${turn.perception.transcript}"` : '',
    turn.result.escalate.reason ? `Why escalate: ${turn.result.escalate.reason}` : '',
  ].filter(Boolean).join('\n').slice(0, 1500);

  const snapshot: Record<string, unknown> = {
    source: 'live_copilot',
    live_session_id: input.sessionId,
    equipment: turn.equipment.label,
    likely_diagnosis: turn.result.probable_causes.slice(0, 3),
    safety_warnings: turn.result.safety_warnings,
    perception: turn.perception,
  };

  let requestId: string;
  try {
    requestId = await createExpertAssistRequest(input.jobId, turn.perception.error_codes[0] ?? null, snapshot, note);
  } catch (err) {
    const msg = err instanceof Error ? err.message : (err as { message?: string } | null)?.message ?? '';
    if (msg.includes('not_a_team_member')) {
      throw new Error('Expert escalation is available to team members. Ask the account owner to add you as a technician.');
    }
    throw new Error('Could not reach an expert right now. Try again in a moment.');
  }

  // Attachments are best-effort - the note above already carries the essentials.
  const attachments: Promise<unknown>[] = [];
  if (input.frame) {
    attachments.push(sendPhotoMessage(input.userId, requestId, new File([input.frame], 'live-frame.jpg', { type: 'image/jpeg' })));
  }
  if (input.rawAudio) {
    const clean = new Blob([input.rawAudio], { type: input.rawAudio.type.split(';')[0] || 'audio/webm' });
    attachments.push(sendAudioMessage(input.userId, requestId, clean));
  }
  await Promise.allSettled(attachments);
  if (input.sessionId) await finishLiveSession(input.sessionId, 'escalated', requestId, note).catch(() => undefined);

  return requestId;
}

// ---------------------------------------------------------------------------
// Hands-free voice replies (browser speech synthesis - no extra cost or vendor)
// ---------------------------------------------------------------------------

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function speak(text: string): void {
  if (!speechSupported() || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = 1;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (speechSupported()) window.speechSynthesis.cancel();
}
