import { describe, expect, it } from 'vitest';
import { FRAMEWORKS, formatComplianceDate, statusSummary, type ComplianceFramework } from '@/lib/complianceStatus';

const claim =
  /\b(?:SOC ?2|HIPAA|PCI(?:[- ]?DSS)?)\s+(?:compliant|certified|ready|aligned|approved)\b|\b(?:compliant|certified|ready|aligned)\s+with\s+(?:SOC ?2|HIPAA|PCI)/i;

describe('compliance status data', () => {
  it('covers SOC 2, HIPAA and PCI exactly once each', () => {
    expect(FRAMEWORKS.map((f) => f.id).sort()).toEqual(['hipaa', 'pci', 'soc2']);
  });

  it('never marks a framework as held without a complete attestation', () => {
    for (const f of FRAMEWORKS) {
      if (f.status === 'held') {
        expect(f.attestation?.issuer).toBeTruthy();
        expect(f.attestation?.reportType).toBeTruthy();
        expect(f.attestation?.period).toBeTruthy();
      } else {
        expect(f.attestation).toBeUndefined();
      }
    }
  });

  it('uses no affirmative certification wording', () => {
    for (const f of FRAMEWORKS) {
      for (const text of [f.statement, f.meaning, f.what, f.statusLabel]) expect(text).not.toMatch(claim);
    }
    expect(statusSummary()).not.toMatch(claim);
  });

  it('derives the summary from the data', () => {
    expect(statusSummary()).toBe(
      'Vireek does not currently hold a SOC 2 report, a HIPAA Business Associate Agreement or its own PCI DSS attestation.',
    );
    const held: ComplianceFramework = {
      ...FRAMEWORKS[0],
      status: 'held',
      statusLabel: 'Held',
      attestation: { issuer: 'Acme Audit LLP', reportType: 'SOC 2 Type II', period: 'Oct 2026 - Sep 2027' },
    };
    const summary = statusSummary([held, ...FRAMEWORKS.slice(1)]);
    expect(summary).toContain('SOC 2 Type II issued by Acme Audit LLP');
    expect(summary).not.toContain('a SOC 2 report');
  });

  it('formats the date independent of timezone', () => {
    expect(formatComplianceDate('2026-10-08')).toBe('October 8, 2026');
  });
});
