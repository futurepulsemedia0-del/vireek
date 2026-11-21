import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  decidePricingNotice,
  disclosablePaths,
  PRICE_PATH_IDS,
  PRICE_PATHS,
  type PricePathId,
} from './pricingPersonalization';

const ROOT = process.cwd();

describe('pricing personalization registry', () => {
  it('classifies the three paths the audit was asked about', () => {
    expect(PRICE_PATHS.service_area_surge.classification).toBe('location_derived');
    expect(PRICE_PATHS.outcome_pricing.classification).toBe('profile_modeled');
    expect(PRICE_PATHS.tiered_estimate.classification).toBe('none');
  });

  it('every path points at files that exist in the repo', () => {
    for (const id of PRICE_PATH_IDS) {
      for (const f of PRICE_PATHS[id].files) expect(existsSync(resolve(ROOT, f)), `${id}: ${f}`).toBe(true);
    }
  });

  it('a "none" path lists no personal-data input that varies the price', () => {
    for (const id of PRICE_PATH_IDS) {
      const p = PRICE_PATHS[id];
      if (p.classification === 'none' && p.decidedBy === 'owner_rule') {
        // inputs may exist (e.g. photos) but must be described as not varying the price between buyers, or be empty
        for (const input of p.inputs) expect(input).toMatch(/not to vary|never one buyer|aggregate/i);
      }
    }
  });

  it('every audited path is documented in the compliance doc', () => {
    const docPath = resolve(ROOT, 'docs/compliance/pricing-personalization.md');
    expect(existsSync(docPath)).toBe(true);
    const doc = readFileSync(docPath, 'utf8');
    for (const id of PRICE_PATH_IDS) expect(doc, `doc is missing \`${id}\``).toContain(`\`${id}\``);
    expect(doc).toContain('[COUNSEL]');
  });
});

describe('decidePricingNotice', () => {
  it('never shows with the flag off, for any path', () => {
    for (const id of PRICE_PATH_IDS) {
      expect(decidePricingNotice({ path: id, flagEnabled: false })).toEqual({ show: false, variant: null, reason: 'flag_off' });
    }
  });

  it('shows the right variant on personalized paths when the flag is on', () => {
    expect(decidePricingNotice({ path: 'service_area_surge', flagEnabled: true })).toMatchObject({ show: true, variant: 'location' });
    expect(decidePricingNotice({ path: 'service_area_travel_fee', flagEnabled: true })).toMatchObject({ show: true, variant: 'location' });
    expect(decidePricingNotice({ path: 'price_list_override', flagEnabled: true })).toMatchObject({ show: true, variant: 'account' });
    expect(decidePricingNotice({ path: 'outcome_pricing', flagEnabled: true })).toMatchObject({ show: true, variant: 'modeled' });
  });

  it('does not show on non-personalized paths even with the flag on', () => {
    const none: PricePathId[] = ['tiered_estimate', 'field_estimate_ai', 'after_hours_fee', 'payment_method_pricing', 'price_playbook_voice', 'pricing_flywheel', 'quote_truth_advisory'];
    for (const id of none) expect(decidePricingNotice({ path: id, flagEnabled: true })).toEqual({ show: false, variant: null, reason: 'not_personalized' });
  });

  it('leaves third-party decisions (lender terms) to the third party', () => {
    expect(decidePricingNotice({ path: 'financing_offer', flagEnabled: true })).toEqual({ show: false, variant: null, reason: 'third_party_decision' });
  });

  it('does not show when the personalized element is not part of this price', () => {
    expect(decidePricingNotice({ path: 'service_area_surge', flagEnabled: true, applied: false })).toEqual({ show: false, variant: null, reason: 'not_applied' });
  });

  it('does not show for an unknown path', () => {
    expect(decidePricingNotice({ path: 'made_up', flagEnabled: true })).toEqual({ show: false, variant: null, reason: 'unknown_path' });
    expect(decidePricingNotice({ path: '__proto__', flagEnabled: true })).toMatchObject({ show: false, reason: 'unknown_path' });
    expect(decidePricingNotice({ path: 'toString', flagEnabled: true })).toMatchObject({ show: false, reason: 'unknown_path' });
  });

  it('disclosablePaths() is exactly the set that can ever show', () => {
    const ids = disclosablePaths().map((p) => p.id).sort();
    const viaDecision = PRICE_PATH_IDS.filter((id) => decidePricingNotice({ path: id, flagEnabled: true }).show).sort();
    expect(ids).toEqual(viaDecision);
  });
});
