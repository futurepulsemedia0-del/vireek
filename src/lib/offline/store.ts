// src/lib/offline/store.ts
// Device copy of the technician's jobs + briefs (the "offline bundle"). Read by the UI,
// replaced atomically by the sync engine.

import type { JobBrief, TechnicianJob } from '@/lib/technicianOS';
import { idb, getMeta, notifyData, transact } from './db';

export interface BundleEntry {
  job: TechnicianJob;
  brief: JobBrief | null;
}

export interface Bundle {
  error?: string;
  /** Either { job, brief } entries or plain jobs (then briefs may come in `briefs`, keyed by job id). */
  jobs: Array<BundleEntry | TechnicianJob>;
  briefs?: Record<string, JobBrief | null>;
}

interface BriefRecord {
  job_id: string;
  brief: JobBrief | null;
  cached_at: number;
}

function toEntry(item: BundleEntry | TechnicianJob, briefs: Bundle['briefs']): BundleEntry | null {
  const job = 'job' in item ? item.job : item;
  if (!job || typeof job.id !== 'string') return null;
  const brief = 'job' in item ? item.brief : briefs?.[job.id] ?? null;
  return { job, brief: brief ?? null };
}

/** Replaces jobs + briefs in ONE transaction, so a crash can never leave a half-updated device. */
export async function replaceBundle(bundle: Pick<Bundle, 'jobs' | 'briefs'>): Promise<void> {
  const entries = (bundle.jobs ?? [])
    .map((item) => toEntry(item, bundle.briefs))
    .filter((e): e is BundleEntry => e !== null);
  const now = Date.now();
  await transact(['jobs', 'briefs', 'meta'], 'readwrite', (s) => {
    s('jobs').clear();
    s('briefs').clear();
    for (const e of entries) {
      s('jobs').put(e.job);
      if (e.brief) s('briefs').put({ job_id: e.job.id, brief: e.brief, cached_at: now } satisfies BriefRecord);
    }
    return s('meta').put({ key: 'bundle_at', value: now });
  });
  notifyData();
}

export async function getLocalJobs<T = TechnicianJob>(): Promise<T[]> {
  const jobs = await idb.getAll<T>('jobs');
  const when = (j: T) => (j as { scheduled_datetime?: string | null }).scheduled_datetime ?? '9999';
  return jobs.sort((a, b) => when(a).localeCompare(when(b)));
}

export async function getCachedBrief<T = JobBrief>(jobId: string): Promise<T | null> {
  const rec = await idb.get<BriefRecord>('briefs', jobId);
  return (rec?.brief as T | null | undefined) ?? null;
}

/** Stores a brief fetched on demand (e.g. a job that was not in the bundle). */
export async function cacheBrief(jobId: string, brief: BundleEntry['brief']): Promise<void> {
  await idb.put('briefs', { job_id: jobId, brief, cached_at: Date.now() } satisfies BriefRecord);
}

/** True once a bundle has been downloaded at least once on this device. */
export async function hasBundle(): Promise<boolean> {
  return (await getMeta<number>('bundle_at')) != null;
}
