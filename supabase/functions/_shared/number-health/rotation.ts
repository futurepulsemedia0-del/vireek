// supabase/functions/_shared/number-health/rotation.ts
//
// Spam-label ALERT decisions and the rotate/retire workflow rules for phone numbers. Pure: no imports, no Deno or
// browser APIs, so the scheduled function, the dashboard and the node:test file share one source.
//
// Companion to ./core.ts (adapter contract, normalisation, severity). Labels here are the normalised vocabulary from
// core.ts: 'clean' | 'suspected' | 'flagged' | 'unknown'. "Spam Likely" from a provider normalises to 'suspected'.
//
// HONESTY RULES (enforced by tests):
//  * Nothing alerts from a stub / non-live provider: stub values are placeholders, never a real finding.
//  * 'unknown' never alerts and never resets: a provider blip must not clear or re-fire an alert.
//  * Retiring a number is a bookkeeping change in Vireek. Releasing the number at the carrier is NOT done by this code.

export type AlertLabel = 'suspected' | 'flagged';

export const ROTATION_REASONS = ['spam_flagged', 'spam_suspected', 'manual'] as const;
export type RotationReason = (typeof ROTATION_REASONS)[number];
export const isRotationReason = (s: unknown): s is RotationReason => typeof s === 'string' && (ROTATION_REASONS as readonly string[]).includes(s);

export const ROTATION_STATUSES = ['planned', 'retired', 'cancelled'] as const;
export type RotationStatus = (typeof ROTATION_STATUSES)[number];

/** Where the alert notification sends the owner. Existing dashboard route (see App.tsx). */
export const ALERT_ACTION_URL = '/dashboard/phone-numbers/reputation';

/* ------------------------------------------------------------------ */
/*  Alert decision                                                      */
/* ------------------------------------------------------------------ */

const LEVEL: Record<string, number> = { clean: 0, unknown: 0, suspected: 1, flagged: 2 };

export interface AlertInput {
  /** The worst label already alerted for this number, or null if none (or reset by a clean result). */
  alertedLabel: AlertLabel | null;
  /** Label from the check that just succeeded. */
  nextLabel: string;
  /** Only a live provider can alert. */
  providerLive: boolean;
}

export interface AlertDecision {
  /** Send a notification for this label, or null for none. */
  alert: AlertLabel | null;
  /** Value to store in number_health.alerted_label after this check. */
  nextAlertedLabel: AlertLabel | null;
}

/**
 * Alert once per escalation:
 *   clean -> suspected  alerts "suspected"      suspected -> flagged alerts "flagged"
 *   flagged -> suspected  no alert, but the remembered level drops so a later re-escalation alerts again
 *   anything -> clean   resets, so a later relapse alerts again
 *   unknown             changes nothing
 * Idempotent: the same input twice yields no second alert.
 */
export function decideAlert(i: AlertInput): AlertDecision {
  const keep: AlertDecision = { alert: null, nextAlertedLabel: i.alertedLabel };
  if (!i.providerLive) return keep;
  if (i.nextLabel === 'unknown' || !(i.nextLabel in LEVEL)) return keep;
  const next = LEVEL[i.nextLabel];
  if (next === 0) return { alert: null, nextAlertedLabel: null };
  const label = i.nextLabel as AlertLabel;
  const had = i.alertedLabel ? LEVEL[i.alertedLabel] : 0;
  if (next > had) return { alert: label, nextAlertedLabel: label };
  return { alert: null, nextAlertedLabel: label };
}

/** "+15125550123" -> "••••0123". Notifications never carry a full number. */
export function maskNumber(e164: string): string {
  const digits = String(e164 ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? `••••${digits.slice(-4)}` : '••••';
}

/** Plain English, like the other edge-function notifications. No provider names, no scores. */
export function alertCopy(label: AlertLabel, e164: string): { title: string; message: string } {
  const who = maskNumber(e164);
  if (label === 'flagged') {
    return {
      title: 'A number was flagged as spam',
      message: `Number ${who} was flagged as spam by your reputation provider. Pause outbound use and review the recovery steps; consider rotating to a replacement number.`,
    };
  }
  return {
    title: 'A number may show as "Spam Likely"',
    message: `Number ${who} was reported as a suspected spam caller. Review the recovery steps before it gets worse.`,
  };
}

/* ------------------------------------------------------------------ */
/*  Rotate / retire rules                                               */
/* ------------------------------------------------------------------ */

/** Suggest starting a rotation only for a real label. Attestation problems are fixed by registration, not by a new number. */
export function suggestedRotationReason(spamLabel: string, providerLive: boolean): RotationReason | null {
  if (!providerLive) return null;
  if (spamLabel === 'flagged') return 'spam_flagged';
  if (spamLabel === 'suspected') return 'spam_suspected';
  return null;
}

export interface RotationNumber { id: string; status: string; phone_number: string; voice_enabled?: boolean }
export interface RotationOpen { phone_number_id: string; replacement_number_id: string | null; status: string }

/**
 * Numbers that may be offered as the replacement for `oldId`: active, not the old number, not already the target of
 * another open rotation, not itself being retired, and not currently labelled suspected/flagged.
 */
export function replacementCandidates(
  numbers: readonly RotationNumber[],
  oldId: string,
  open: readonly RotationOpen[],
  labelById: Readonly<Record<string, string | undefined>>,
): RotationNumber[] {
  const takenAsReplacement = new Set(open.filter((r) => r.status === 'planned' && r.replacement_number_id && r.phone_number_id !== oldId).map((r) => r.replacement_number_id as string));
  const beingRetired = new Set(open.filter((r) => r.status === 'planned').map((r) => r.phone_number_id));
  return numbers.filter((n) => {
    if (n.id === oldId || n.status !== 'active') return false;
    if (takenAsReplacement.has(n.id) || beingRetired.has(n.id)) return false;
    const l = labelById[n.id];
    return l !== 'suspected' && l !== 'flagged';
  });
}

export type RetireBlock = 'not_open' | 'no_replacement' | 'replacement_inactive' | null;

/** Why a rotation cannot be completed yet (null = it can). The database re-checks all of this. */
export function retireBlocker(r: { status: string; replacement_number_id: string | null }, replacementStatus: string | null, allowNoReplacement: boolean): RetireBlock {
  if (r.status !== 'planned') return 'not_open';
  if (!r.replacement_number_id) return allowNoReplacement ? null : 'no_replacement';
  if (replacementStatus !== 'active') return 'replacement_inactive';
  return null;
}
