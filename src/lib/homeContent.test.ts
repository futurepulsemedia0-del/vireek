import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HERO_PROOF,
  HOME_FAQS,
  PRODUCT_SHOTS,
  SARAH_SAMPLE_AUDIO,
  TRIAL,
  TRIAL_CARD_PHRASE,
  TRIAL_MINUTES,
  TRIAL_REQUIRES_CARD,
} from './homeContent';
import { PRICING_PLANS } from './pricing';

const publicFile = (src: string) => resolve(process.cwd(), 'public', src.replace(/^\//, ''));

describe('homepage trial copy has one source of truth', () => {
  it('derives every card statement from TRIAL_REQUIRES_CARD', () => {
    const copy = [TRIAL.short, ...HERO_PROOF.map((i) => i.detail), TRIAL_CARD_PHRASE, ...HOME_FAQS.map((f) => f.a)].join(' | ');
    if (TRIAL_REQUIRES_CARD) {
      expect(copy).not.toMatch(/no credit card|no card/i);
    } else {
      // "No credit card required" is fine; a bare "Card required" is not.
      expect(copy).not.toMatch(/(?<!no credit )card required/i);
    }
  });

  it('prices and trial minutes in the FAQ come from lib/pricing.ts, never a stale literal', () => {
    const starter = PRICING_PLANS.find((p) => p.id === 'starter');
    const cost = HOME_FAQS.find((f) => /how much does it cost/i.test(f.q));
    expect(starter?.monthly).toBeGreaterThan(0);
    expect(Number.isFinite(TRIAL_MINUTES)).toBe(true);
    expect(cost?.a).toContain(`$${starter?.monthly} a month`);
    expect(cost?.a).toContain(`${TRIAL_MINUTES} voice minutes`);
    expect(cost?.a).not.toContain('undefined');
    expect(cost?.a).not.toContain('NaN');
  });
});

describe('optional real assets, once provided, are shippable', () => {
  for (const [key, shot] of Object.entries(PRODUCT_SHOTS)) {
    if (!shot) continue;
    it(`PRODUCT_SHOTS.${key}: WebP under 150 KB with real size and alt text`, () => {
      expect(shot.src).toMatch(/\.webp$/);
      expect(existsSync(publicFile(shot.src))).toBe(true);
      expect(statSync(publicFile(shot.src)).size).toBeLessThanOrEqual(150 * 1024);
      expect(shot.width).toBeGreaterThan(0);
      expect(shot.height).toBeGreaterThan(0);
      expect(shot.alt.trim().length).toBeGreaterThan(10);
    });
  }

  it('SARAH_SAMPLE_AUDIO, when set, points to an existing file with a duration label', () => {
    if (!SARAH_SAMPLE_AUDIO) return;
    expect(SARAH_SAMPLE_AUDIO.durationLabel.trim()).not.toBe('');
    if (SARAH_SAMPLE_AUDIO.src.startsWith('/')) expect(existsSync(publicFile(SARAH_SAMPLE_AUDIO.src))).toBe(true);
  });

  it('the compressed founder portrait exists and stays small', () => {
    expect(existsSync(publicFile('/founder-320.webp'))).toBe(true);
    expect(statSync(publicFile('/founder-320.webp')).size).toBeLessThan(60 * 1024);
  });
});
