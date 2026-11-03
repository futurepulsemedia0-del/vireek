import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLAIM_BY_ID } from '@/lib/trust/claims';
import { EVIDENCE_ITEMS } from '@/lib/trust/evidence';

const app = readFileSync('src/App.tsx', 'utf8');

describe('evidence library', () => {
  it('has unique ids', () => {
    expect(new Set(EVIDENCE_ITEMS.map((e) => e.id)).size).toBe(EVIDENCE_ITEMS.length);
  });

  it('links only to routes that exist', () => {
    for (const e of EVIDENCE_ITEMS.filter((x) => x.href)) expect(app, e.href).toContain(`path="${e.href}"`);
  });

  it('never presents an unavailable document as available', () => {
    for (const e of EVIDENCE_ITEMS) {
      if (e.availability === 'public') expect(e.status, e.id).toBe('verified');
      if (e.availability === 'not_available') {
        expect(e.href, e.id).toBeUndefined();
        expect(e.status, e.id).not.toBe('verified');
      }
    }
  });

  it('stays consistent with the claims registry', () => {
    for (const e of EVIDENCE_ITEMS.filter((x) => x.claimId)) {
      const claim = CLAIM_BY_ID[e.claimId as string];
      expect(claim, e.id).toBeTruthy();
      expect(e.status, e.id).toBe(claim.status);
    }
  });
});
