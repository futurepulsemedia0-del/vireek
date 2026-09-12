import type { Sparkles, Zap, ShieldCheck, Wrench } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  changelog — single source of truth for release notes.              */
/*  Moved out of ChangelogPage.tsx so both the page AND the RSS-feed    */
/*  generator script (scripts/generate-rss.mjs) can import the same    */
/*  data without one dragging in the other's dependencies.             */
/* ------------------------------------------------------------------ */

export type EntryType = 'new' | 'improved' | 'security' | 'fixed';

export interface ChangelogEntry {
  type: EntryType;
  title: string;
  body: string;
}

export interface ChangelogRelease {
  date: string;
  entries: ChangelogEntry[];
}

// ============================================================
// PASTE YOUR EXISTING RELEASES ARRAY HERE — see instructions below
// for exactly what to cut from ChangelogPage.tsx.
// ============================================================
export const CHANGELOG_RELEASES: ChangelogRelease[] = [
  // ... paste your current release objects here, unchanged ...
];
