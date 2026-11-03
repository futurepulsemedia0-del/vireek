import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRICING_PLANS } from '@/lib/pricing';
import { CLAIMS, findClaimViolations, getClaim, validateClaims } from '@/lib/trust/claims';

describe('claims registry', () => {
  it('is internally consistent', () => {
    expect(validateClaims()).toEqual([]);
  });

  it('rejects verified claims without evidence and stale reviews', () => {
    const base = getClaim('sla.uptime-commitment');
    expect(validateClaims([{ ...base, evidence: undefined }])).toContain('sla.uptime-commitment: verified claims need evidence.href');
    expect(validateClaims([{ ...base, reviewedOn: '2020-01-01' }]).join()).toMatch(/not reviewed/);
  });

  it('keeps every certification not_held until evidence exists', () => {
    for (const c of CLAIMS.filter((x) => x.category === 'certification')) expect(c.status).toBe('not_held');
  });

  it('flags affirmative wording for unverified claims', () => {
    for (const text of [
      'We are SOC 2 Type II certified.',
      'Trusted by 500 contractors.',
      'Our penetration test passed.',
      'HIPAA compliant for clinics.',
      'G2 leader in voice AI.',
    ]) {
      expect(findClaimViolations(text).length, text).toBeGreaterThan(0);
    }
  });

  it('allows plain negative statements and comments', () => {
    for (const text of [
      'Vireek is not SOC 2 certified.',
      'Businesses ask whether you are SOC 2 compliant.',
      '// SOC 2 certified would go here',
      '1099 contractors are paid elsewhere.',
    ]) {
      expect(findClaimViolations(text), text).toEqual([]);
    }
  });

  it('honours an explicit claim-ok marker', () => {
    expect(findClaimViolations('SOC 2 certified // claim-ok: cert.soc2')).toEqual([]);
  });
});

describe('llms-full.txt', () => {
  const text = readFileSync('public/llms-full.txt', 'utf8');

  it('lists every plan price from pricing data', () => {
    for (const p of PRICING_PLANS) {
      expect(text).toContain(`| ${p.name} |`);
      if (p.monthly !== null) expect(text).toContain(`$${p.monthly}`);
      if (p.annual !== null && p.annual > 0) expect(text).toContain(`$${p.annual}`);
    }
  });

  it('asserts no unverified certification', () => {
    expect(findClaimViolations(text)).toEqual([]);
  });
});
