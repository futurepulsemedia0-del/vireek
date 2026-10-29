// Shared plumbing for Submittals, Punch Lists and Attachments:
// Supabase result unwrapping, paging and database-error → friendly copy.

import { friendlyError } from '@/lib/installProjects';

export type Res<T> = { data: T | null; error: { message: string } | null };

const ITEM_ERROR_COPY: [string, string][] = [
  ['not_authorized', 'You do not have permission to do that.'],
  ['not_authenticated', 'Your session expired. Sign in again.'],
  ['flow_only', 'Use the workflow buttons to change the status.'],
  ['invalid_transition', 'That step is not allowed from the current status. Refresh and try again.'],
  ['invalid_action', 'That action is not supported.'],
  ['reviewer_required', 'Add a reviewer before submitting.'],
  ['attachment_required', 'Attach at least one file to this revision before submitting.'],
  ['after_photo_required', 'Add an “After” photo before marking this item fixed.'],
  ['verifier_must_differ', 'Someone other than the person who marked it fixed must verify it.'],
  ['note_required', 'Add a short note (at least 3 characters) for this action.'],
  ['note_too_long', 'Keep the note under 2,000 characters.'],
  ['revision_limit', 'This submittal reached the maximum number of revisions.'],
  ['revision_locked', 'This revision was already submitted. Create a new revision to change the package.'],
  ['submittal_locked', 'Spec section, title and type cannot change after a submittal leaves draft.'],
  ['submittal_void', 'This submittal is void.'],
  ['submittal_not_found', 'Submittal not found.'],
  ['punch_not_found', 'Punch item not found.'],
  ['item_closed', 'This item is closed. Reopen it to make changes.'],
  ['invalid_technician', 'That team member is not in your account.'],
  ['invalid_project', 'That project is not in your account.'],
  ['invalid_phase', 'That phase does not belong to this project.'],
  ['invalid_parent', 'The item for this file no longer exists.'],
  ['invalid_purpose', 'That kind of file cannot be added at this stage.'],
  ['invalid_path', 'Invalid file location.'],
  ['attachment_limit', 'You reached the limit of 30 files here.'],
  ['project_cancelled', 'This project is cancelled.'],
  ['immutable_link', 'That field cannot be changed.'],
  ['spec_section', 'Enter a valid spec section, e.g. 23 05 00.'],
  ['row-level security', 'You do not have permission to do that.'],
];

export function friendlyItemError(error: unknown, fallback: string): string {
  const message =
    error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : '';
  for (const [key, copy] of ITEM_ERROR_COPY) if (message.includes(key)) return copy;
  return friendlyError(error, fallback);
}

export function unwrap<T>(res: Res<T>, fallback: string): T {
  if (res.error) throw new Error(friendlyItemError(res.error, fallback));
  return res.data as T;
}

const PAGE = 1000;
const MAX_ROWS = 10_000;

export async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<Res<T[]>>, fallback: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; out.length < MAX_ROWS; from += PAGE) {
    const rows = unwrap(await build(from, from + PAGE - 1), fallback) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** Local date-time for history rows, e.g. "Mar 10, 2027, 2:30 PM". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export interface ItemEvent {
  id: string;
  item_type: 'submittal' | 'punch';
  item_id: string;
  action: string;
  from_status: string | null;
  to_status: string | null;
  revision_number: number | null;
  note: string | null;
  actor_name: string | null;
  created_at: string;
}
