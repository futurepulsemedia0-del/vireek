import { supabase } from '@/lib/supabase';
import {
  isProfileComplete,
  sanitizeSkipped,
  type ProfileFields,
  type Signals,
  type StepKey,
} from '@/lib/gettingStarted';

type Result = { data: unknown; error: unknown };

/** A failed source becomes `null` ("couldn't check") — never a misleading "not done". */
async function exists(query: PromiseLike<Result>): Promise<boolean | null> {
  try {
    const { data, error } = await query;
    if (error || !Array.isArray(data)) return null;
    return data.length > 0;
  } catch {
    return null;
  }
}

async function profileComplete(ownerId: string): Promise<boolean | null> {
  try {
    const { data, error } = await supabase
      .from('business_profile')
      .select('services_offered,service_area,business_hours')
      .eq('user_id', ownerId)
      .maybeSingle();
    if (error) return null;
    return isProfileComplete(data as ProfileFields | null);
  } catch {
    return null;
  }
}

const owned = (table: string, ownerId: string) =>
  supabase.from(table).select('id').eq('user_id', ownerId).limit(1);

/**
 * Reads the real account data behind each step. Every query is scoped to the
 * ACCOUNT OWNER's id (not the signed-in user's), so a team member sees the
 * same progress as the owner. Only steps in `want` are queried.
 */
export async function fetchSignals(ownerId: string, want: ReadonlySet<StepKey>): Promise<Signals> {
  const skip = Promise.resolve<boolean | null>(null);
  const run = (key: StepKey, task: () => Promise<boolean | null>) => (want.has(key) ? task() : skip);

  const [
    business_profile, phone_number, team, integrations, customer,
    job, price_book, quote, invoice, first_call,
  ] = await Promise.all([
    run('business_profile', () => profileComplete(ownerId)),
    run('phone_number', () =>
      exists(
        supabase.from('phone_numbers').select('id').eq('account_id', ownerId)
          .in('status', ['active', 'porting_in']).limit(1),
      ),
    ),
    run('team', () =>
      exists(supabase.from('team_members').select('id').eq('account_owner_id', ownerId).limit(1)),
    ),
    run('integrations', () =>
      exists(supabase.from('integrations').select('id').eq('user_id', ownerId).eq('status', 'connected').limit(1)),
    ),
    run('customer', () => exists(owned('customers', ownerId))),
    run('job', () => exists(owned('jobs', ownerId))),
    run('price_book', () => exists(owned('price_book_items', ownerId))),
    run('quote', () => exists(owned('quotes', ownerId))),
    run('invoice', () => exists(owned('invoices', ownerId))),
    run('first_call', () => exists(owned('calls', ownerId))),
  ]);

  return {
    business_profile, phone_number, team, integrations, customer,
    job, price_book, quote, invoice, first_call,
  };
}

// ---------------------------------------------------------------------------
// Per-person progress (tour / dismissal / skipped steps)
// ---------------------------------------------------------------------------

export interface ProgressState {
  tourCompleted: boolean;
  checklistDismissed: boolean;
  skipped: StepKey[];
}

export const EMPTY_PROGRESS: ProgressState = { tourCompleted: false, checklistDismissed: false, skipped: [] };

const storageKey = (userId: string) => `vireek:getting-started:${userId}`;

function readLocal(userId: string): ProgressState | null {
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<ProgressState>;
    return {
      tourCompleted: p.tourCompleted === true,
      checklistDismissed: p.checklistDismissed === true,
      skipped: sanitizeSkipped(p.skipped),
    };
  } catch {
    return null;
  }
}

function writeLocal(userId: string, state: ProgressState) {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(state));
  } catch {
    /* private mode / quota — the database copy is the source of truth */
  }
}

/** Database first; falls back to the local copy if the table is unavailable. */
export async function loadProgress(userId: string): Promise<ProgressState> {
  try {
    const { data, error } = await supabase
      .from('getting_started_progress')
      .select('tour_completed_at,checklist_dismissed_at,skipped_steps')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return readLocal(userId) ?? EMPTY_PROGRESS;
    const row = data as { tour_completed_at: string | null; checklist_dismissed_at: string | null; skipped_steps: string[] | null };
    const state: ProgressState = {
      tourCompleted: !!row.tour_completed_at,
      checklistDismissed: !!row.checklist_dismissed_at,
      skipped: sanitizeSkipped(row.skipped_steps),
    };
    writeLocal(userId, state);
    return state;
  } catch {
    return readLocal(userId) ?? EMPTY_PROGRESS;
  }
}

/** Always saves locally; the database write is best-effort so the UI never blocks on it. */
export async function saveProgress(userId: string, next: ProgressState): Promise<void> {
  writeLocal(userId, next);
  try {
    const now = new Date().toISOString();
    const { error } = await supabase.from('getting_started_progress').upsert(
      {
        user_id: userId,
        tour_completed_at: next.tourCompleted ? now : null,
        checklist_dismissed_at: next.checklistDismissed ? now : null,
        skipped_steps: next.skipped,
        updated_at: now,
      },
      { onConflict: 'user_id' },
    );
    if (error) throw error;
  } catch {
    /* table not migrated yet or offline — the local copy still persists it */
  }
}
