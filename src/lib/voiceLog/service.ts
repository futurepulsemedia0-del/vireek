import { supabase } from '@/lib/supabase';
import { addJobNote } from '@/lib/technicianOS';
import { AUDIO_EXT_RE, expectedAudioPath, type VoiceExtraction, type VoiceLang } from '../../../supabase/functions/_shared/voice-log/extract';
import { runApproval, type ApprovalDeps, type PendingApproval, type ServerStatus } from './approvalFlow';
import {
  backoffMs, cacheDrafts, getApproval, getCachedDrafts, getRecording, listApprovals, listRecordings, putApproval, putRecording,
  removeApproval, removeCachedDraft, removeRecording, type QueuedRecording,
} from './queue';
import type { VoiceDraft } from './types';

export type { VoiceDraft } from './types';
export const MAX_RECORDING_SECONDS = 120;
const BUCKET = 'field-captures';
const MAX_ATTEMPTS = 6;
const CONSENT_KEY = 'vireek.voiceLog.consent.v1';

export function hasConsent(): boolean {
  try { return localStorage.getItem(CONSENT_KEY) !== null; } catch { return false; }
}
export function giveConsent(): void {
  try { localStorage.setItem(CONSENT_KEY, new Date().toISOString()); } catch { /* asked again next time */ }
}

export async function enqueueRecording(jobId: string, blob: Blob, ext: string, language: VoiceLang): Promise<QueuedRecording> {
  const cleanExt = ext.toLowerCase();
  if (!AUDIO_EXT_RE.test(cleanExt)) throw new Error('unsupported_audio_format');
  const rec: QueuedRecording = {
    id: crypto.randomUUID(), jobId, ext: cleanExt, language, blob, createdAt: Date.now(),
    attempts: 0, nextAttemptAt: 0, state: 'waiting', lastError: null,
  };
  await putRecording(rec);
  return rec;
}

const statusOf = (e: unknown): number | null => {
  const s = (e as { context?: { status?: number } } | null)?.context?.status;
  return typeof s === 'number' ? s : null;
};
const isAlreadyExists = (e: { message?: string; statusCode?: string | number } | null): boolean =>
  !!e && (String(e.statusCode) === '409' || /already exists|duplicate/i.test(e.message ?? ''));

const inFlight = new Set<string>();

/** Upload + extract one queued recording. Never throws; records the outcome on the item. */
export async function processRecording(id: string, opts: { force?: boolean } = {}): Promise<'done' | 'retry' | 'failed' | 'skipped'> {
  if (inFlight.has(`r:${id}`)) return 'skipped';
  inFlight.add(`r:${id}`);
  try {
    const rec = await getRecording(id);
    if (!rec) return 'skipped';
    if (!opts.force && (rec.state === 'failed' || rec.nextAttemptAt > Date.now())) return 'skipped';

    const { data: sess } = await supabase.auth.getSession();
    const userId = sess.session?.user.id;
    if (!userId) return 'retry';

    const fail = async (message: string, permanent: boolean) => {
      const attempts = rec.attempts + 1;
      const dead = permanent || attempts >= MAX_ATTEMPTS;
      await putRecording({ ...rec, attempts, lastError: message, state: dead ? 'failed' : 'waiting', nextAttemptAt: dead ? 0 : Date.now() + backoffMs(attempts) });
      return dead ? 'failed' as const : 'retry' as const;
    };

    await putRecording({ ...rec, state: 'uploading', lastError: null });
    const path = expectedAudioPath(userId, rec.jobId, rec.id, rec.ext);
    const up = await supabase.storage.from(BUCKET).upload(path, rec.blob, { contentType: rec.blob.type || undefined, upsert: false });
    if (up.error && !isAlreadyExists(up.error as { message?: string; statusCode?: string })) return await fail('upload_failed', false);

    await putRecording({ ...rec, state: 'processing', lastError: null });
    const { error } = await supabase.functions.invoke('voice-log-extract', {
      body: { draftId: rec.id, jobId: rec.jobId, ext: rec.ext, language: rec.language, consent: true },
    });
    if (error) {
      const status = statusOf(error);
      const permanent = status !== null && status >= 400 && status < 500 && status !== 429 && status !== 408;
      return await fail(status ? `http_${status}` : 'network', permanent);
    }
    await removeRecording(rec.id);
    return 'done';
  } catch {
    return 'retry';
  } finally {
    inFlight.delete(`r:${id}`);
  }
}

export async function processQueue(jobId: string): Promise<number> {
  let done = 0;
  for (const r of await listRecordings(jobId)) if ((await processRecording(r.id)) === 'done') done++;
  return done;
}

export const listQueued = listRecordings;
export const discardQueued = removeRecording;
export const listPendingApprovals = listApprovals;

/** Online: fetch + cache. Offline or failing: serve the cache. Drafts with a local pending approval are hidden. */
export async function loadReadyDrafts(jobId: string): Promise<VoiceDraft[]> {
  let drafts: VoiceDraft[] | null = null;
  if (navigator.onLine) {
    const { data, error } = await supabase.from('voice_log_drafts')
      .select('id, status, extraction, needs_review, transcript, created_at')
      .eq('job_id', jobId).eq('status', 'ready').order('created_at', { ascending: false }).limit(20);
    if (!error) { drafts = (data ?? []) as VoiceDraft[]; void cacheDrafts(jobId, drafts).catch(() => undefined); }
  }
  if (!drafts) drafts = await getCachedDrafts(jobId).catch(() => []);
  const pending = new Set((await listApprovals(jobId).catch(() => [])).map((a) => a.draftId));
  return drafts.filter((d) => !pending.has(d.id));
}

async function serverStatus(id: string): Promise<ServerStatus> {
  const { data, error } = await supabase.from('voice_log_drafts').select('status').eq('id', id).maybeSingle();
  if (error) throw error;
  return ((data as { status?: ServerStatus } | null)?.status ?? 'missing') as ServerStatus;
}
async function transition(id: string, from: string, to: string, extraction?: VoiceExtraction): Promise<boolean> {
  const { data, error } = await supabase.rpc('transition_voice_log_draft', { p_id: id, p_from: from, p_to: to, p_extraction: extraction ?? null });
  if (error) throw error;
  return data === true;
}
const approvalDeps: ApprovalDeps = {
  getStatus: serverStatus,
  transition,
  addNote: (jobId, text) => addJobNote(jobId, text),
  save: putApproval,
  now: () => Date.now(),
};

export type SubmitResult = 'done' | 'queued' | 'conflict';

/** Process one stored approval. Removes it only when finished (done/conflict). */
export async function processApproval(draftId: string, opts: { force?: boolean } = {}): Promise<SubmitResult> {
  if (inFlight.has(`a:${draftId}`)) return 'queued';
  inFlight.add(`a:${draftId}`);
  try {
    const entry = await getApproval(draftId);
    if (!entry) return 'done';
    if (!opts.force && entry.nextAttemptAt > Date.now()) return 'queued';
    const { outcome, entry: next } = await runApproval(entry, approvalDeps);
    if (outcome === 'retry') { await putApproval(next); return 'queued'; }
    await removeApproval(draftId);
    await removeCachedDraft(draftId).catch(() => undefined);
    return outcome;
  } finally {
    inFlight.delete(`a:${draftId}`);
  }
}

/** Technician approval. Saved on-device FIRST, so it is never lost; synced as soon as possible. */
export async function submitApproval(jobId: string, draftId: string, edited: VoiceExtraction): Promise<SubmitResult> {
  const entry: PendingApproval = {
    draftId, jobId, extraction: edited, claimed: false, noteWritten: false,
    createdAt: Date.now(), attempts: 0, nextAttemptAt: 0, lastError: null,
  };
  if (!(await getApproval(draftId))) await putApproval(entry);
  return navigator.onLine ? processApproval(draftId, { force: true }) : 'queued';
}

export async function processApprovals(jobId: string): Promise<number> {
  let done = 0;
  for (const a of await listApprovals(jobId)) if ((await processApproval(a.draftId)) === 'done') done++;
  return done;
}

export async function discardDraft(draftId: string): Promise<boolean> {
  const ok = await transition(draftId, 'ready', 'discarded');
  await removeCachedDraft(draftId).catch(() => undefined);
  return ok;
}

/** Approved logs of a job (used by invoice assist). RLS limits this to the caller's own logs. */
export async function fetchApprovedExtractions(jobId: string): Promise<VoiceExtraction[]> {
  const { data, error } = await supabase.from('voice_log_drafts').select('extraction').eq('job_id', jobId).eq('status', 'approved');
  if (error) throw error;
  return ((data ?? []) as { extraction: VoiceExtraction }[]).map((r) => r.extraction);
}
