// Crash-safe, offline-safe approval of a voice-log draft. Pure (all I/O injected) so every
// failure/conflict path is unit-tested. The entry is persisted BEFORE any network call
// (write-ahead) and its progress flags are saved after each irreversible step.
import { buildJobNote, type VoiceExtraction } from '../../../supabase/functions/_shared/voice-log/extract';
import { backoffMs } from './backoff';

export interface PendingApproval {
  draftId: string;
  jobId: string;
  extraction: VoiceExtraction;
  claimed: boolean;      // server row is in 'approving' for us
  noteWritten: boolean;  // job note was written (never write it twice)
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
}
export type ServerStatus = 'ready' | 'approving' | 'approved' | 'discarded' | 'missing';
export type ApprovalOutcome = 'done' | 'retry' | 'conflict';

export interface ApprovalDeps {
  getStatus(id: string): Promise<ServerStatus>;
  transition(id: string, from: string, to: string, extraction?: VoiceExtraction): Promise<boolean>;
  addNote(jobId: string, text: string): Promise<{ success: boolean; error?: string }>;
  save(entry: PendingApproval): Promise<void>;
  now(): number;
}

export async function runApproval(entry: PendingApproval, deps: ApprovalDeps): Promise<{ outcome: ApprovalOutcome; entry: PendingApproval }> {
  let e: PendingApproval = { ...entry };
  const retry = async (msg: string) => {
    const attempts = e.attempts + 1;
    e = { ...e, attempts, lastError: msg, nextAttemptAt: deps.now() + backoffMs(attempts) };
    try { await deps.save(e); } catch { /* keep in-memory result; caller persists */ }
    return { outcome: 'retry' as const, entry: e };
  };
  try {
    if (!e.claimed) {
      if (await deps.transition(e.draftId, 'ready', 'approving', e.extraction)) {
        e = { ...e, claimed: true };
        await deps.save(e);
      } else if ((await deps.getStatus(e.draftId)) === 'approving') {
        e = { ...e, claimed: true }; // our own earlier attempt died after the claim
        await deps.save(e);
      } else {
        return { outcome: 'conflict', entry: e }; // approved/discarded elsewhere, or gone
      }
    }
    if (!e.noteWritten) {
      const res = await deps.addNote(e.jobId, buildJobNote(e.extraction, e.draftId));
      if (!res.success) {
        // Definite failure (server answered): safe to release the claim and retry later.
        if (await deps.transition(e.draftId, 'approving', 'ready')) e = { ...e, claimed: false };
        return await retry(res.error ?? 'note_failed');
      }
      e = { ...e, noteWritten: true };
      await deps.save(e);
    }
    if (!(await deps.transition(e.draftId, 'approving', 'approved'))) {
      if ((await deps.getStatus(e.draftId)) !== 'approved') return await retry('finalize_failed');
    }
    return { outcome: 'done', entry: e };
  } catch (err) {
    // Network/unknown error: flags already persisted reflect exactly what is known.
    return await retry(err instanceof Error ? err.message.slice(0, 80) : 'network');
  }
}
