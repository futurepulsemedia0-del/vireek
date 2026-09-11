/* ------------------------------------------------------------------ */
/*  experiments — Lightweight, no-backend A/B testing infrastructure   */
/*                                                                      */
/*  How it works:                                                      */
/*  1. Each visitor gets a random, persistent `visitorId` (localStorage)*/
/*  2. For each experiment, the visitor is deterministically bucketed  */
/*     into a variant using a hash of `experimentId:visitorId`, so the */
/*     same visitor always lands in the same bucket.                   */
/*  3. The assignment is cached in localStorage so it's sticky across  */
/*     page reloads and sessions.                                      */
/*  4. The first time a variant is rendered, a GA4 `experiment_exposure`*/
/*     event fires (via the existing analytics.ts / CookieConsent      */
/*     gating), so results can be segmented in GA4 by variant.          */
/*                                                                      */
/*  This is purely client-side (no server, no feature-flag service) —  */
/*  good enough for landing-page / pricing-page copy and layout tests. */
/*  If true statistical experiment management is needed later, this    */
/*  file is the single seam to swap for a real provider.               */
/* ------------------------------------------------------------------ */

import { trackEvent } from '@/lib/analytics';

/**
 * Register every experiment here. Add a new id + variant list to run a
 * new test; nothing else needs to change in this file.
 */
export type ExperimentId = 'hero_headline' | 'pricing_default_billing';

export interface ExperimentVariant {
  id: string;
  /** Relative weight — weights don't need to sum to 100, only to be comparable to each other. */
  weight: number;
}

export interface ExperimentConfig {
  id: ExperimentId;
  variants: ExperimentVariant[];
}

export const EXPERIMENTS: Record<ExperimentId, ExperimentConfig> = {
  hero_headline: {
    id: 'hero_headline',
    variants: [
      { id: 'control', weight: 1 },
      { id: 'variant_b', weight: 1 },
    ],
  },
  pricing_default_billing: {
    id: 'pricing_default_billing',
    variants: [
      { id: 'annual', weight: 1 },
      { id: 'monthly', weight: 1 },
    ],
  },
};

const VISITOR_ID_KEY = 'vireek-visitor-id';
const ASSIGNMENTS_KEY = 'vireek-experiment-assignments';

function getVisitorId(): string {
  let id = localStorage.getItem(VISITOR_ID_KEY);
  if (!id) {
    id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(VISITOR_ID_KEY, id);
  }
  return id;
}

/** Simple deterministic string hash (djb2). Good enough for bucketing, not for security. */
function hashString(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return hash >>> 0;
}

function pickVariant(experiment: ExperimentConfig, visitorId: string): string {
  const totalWeight = experiment.variants.reduce((sum, v) => sum + v.weight, 0);
  const bucket = hashString(`${experiment.id}:${visitorId}`) % totalWeight;
  let cumulative = 0;
  for (const variant of experiment.variants) {
    cumulative += variant.weight;
    if (bucket < cumulative) return variant.id;
  }
  return experiment.variants[0].id;
}

function readStoredAssignments(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ASSIGNMENTS_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeStoredAssignments(assignments: Record<string, string>) {
  localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(assignments));
}

/**
 * Returns (and persists) this visitor's variant id for `experimentId`.
 * Safe to call multiple times / from multiple components — the result
 * is memoized in localStorage after the first call.
 */
export function getVariant(experimentId: ExperimentId): string {
  const experiment = EXPERIMENTS[experimentId];
  const stored = readStoredAssignments();
  if (stored[experimentId]) return stored[experimentId];

  const variant = pickVariant(experiment, getVisitorId());
  stored[experimentId] = variant;
  writeStoredAssignments(stored);
  return variant;
}

const exposedThisSession = new Set<string>();

/**
 * Fires a GA4 `experiment_exposure` event the first time a given
 * experiment/variant pair is shown in this page session (deduped so a
 * re-rendering component doesn't spam events). Respects the same
 * analytics consent gating as every other `trackEvent` call.
 */
export function trackExperimentExposure(experimentId: ExperimentId, variant: string) {
  const key = `${experimentId}:${variant}`;
  if (exposedThisSession.has(key)) return;
  exposedThisSession.add(key);
  trackEvent('experiment_exposure', { experiment_id: experimentId, variant_id: variant });
}
