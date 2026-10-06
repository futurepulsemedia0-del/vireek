// src/lib/offline/fieldApi.ts
// Local-first replacements for the online calls in technicianOS.ts. Reads come from the
// device (instant, works with no signal); writes go to the outbox and sync later.
// Owners / admins who open the technician screens have no offline identity: they keep the
// original online behaviour.

import {
  addJobNote, advanceJobStatus, fetchJobBrief, fetchTodayJobs, setSafetyFlag,
  type JobBrief, type JobStatus, type TechnicianJob,
} from '@/lib/technicianOS';
import { getLastKnownFix } from './capture';
import { getCachedIdentity } from './identity';
import { enqueue } from './outbox';
import { cacheBrief, getCachedBrief, getLocalJobs, hasBundle, type BundleEntry } from './store';

export async function loadToday(): Promise<TechnicianJob[]> {
  if (!getCachedIdentity()) return fetchTodayJobs();
  const local = await getLocalJobs<TechnicianJob>().catch(() => [] as TechnicianJob[]);
  if (local.length > 0 || !navigator.onLine || (await hasBundle().catch(() => false))) return local;
  // First launch with signal but the bundle has not arrived yet: ask the server directly.
  return fetchTodayJobs().catch(() => local);
}

export async function loadBrief(jobId: string): Promise<JobBrief> {
  if (!getCachedIdentity()) return fetchJobBrief(jobId);
  const cached = await getCachedBrief<JobBrief>(jobId).catch(() => null);
  if (cached && !cached.error) return cached;
  if (navigator.onLine) {
    try {
      const fresh = await fetchJobBrief(jobId);
      if (fresh.error) return fresh;
      await cacheBrief(jobId, fresh as unknown as BundleEntry['brief']);
      return (await getCachedBrief<JobBrief>(jobId)) ?? fresh;
    } catch {
      /* fall through to whatever is on the device */
    }
  }
  return cached ?? ({ error: 'not_found' } as JobBrief);
}

export async function advanceStatusLocal(jobId: string, status: JobStatus, note?: string): Promise<void> {
  if (!getCachedIdentity()) {
    await advanceJobStatus(jobId, status, note);
    return;
  }
  const fix = getLastKnownFix();
  await enqueue('status', jobId, { status, note: note ?? null, lat: fix?.lat ?? null, lng: fix?.lng ?? null });
}

export async function setSafetyLocal(jobId: string, flag: boolean, note: string | null): Promise<void> {
  if (!getCachedIdentity()) {
    await setSafetyFlag(jobId, flag, note ?? undefined);
    return;
  }
  await enqueue('safety_flag', jobId, { flag, note });
}

export async function addNoteLocal(jobId: string, text: string): Promise<void> {
  if (!getCachedIdentity()) {
    await addJobNote(jobId, text);
    return;
  }
  await enqueue('note', jobId, { text });
}
