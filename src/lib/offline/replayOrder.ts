// src/lib/offline/replayOrder.ts
// Keeps outbox replay in order per job: if one operation cannot be prepared (e.g. its photo
// upload hit a dead zone), later operations for the SAME job wait for the next sync run instead
// of overtaking it. Operations for other jobs are unaffected.

export interface Sequenced {
  seq: number | string;
  job_id?: string | null;
}

const GLOBAL_KEY = '__global__';

export const replayKey = (op: { job_id?: string | null }): string => op.job_id ?? GLOBAL_KEY;

export const bySeq = (a: { seq: number | string }, b: { seq: number | string }): number => {
  const d = Number(a.seq) - Number(b.seq);
  return Number.isNaN(d) ? 0 : d;
};

export async function prepareInOrder<T extends Sequenced>(
  ops: readonly T[],
  prepare: (op: T) => Promise<boolean>,
): Promise<T[]> {
  const blocked = new Set<string>();
  const ready: T[] = [];
  for (const op of [...ops].sort(bySeq)) {
    const key = replayKey(op);
    if (blocked.has(key)) continue;
    if (await prepare(op)) ready.push(op);
    else blocked.add(key);
  }
  return ready;
}
