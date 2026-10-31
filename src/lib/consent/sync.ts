import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import {
  CONSENT_VERSION,
  applySignals,
  getConsentSnapshot,
  markConsentSynced,
  subscribeConsent,
  type ConsentRecord,
} from '@/lib/consent/engine';

/**
 * Stores proof of consent server-side (public.consent_records, append-only).
 * Works for anonymous visitors (pseudonymous subject id) and links to the account when signed in.
 * Failures are silent: the local record stays `synced: false` and is retried on the next
 * snapshot change, page load, or sign-in.
 */

type SyncAction = 'decision' | 'account_link';

let inFlight: string | null = null;
const linkedUsers = new Set<string>();

async function sendRecord(record: ConsentRecord, action: SyncAction): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  const { signals } = getConsentSnapshot();
  // Send the EFFECTIVE choice: marketing is never recorded as granted while GPC/DNT is on.
  const effective = applySignals(record.choices, signals);
  const { error } = await supabase.rpc('record_consent', {
    p_subject_id: record.subjectId,
    p_consent_version: record.version,
    p_recorded_at: record.timestamp,
    p_analytics: effective.analytics,
    p_marketing: effective.marketing,
    p_source: record.source,
    p_action: action,
    p_gpc: signals.gpc,
    p_dnt: signals.dnt,
  });
  return !error;
}

async function flushPending(): Promise<void> {
  const { record } = getConsentSnapshot();
  if (!record || record.synced || record.version !== CONSENT_VERSION) return;
  if (inFlight === record.timestamp) return;
  inFlight = record.timestamp;
  try {
    if (await sendRecord(record, 'decision')) markConsentSynced(record.timestamp);
  } finally {
    inFlight = null;
  }
}

/** Starts background sync. Returns an unsubscribe function. */
export function startConsentSync(): () => void {
  void flushPending();
  return subscribeConsent(() => {
    void flushPending();
  });
}

/** Call when a user signs in: records that this pseudonymous subject belongs to the account. */
export async function linkConsentToAccount(userId: string | null | undefined): Promise<void> {
  if (!userId || linkedUsers.has(userId)) return;
  const { record } = getConsentSnapshot();
  if (!record || record.version !== CONSENT_VERSION) return;
  linkedUsers.add(userId);
  const ok = await sendRecord(record, 'account_link');
  if (!ok) linkedUsers.delete(userId);
}
