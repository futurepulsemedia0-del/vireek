/** Data model for the standalone legal documents served by LegalDocPage. */
export interface LegalSection {
  id: string;
  title: string;
  /** Plain paragraphs. Inline markup: **bold** and [label](/internal-path | mailto: | https://). */
  paragraphs?: string[];
  bullets?: string[];
  /** Highlighted box (rendered with the same accent style as the other legal pages). */
  callout?: { label: string; text: string };
}

export interface LegalDoc {
  slug: string;
  path: string;
  title: string;
  metaTitle: string;
  description: string;
  /** One-sentence plain-language summary shown under the title. */
  summary: string;
  /** ISO date (YYYY-MM-DD) of the last substantive change. */
  updated: string;
  /** All documents ship as pending counsel review until a lawyer signs off. */
  reviewStatus: 'pending-counsel' | 'approved';
  sections: LegalSection[];
  related: ReadonlyArray<{ label: string; href: string }>;
}

export const LEGAL_CONTACT_EMAIL = 'ali@vireek.com';
export const LEGAL_UPDATED = '2026-11-15';
