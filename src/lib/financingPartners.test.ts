import { describe, expect, it } from 'vitest';
import {
  FINANCING_STATUSES, INSURANCE_STATUSES, canGrantWorkingCapitalConsent, canSubmitInsuranceReferral,
  computeFunnelRates, customerPanelState, effectiveOfferStatus, gateMessage,
} from './financingPartners';
import {
  PARTNER_REPORTABLE_FINANCING, financingTransition, insuranceTransition,
} from '../../supabase/functions/_shared/financing-partners/stateMachine';

describe('financing state machine', () => {
  it('moves forward along the happy path, including skipped steps', () => {
    expect(financingTransition('offered', 'link_opened')).toBe('apply');
    expect(financingTransition('link_opened', 'submitted')).toBe('apply');
    expect(financingTransition('submitted', 'approved')).toBe('apply');
    expect(financingTransition('approved', 'funded')).toBe('apply');
    expect(financingTransition('offered', 'funded')).toBe('apply');
  });
  it('never moves backwards', () => {
    expect(financingTransition('approved', 'submitted')).toBe('reject');
    expect(financingTransition('submitted', 'link_opened')).toBe('reject');
    expect(financingTransition('submitted', 'offered')).toBe('reject');
  });
  it('treats terminal states as immutable', () => {
    for (const t of ['funded', 'declined', 'expired', 'canceled'] as const) {
      for (const to of FINANCING_STATUSES) {
        if (to === t) continue;
        expect(financingTransition(t, to)).toBe('reject');
      }
    }
  });
  it('replaying the same status is a no-op (idempotent)', () => {
    for (const s of FINANCING_STATUSES) expect(financingTransition(s, s)).toBe('noop');
  });
  it('allows decline only before approval', () => {
    expect(financingTransition('submitted', 'declined')).toBe('apply');
    expect(financingTransition('approved', 'declined')).toBe('reject');
    expect(financingTransition('approved', 'expired')).toBe('apply');
    expect(financingTransition('approved', 'canceled')).toBe('apply');
  });
  it('partners cannot report link_opened (customer-click only)', () => {
    expect(PARTNER_REPORTABLE_FINANCING).not.toContain('link_opened');
    expect(PARTNER_REPORTABLE_FINANCING).not.toContain('offered');
  });
  it('insurance mirrors the same rules', () => {
    expect(insuranceTransition('referred', 'quoted')).toBe('apply');
    expect(insuranceTransition('quoted', 'contacted')).toBe('reject');
    expect(insuranceTransition('bound', 'canceled')).toBe('reject');
    expect(insuranceTransition('quoted', 'declined')).toBe('apply');
    expect(INSURANCE_STATUSES).toContain('bound');
  });
});

describe('funnel rates', () => {
  const base = { offered_quotes: 20, offers: 20, link_opened: 12, submitted: 8, approved: 6, funded: 4, declined: 1, expired: 5, canceled: 0, needs_review: 0, funded_amount_cents: 0 };
  it('computes offer, application and funded rates with explicit denominators', () => {
    const r = computeFunnelRates({ quotes_sent: 80, totals: base });
    expect(r.offerRate).toBeCloseTo(0.25);
    expect(r.openRate).toBeCloseTo(0.6);
    expect(r.applicationRate).toBeCloseTo(0.4);
    expect(r.approvalRate).toBeCloseTo(0.75);
    expect(r.fundedRate).toBeCloseTo(0.2);
    expect(r.fundedOfApplied).toBeCloseTo(0.5);
  });
  it('returns null (not 0%) when a denominator is empty', () => {
    const r = computeFunnelRates({ quotes_sent: 0, totals: { ...base, offers: 0, submitted: 0, offered_quotes: 0, link_opened: 0, approved: 0, funded: 0 } });
    expect(r.offerRate).toBeNull();
    expect(r.applicationRate).toBeNull();
    expect(r.fundedRate).toBeNull();
  });
});

describe('customer panel gating', () => {
  it('is hidden unless the server says available', () => {
    expect(customerPanelState(null)).toEqual({ kind: 'hidden' });
    expect(customerPanelState({ available: false })).toEqual({ kind: 'hidden' });
    expect(customerPanelState({ available: true })).toEqual({ kind: 'hidden' });
  });
  it('allows applying only while open', () => {
    expect(customerPanelState({ available: true, status: 'offered' })).toEqual({ kind: 'open', canApply: true });
    expect(customerPanelState({ available: true, status: 'approved' }).kind).toBe('in_progress');
    expect(customerPanelState({ available: true, status: 'declined' }).kind).toBe('closed');
    expect(customerPanelState({ available: true, status: 'expired' }).kind).toBe('closed');
  });
  it('shows an open offer past expiry as expired', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(effectiveOfferStatus('offered', past)).toBe('expired');
    expect(effectiveOfferStatus('approved', past)).toBe('approved');
  });
});

describe('consent gating', () => {
  it('blocks working-capital sharing without acknowledgement or scope', () => {
    expect(canGrantWorkingCapitalConsent({ acknowledged: false, scopes: ['tenure_months'], disclosureLoaded: true }).ok).toBe(false);
    expect(canGrantWorkingCapitalConsent({ acknowledged: true, scopes: [], disclosureLoaded: true }).ok).toBe(false);
    expect(canGrantWorkingCapitalConsent({ acknowledged: true, scopes: ['ssn'], disclosureLoaded: true }).ok).toBe(false);
    expect(canGrantWorkingCapitalConsent({ acknowledged: true, scopes: ['tenure_months'], disclosureLoaded: false }).ok).toBe(false);
    expect(canGrantWorkingCapitalConsent({ acknowledged: true, scopes: ['tenure_months', 'jobs_12m_band'], disclosureLoaded: true }).ok).toBe(true);
  });
  it('blocks insurance referral without acknowledgement or valid line', () => {
    expect(canSubmitInsuranceReferral({ acknowledged: false, line: 'equipment', disclosureLoaded: true }).ok).toBe(false);
    expect(canSubmitInsuranceReferral({ acknowledged: true, line: 'bogus', disclosureLoaded: true }).ok).toBe(false);
    expect(canSubmitInsuranceReferral({ acknowledged: true, line: 'equipment', disclosureLoaded: true }).ok).toBe(true);
  });
  it('has a message for every gate reason and a safe default', () => {
    for (const r of ['flag_off', 'not_entitled', 'region_unknown', 'region_blocked', 'forbidden']) expect(gateMessage(r)).not.toBe('');
    expect(gateMessage('weird')).toMatch(/isn’t available/);
  });
});
