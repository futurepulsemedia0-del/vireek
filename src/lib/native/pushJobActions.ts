// src/lib/native/pushJobActions.ts — notification action buttons for job alerts (phone and,
// via OS mirroring, Apple Watch / Wear OS). Pure + dependency-injected so it is unit tested
// without Capacitor. Writes go through the offline outbox, so a tap works with no signal.
//
// Safety rules (see docs/mobile/watch.md):
//  - the job id comes only from a same-app /tech/job/<uuid> URL, never from free-form data;
//  - the job must exist in THIS technician's local bundle (stale notification for another
//    account => ignored);
//  - statuses only move forward; a repeat tap while one is queued is a no-op;
//  - "complete" never auto-completes: it opens the job screen, where required steps live.

import type { JobStatus } from '@/lib/technicianOS';

export const PUSH_ACTION_IDS = ['en_route', 'start', 'complete'] as const;
export type PushActionId = (typeof PUSH_ACTION_IDS)[number];

/** TODO(owner): flip only after confirming completion needs no signature / checklist. */
export const DIRECT_COMPLETE_ENABLED = false;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_PATH = /^\/tech\/job\/([0-9a-f-]{36})\/?$/i;

const RANK: Record<JobStatus, number> = { scheduled: 0, en_route: 1, in_progress: 2, completed: 3 };
const TARGET: Record<PushActionId, JobStatus> = { en_route: 'en_route', start: 'in_progress', complete: 'completed' };

export function isPushActionId(v: unknown): v is PushActionId {
  return typeof v === 'string' && (PUSH_ACTION_IDS as readonly string[]).includes(v);
}

/** Extracts the job id from `data.url` (absolute vireek.com URL or relative path); null if not a job link. */
export function jobIdFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return null;
  let path: string;
  try {
    const u = new URL(url, 'https://vireek.com');
    if (u.hostname !== 'vireek.com' && u.hostname !== 'www.vireek.com') return null;
    path = u.pathname;
  } catch {
    return null;
  }
  const id = JOB_PATH.exec(path)?.[1];
  return id && UUID.test(id) ? id.toLowerCase() : null;
}

export type ActionOutcome =
  | { kind: 'queued'; jobId: string; status: JobStatus }
  | { kind: 'open'; jobId: string }
  | { kind: 'ignored'; reason: 'unknown_action' | 'no_job' | 'no_identity' | 'not_my_job' | 'not_forward' | 'already_queued' };

export interface ActionDeps {
  hasIdentity: () => boolean;
  getLocalJobStatus: (jobId: string) => Promise<JobStatus | null>;
  hasQueuedStatus: (jobId: string, status: JobStatus) => Promise<boolean>;
  queueStatus: (jobId: string, status: JobStatus) => Promise<void>;
}

export async function runPushJobAction(
  event: { actionId?: unknown; data?: unknown },
  deps: ActionDeps,
): Promise<ActionOutcome> {
  if (!isPushActionId(event.actionId)) return { kind: 'ignored', reason: 'unknown_action' };
  const data = typeof event.data === 'object' && event.data !== null ? (event.data as { url?: unknown }) : {};
  const jobId = jobIdFromUrl(data.url);
  if (!jobId) return { kind: 'ignored', reason: 'no_job' };
  if (!deps.hasIdentity()) return { kind: 'ignored', reason: 'no_identity' };

  const current = await deps.getLocalJobStatus(jobId);
  if (current === null) return { kind: 'ignored', reason: 'not_my_job' };

  if (event.actionId === 'complete' && !DIRECT_COMPLETE_ENABLED) return { kind: 'open', jobId };

  const target = TARGET[event.actionId];
  if (RANK[target] <= RANK[current]) return { kind: 'ignored', reason: 'not_forward' };
  if (await deps.hasQueuedStatus(jobId, target)) return { kind: 'ignored', reason: 'already_queued' };
  await deps.queueStatus(jobId, target);
  return { kind: 'queued', jobId, status: target };
}
