/**
 * Records that a customer opened the tracked booking link from a text-back.
 * Runs from the public booking page in JavaScript, so link-preview bots and
 * carrier scanners (which do not execute JS) never count as a click.
 * Tracking must never get in the way of booking: every failure is swallowed.
 */

import { supabase } from '@/lib/supabase';

const TOKEN_RE = /^[0-9a-f]{20}$/;

export function isValidRescueToken(token: string | null | undefined): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

export async function recordRescueLinkClick(token: string | null | undefined): Promise<void> {
  if (!isValidRescueToken(token)) return;
  const key = `vireek.rl.${token}`;
  try {
    // React strict-mode double effects and tab reloads must not count twice.
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, '1');
  } catch {
    /* storage blocked: the server-side 60 s de-dupe still applies */
  }
  try {
    await supabase.rpc('record_rescue_link_click', { p_token: token });
  } catch {
    /* never break the booking page */
  }
}
