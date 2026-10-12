// src/lib/resourceLeads.ts
import { supabase } from '@/lib/supabase';
import { mapCaptureError, parseUnlock, serializeUnlock } from '@/lib/resources';
import type { CaptureFailure } from '@/lib/resources';

const UNLOCK_KEY = 'vk_resources_unlocked';

export type CaptureResult = { ok: true } | { ok: false; reason: CaptureFailure };

/**
 * Records the email in newsletter_subscribers (source 'resources:<slug>') and
 * the per-resource download, atomically, via the capture_resource_lead RPC.
 * Already-subscribed emails succeed silently (idempotent).
 */
export async function captureResourceLead(email: string, resourceSlug: string): Promise<CaptureResult> {
  try {
    const { error } = await supabase.rpc('capture_resource_lead', {
      p_email: email.trim().toLowerCase(),
      p_resource_slug: resourceSlug,
    });
    if (error) return { ok: false, reason: mapCaptureError(error.message) };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

/** One email unlocks the whole library on this browser for 180 days. */
export function readUnlock(): boolean {
  try {
    return parseUnlock(localStorage.getItem(UNLOCK_KEY), Date.now());
  } catch {
    return false;
  }
}

export function writeUnlock(): void {
  try {
    localStorage.setItem(UNLOCK_KEY, serializeUnlock(Date.now()));
  } catch {
    // Storage blocked: the resource still unlocks for this page view.
  }
}
