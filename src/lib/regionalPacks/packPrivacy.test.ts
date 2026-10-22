import { describe, it, expect } from 'vitest';
import {
  computeRequestDeadline, daysUntil, evaluateMarketingConsent, planErasure, regimesFor, rowsToCsv,
  parsePortabilityPackage, serializePortability, unsubscribeDeadline, retentionYears,
} from './packPrivacy';

const NOW = new Date('2026-10-20T12:00:00Z');

describe('regimes & deadlines', () => {
  it('maps places to regimes', () => {
    expect(regimesFor('DE')).toEqual(['GDPR']);
    expect(regimesFor('CA', 'QC')).toEqual(['PIPEDA', 'QC_LAW25', 'CASL']);
    expect(regimesFor('US', 'CA')).toEqual(['CCPA', 'CAN_SPAM']);
    expect(regimesFor('JP')).toEqual([]);
  });
  it('computes GDPR one-month deadlines and rolls off weekends', () => {
    expect(computeRequestDeadline({ regime: 'GDPR', receivedOn: '2026-10-05', country: 'DE' }).dueOn).toBe('2026-11-05');
    expect(computeRequestDeadline({ regime: 'GDPR', receivedOn: '2026-10-03', country: 'FR' }).dueOn).toBe('2026-11-03');
    expect(computeRequestDeadline({ regime: 'GDPR', receivedOn: '2026-10-31', country: 'FR' }).dueOn).toBe('2026-11-30');
    expect(computeRequestDeadline({ regime: 'GDPR', receivedOn: '2026-01-31', country: 'FR' }).dueOn).toBe('2026-03-02'); // 28 Feb is Saturday
    expect(computeRequestDeadline({ regime: 'GDPR', receivedOn: '2026-10-05', country: 'DE', extended: true }).dueOn).toBe('2027-01-05');
  });
  it('computes day-count deadlines', () => {
    expect(computeRequestDeadline({ regime: 'PIPEDA', receivedOn: '2026-10-01', country: 'CA' }).dueOn).toBe('2026-10-31');
    expect(computeRequestDeadline({ regime: 'CCPA', receivedOn: '2026-10-01', country: 'US', extended: true }).dueOn).toBe('2026-12-30');
    expect(() => computeRequestDeadline({ regime: 'CASL', receivedOn: '2026-10-01', country: 'CA' })).toThrow();
    expect(daysUntil('2026-11-05', '2026-10-20')).toBe(16);
  });
  it('counts unsubscribe business days', () => {
    expect(unsubscribeDeadline('CASL', '2026-10-19', 'CA', 'ON')).toBe('2026-11-02'); // 10 business days after Mon 19 Oct
    expect(unsubscribeDeadline('AU_SPAM', '2026-10-19', 'AU', 'NSW')).toBe('2026-10-26');
    expect(unsubscribeDeadline('GDPR', '2026-10-19', 'DE')).toBe('2026-10-19');
  });
});

describe('marketing consent', () => {
  const rec = (granted: boolean, created_at: string, expires_at: string | null = null) => ({ consent_type: 'marketing_email', granted, created_at, expires_at });
  it('honours express consent and withdrawal everywhere', () => {
    expect(evaluateMarketingConsent({ channel: 'email', regime: 'GDPR', records: [rec(true, '2026-01-01T00:00:00Z')], now: NOW }).basis).toBe('express');
    const w = evaluateMarketingConsent({ channel: 'email', regime: 'CAN_SPAM', records: [rec(true, '2026-01-01T00:00:00Z'), rec(false, '2026-02-01T00:00:00Z')], now: NOW });
    expect(w.allowed).toBe(false);
    expect(w.basis).toBe('withdrawn');
  });
  it('treats expired express consent as expired in the EU', () => {
    const d = evaluateMarketingConsent({ channel: 'email', regime: 'GDPR', records: [rec(true, '2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z')], now: NOW });
    expect(d.basis).toBe('expired');
  });
  it('applies CASL implied consent windows', () => {
    const p = evaluateMarketingConsent({ channel: 'email', regime: 'CASL', records: [], lastPurchaseAt: '2025-03-01', now: NOW });
    expect(p.basis).toBe('implied_relationship');
    expect(p.expiresAt?.slice(0, 10)).toBe('2027-03-01');
    expect(evaluateMarketingConsent({ channel: 'email', regime: 'CASL', records: [], lastPurchaseAt: '2024-01-01', now: NOW }).allowed).toBe(false);
    expect(evaluateMarketingConsent({ channel: 'email', regime: 'CASL', records: [], lastInquiryAt: '2026-06-01', now: NOW }).basis).toBe('implied_inquiry');
    expect(evaluateMarketingConsent({ channel: 'email', regime: 'CASL', records: [], lastInquiryAt: '2026-01-01', now: NOW }).allowed).toBe(false);
  });
  it('requires opt-in in the EU unless soft opt-in is enabled; UK has it', () => {
    const base = { channel: 'email' as const, records: [], lastPurchaseAt: '2026-05-01', now: NOW };
    expect(evaluateMarketingConsent({ ...base, regime: 'GDPR' }).allowed).toBe(false);
    expect(evaluateMarketingConsent({ ...base, regime: 'GDPR', allowSoftOptIn: true }).basis).toBe('soft_opt_in');
    expect(evaluateMarketingConsent({ ...base, regime: 'UK_GDPR' }).basis).toBe('soft_opt_in');
  });
  it('treats US email as opt-out but texts as opt-in', () => {
    expect(evaluateMarketingConsent({ channel: 'email', regime: 'CAN_SPAM', records: [], now: NOW }).basis).toBe('opt_out_regime');
    expect(evaluateMarketingConsent({ channel: 'sms', regime: 'CAN_SPAM', records: [], now: NOW }).allowed).toBe(false);
  });
});

describe('erasure plan', () => {
  it('retains invoices but erases the rest', () => {
    const p = planErasure({ country: 'DE', hasInvoices: true, lastInvoiceOn: '2026-05-10', today: '2026-10-20' });
    const inv = p.items.find((i) => i.category.startsWith('Invoices'));
    expect(inv?.action).toBe('retain');
    expect(inv?.until).toBe('2034-12-31');
    expect(p.items.find((i) => i.category === 'Contact details')?.action).toBe('anonymize');
    expect(p.erasureRight).toBe('full');
    expect(retentionYears('XX')).toBe(7);
  });
  it('erases contact details when nothing must be kept', () => {
    expect(planErasure({ country: 'GB', hasInvoices: false }).items.find((i) => i.category === 'Contact details')?.action).toBe('erase');
  });
  it('defers everything under a legal hold and flags limited rights', () => {
    const p = planErasure({ country: 'FR', hasInvoices: true, legalHold: true });
    expect(p.canCompleteNow).toBe(false);
    expect(p.items.every((i) => i.action === 'defer')).toBe(true);
    expect(planErasure({ country: 'AU', hasInvoices: false }).erasureRight).toBe('limited');
  });
});

describe('portability', () => {
  it('escapes CSV and neutralises formulas', () => {
    const csv = rowsToCsv([{ name: '=HYPERLINK("x")', note: 'a,"b"', n: 3 }, { name: 'ok', extra: null }]);
    expect(csv.split('\r\n')[0]).toBe('extra,n,name,note');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"a,""b"""');
    expect(rowsToCsv([])).toBe('');
  });
  it('validates the export envelope', () => {
    expect(() => parsePortabilityPackage({ schema: 'nope' })).toThrow();
    const pkg = parsePortabilityPackage({ schema: 'vireek.portability.v1', generated_at: 'x', subject: { customer_id: 'c1' }, sections: { jobs: [{ id: 1 }], calls: 'bad' } });
    expect(pkg.sections.calls).toEqual([]);
    const out = serializePortability(pkg);
    expect(Object.keys(out.csv)).toEqual(['jobs']);
    expect(JSON.parse(out.json).subject.customer_id).toBe('c1');
  });
});
