import { describe, expect, it } from 'vitest';
import { runApproval, type ApprovalDeps, type PendingApproval, type ServerStatus } from './approvalFlow';
import { normalizeExtraction, type VoiceExtraction } from '../../../supabase/functions/_shared/voice-log/extract';

const ex = normalizeExtraction({ transcript: 't', summary: 's', findings: [{ text: 'f', severity: 'info', confidence: 1 }], parts: [], customer_notes: [] }) as VoiceExtraction;
const entry = (): PendingApproval => ({
  draftId: '11111111-1111-4111-8111-111111111111', jobId: 'j', extraction: ex, claimed: false, noteWritten: false,
  createdAt: 0, attempts: 0, nextAttemptAt: 0, lastError: null,
});

interface World { status: ServerStatus; notes: string[]; deps: ApprovalDeps }
interface Faults { status?: ServerStatus; failTransition?: (from: string, to: string) => boolean; note?: 'ok' | 'throw' | 'denied' }

/** In-memory server + job-notes. `faults` can be changed mid-test to simulate the network coming back. */
function world(faults: Faults = {}): { w: World; faults: Faults } {
  const w: World = {
    status: faults.status ?? 'ready', notes: [],
    deps: {
      now: () => 1000,
      save: async () => undefined,
      getStatus: async () => w.status,
      transition: async (_id, from, to) => {
        if (faults.failTransition?.(from, to)) throw new Error('network');
        if (w.status !== from) return false;
        w.status = to as ServerStatus;
        return true;
      },
      addNote: async (_job, text) => {
        if (faults.note === 'throw') throw new Error('network');
        if (faults.note === 'denied') return { success: false, error: 'denied' };
        w.notes.push(text);
        return { success: true };
      },
    },
  };
  return { w, faults };
}

describe('runApproval (offline-safe approval)', () => {
  it('happy path writes exactly one labelled note and finalises', async () => {
    const { w } = world();
    const r = await runApproval(entry(), w.deps);
    expect(r.outcome).toBe('done');
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]).toMatch(/\[ref:11111111\]/);
    expect(w.status).toBe('approved');
  });
  it('offline at claim: retry, nothing written, backoff scheduled', async () => {
    const { w } = world({ failTransition: () => true });
    const r = await runApproval(entry(), w.deps);
    expect(r.outcome).toBe('retry');
    expect(w.notes).toHaveLength(0);
    expect(r.entry.claimed).toBe(false);
    expect(r.entry.nextAttemptAt).toBe(1000 + 15000);
  });
  it('note network error after claim: keeps the claim, later retry writes ONE note', async () => {
    const f = world({ note: 'throw' });
    let r = await runApproval(entry(), f.w.deps);
    expect(r.outcome).toBe('retry');
    expect(r.entry.claimed).toBe(true);
    expect(f.w.status).toBe('approving');
    f.faults.note = 'ok';
    r = await runApproval(r.entry, f.w.deps);
    expect(r.outcome).toBe('done');
    expect(f.w.notes).toHaveLength(1);
  });
  it('finalize fails after the note: retry never duplicates the note', async () => {
    const f = world({ failTransition: (from, to) => from === 'approving' && to === 'approved' });
    let r = await runApproval(entry(), f.w.deps);
    expect(r.outcome).toBe('retry');
    expect(r.entry.noteWritten).toBe(true);
    f.faults.failTransition = undefined;
    r = await runApproval(r.entry, f.w.deps);
    expect(r.outcome).toBe('done');
    expect(f.w.notes).toHaveLength(1);
  });
  it('server rejects the note: claim is released and the error recorded', async () => {
    const { w } = world({ note: 'denied' });
    const r = await runApproval(entry(), w.deps);
    expect(r.outcome).toBe('retry');
    expect(w.status).toBe('ready');
    expect(r.entry.claimed).toBe(false);
    expect(r.entry.lastError).toBe('denied');
  });
  it('approved or discarded on another device is a conflict and writes nothing', async () => {
    for (const status of ['approved', 'discarded', 'missing'] as const) {
      const { w } = world({ status });
      expect((await runApproval(entry(), w.deps)).outcome).toBe('conflict');
      expect(w.notes).toHaveLength(0);
    }
  });
  it('recovers from a crash after the claim (server says approving) with one note', async () => {
    const { w } = world({ status: 'approving' });
    const r = await runApproval(entry(), w.deps);
    expect(r.outcome).toBe('done');
    expect(w.notes).toHaveLength(1);
  });
  it('treats a lost finalize response as done when the server already shows approved', async () => {
    const { w } = world();
    w.deps.transition = async (_id, from) => { w.status = from === 'ready' ? 'approving' : 'approved'; return from === 'ready'; };
    expect((await runApproval(entry(), w.deps)).outcome).toBe('done');
  });
  it('backoff doubles per failed attempt', async () => {
    const { w } = world({ failTransition: () => true });
    let e = entry();
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) { const r = await runApproval(e, w.deps); e = r.entry; waits.push(e.nextAttemptAt - 1000); }
    expect(waits).toEqual([15000, 30000, 60000, 120000]);
  });
});
