import { describe, expect, it } from 'vitest';
import type { DeepContentData } from './types';
import { ABOUT_DEEP } from './about';
import { MANIFESTO_DEEP } from './manifesto';
import { FEATURES_DEEP } from './features';
import { SERVICES_DEEP } from './services';
import { PLATFORM_DEEP } from './platform';
import { FAQ_DEEP } from './faq';

const PAGES: Record<string, DeepContentData> = {
  about: ABOUT_DEEP,
  manifesto: MANIFESTO_DEEP,
  features: FEATURES_DEEP,
  services: SERVICES_DEEP,
  platform: PLATFORM_DEEP,
  faq: FAQ_DEEP,
};

function textOf(d: DeepContentData): string {
  const parts: string[] = [d.eyebrow, d.title, d.intro];
  for (const s of d.sections) {
    parts.push(s.title);
    for (const b of s.blocks) {
      if (b.kind === 'p') parts.push(b.text);
      if (b.kind === 'list') parts.push(...b.items);
      if (b.kind === 'steps') b.items.forEach((i) => parts.push(i.title, i.text));
      if (b.kind === 'callout') parts.push(b.title, b.text);
      if (b.kind === 'table') parts.push(b.caption, ...b.headers, ...b.rows.flat());
    }
  }
  (d.faqs ?? []).forEach((f) => parts.push(f.q, f.a));
  return parts.join(' ');
}

// Claims Vireek must not make without evidence (see About/Manifesto: no invented customers, stats or certifications).
const BANNED: RegExp[] = [
  /\bSOC ?2\b/i,
  /\bISO ?27001\b/i,
  /\bHIPAA\b/i,
  /\btrusted by\b/i,
  /\bthousands of (customers|contractors|businesses)\b/i,
  /\b\d[\d,]*\+? (customers|contractors|businesses|companies)\b/i,
  /\bguaranteed?\b/i,
  /\bbest[- ]in[- ]class\b/i,
  /\b#1\b/,
  /\$\s?\d/, // prices live only in PRICING_PLANS
];

describe('deep marketing content', () => {
  for (const [name, data] of Object.entries(PAGES)) {
    describe(name, () => {
      it('has unique, URL-safe section ids', () => {
        const ids = data.sections.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
        expect(ids).not.toContain('faq');
      });

      it('has no empty sections or blocks', () => {
        for (const s of data.sections) {
          expect(s.title.trim().length).toBeGreaterThan(0);
          expect(s.blocks.length).toBeGreaterThan(0);
          for (const b of s.blocks) {
            if (b.kind === 'list') expect(b.items.length).toBeGreaterThan(0);
            if (b.kind === 'steps') expect(b.items.length).toBeGreaterThan(0);
            if (b.kind === 'table') {
              for (const row of b.rows) expect(row.length).toBe(b.headers.length);
            }
          }
        }
      });

      it('is substantial', () => {
        const words = textOf(data).split(/\s+/).filter(Boolean).length;
        expect(words).toBeGreaterThan(450);
      });

      it('contains no unverifiable claims or hardcoded prices', () => {
        const text = textOf(data);
        for (const re of BANNED) expect(text).not.toMatch(re);
      });

      it('has unique FAQ questions', () => {
        const qs = (data.faqs ?? []).map((f) => f.q);
        expect(new Set(qs).size).toBe(qs.length);
      });
    });
  }
});
