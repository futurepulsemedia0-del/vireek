/**
 * Tiered confirmation policy. Pure: returns WHAT to ask; ConfirmDialog renders it.
 *   none   – reversible (undo toast exists) and small → just do it
 *   light  – reversible but wide (bulk) → one confirm click, exact consequence
 *   typed  – irreversible, or high-impact cascade → type the name / `DELETE n`
 */
export type ConfirmTier = 'none' | 'light' | 'typed';

export const BULK_LIGHT_THRESHOLD = 10;
export const BULK_TYPED_THRESHOLD = 50;

export interface TierInput {
  /** An undo/restore path exists (soft delete + undo toast, or reversible update). */
  reversible: boolean;
  count: number;
  /** Deleting these also removes/affects dependents (invoices, payments…). */
  cascades?: boolean;
  /** Money moves, customer is notified, external system is called… */
  highImpact?: boolean;
}

export function decideTier(i: TierInput): ConfirmTier {
  if (!i.reversible || i.highImpact || i.cascades) return 'typed';
  if (i.count >= BULK_TYPED_THRESHOLD) return 'typed';
  if (i.count >= BULK_LIGHT_THRESHOLD) return 'light';
  return 'none';
}

export interface ConsequenceLine {
  count: number;
  /** i18n key of the noun with i18next plurals, e.g. `trust.nouns.job` (`_one`/`_other`). */
  nounKey: string;
}

/** "Delete 12 jobs and their invoices" → [{12, jobs}, {4, invoices}] (zero-count lines are dropped). */
export function consequenceLines(primary: ConsequenceLine, dependents: ConsequenceLine[] = []): ConsequenceLine[] {
  return [primary, ...dependents].filter((l) => l.count > 0);
}

/** Phrase the user must type: the entity name for one item, `DELETE <n>` for many. */
export function requiredPhrase(opts: { count: number; name?: string; word?: string }): string {
  const name = opts.name?.trim();
  if (opts.count === 1 && name) return name;
  return `${opts.word ?? 'DELETE'} ${opts.count}`;
}

const YEH = /[يى]/g; // ي ى → ی
const KAF = /ك/g; // ك → ک
const INVISIBLE = /[​-‏‪-‮⁦-⁩ـً-ٟ]/g; // ZW*, bidi, tatweel, harakat
const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/** Locale-safe comparison: NFKC, Persian/Arabic letter + digit variants, invisible chars, case, whitespace. */
export function normalizePhrase(s: string): string {
  return s
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(YEH, 'ی')
    .replace(KAF, 'ک')
    .replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) & 0xf))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function phraseMatches(typed: string, required: string): boolean {
  const r = normalizePhrase(required);
  return r.length > 0 && normalizePhrase(typed) === r;
}
