// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  containsContactInfo,
  deriveRails,
  formatBps,
  isValidRegion,
  networkReadiness,
  parseMoneyToCents,
  parseRegions,
  rankOffers,
  referralFeeCents,
  sha256Hex,
  timeLeft,
  validateOfferDraft,
  validateRequestDraft,
  type PenOffer,
  type PenOverview,
  type PenTrade,
} from './physicalEconomyNetwork';

const hvac: PenTrade = {
  trade_key: 'hvac', label: 'HVAC', description: '', sort_order: 10, protocol_version: 1,
  categories: ['no_cooling', 'repair'], required_evidence: [], outcome_metrics: [],
};

function overview(patch: Partial<PenOverview> = {}): PenOverview {
  return {
    node: {
      id: 'n', account_owner_id: 'o', node_handle: 'vrk_abc', trades: ['hvac'], regions: ['US'],
      status: 'active', accepts_referrals: true, referral_fee_bps: 500, consent_version: 'v', consented_at: '2027-01-01',
    },
    can_manage: true,
    identity: { technicians: 2, technicians_identified: 2, sites: 1, sites_identified: 1, business_network_id: 'vrk:biz:1' },
    protocol: { trades_active: 1, requests_total: 0, requests_open: 0, offers_waiting: 0 },
    trust: { score: 80, tier: 'established', confidence: 'medium', samples: 20,
      components: { verification: 80, insurance: 80, job_outcomes: 80, network_reliability: 80 } },
    outcome: { completed: 5, first_time_resolved: 4, avg_satisfaction: 4.5, disputed: 0 },
    marketplace: { matching_open: 3, my_offers_pending: 0, active_engagements: 1 },
    financial: { receivable_cents: 1000, payable_cents: 0, received_cents: 0, currency: 'usd', payouts_enabled: true, visible: true },
    ...patch,
  };
}

describe('referralFeeCents (must mirror SQL pen_fee_cents)', () => {
  it('rounds half up in integer cents', () => {
    expect(referralFeeCents(10000, 500)).toBe(500);
    expect(referralFeeCents(10001, 500)).toBe(500);
    expect(referralFeeCents(10010, 500)).toBe(501);
    expect(referralFeeCents(1, 2500)).toBe(0);
    expect(referralFeeCents(2, 2500)).toBe(1);
  });
  it('is zero for invalid input', () => {
    expect(referralFeeCents(-1, 500)).toBe(0);
    expect(referralFeeCents(100.5, 500)).toBe(0);
  });
});

describe('money parsing', () => {
  it('accepts plain amounts', () => {
    expect(parseMoneyToCents('450')).toBe(45000);
    expect(parseMoneyToCents('1,250.50')).toBe(125050);
    expect(parseMoneyToCents('0.01')).toBe(1);
  });
  it('rejects junk and out-of-range', () => {
    for (const bad of ['', 'abc', '-5', '0', '1.234', '1e3', '1000000000']) expect(parseMoneyToCents(bad)).toBeNull();
  });
  it('formats basis points', () => {
    expect(formatBps(500)).toBe('5%');
    expect(formatBps(725)).toBe('7.25%');
  });
});

describe('contact info + regions', () => {
  it('flags e-mail and phone numbers but not dates or short numbers', () => {
    expect(containsContactInfo('call me at 555-123-4567')).toBe(true);
    expect(containsContactInfo('mail bob@example.com')).toBe(true);
    expect(containsContactInfo('+1 (415) 555 0100')).toBe(true);
    expect(containsContactInfo('Install date 2026-10-07, unit 3 tons')).toBe(false);
    expect(containsContactInfo('Condenser fan motor failed on 5-ton unit')).toBe(false);
  });
  it('validates and parses regions', () => {
    expect(isValidRegion('US')).toBe(true);
    expect(isValidRegion('US-TX')).toBe(true);
    expect(isValidRegion('us-tx')).toBe(false);
    expect(isValidRegion('USA')).toBe(false);
    expect(parseRegions('us, us-tx; GB  us')).toEqual(['US', 'US-TX', 'GB']);
  });
});

describe('draft validation', () => {
  const ok = { trade: 'hvac', category: 'repair', urgency: 'standard' as const, region: 'US-TX',
    summary: 'Compressor not starting on a 4 ton split system', budget: '800', expiresHours: 72 };
  it('accepts a good request', () => expect(validateRequestDraft(ok, hvac)).toEqual({}));
  it('catches protocol, region, summary and contact problems', () => {
    const e = validateRequestDraft({ ...ok, category: 'roof', region: 'texas', summary: 'call 555 123 4567 now please' }, hvac);
    expect(Object.keys(e).sort()).toEqual(['category', 'region', 'summary']);
  });
  it('validates offers', () => {
    expect(validateOfferDraft({ price: '500', etaHours: '4', message: '' })).toEqual({});
    expect(Object.keys(validateOfferDraft({ price: 'x', etaHours: '-1', message: 'a@b.co' })).sort())
      .toEqual(['etaHours', 'message', 'price']);
  });
});

describe('rails', () => {
  it('shows everything off before joining', () => {
    const rails = deriveRails(overview({ node: null }));
    expect(rails.every((r) => r.level === 'off')).toBe(true);
    expect(networkReadiness(rails)).toBe(0);
  });
  it('goes fully live only when the data says so', () => {
    expect(networkReadiness(deriveRails(overview()))).toBe(100);
  });
  it('downgrades honestly', () => {
    const rails = deriveRails(overview({
      identity: { technicians: 4, technicians_identified: 1, sites: 0, sites_identified: 0, business_network_id: 'x' },
      trust: { score: 40, tier: 'unproven', confidence: 'low', samples: 1,
        components: { verification: 0, insurance: 0, job_outcomes: 80, network_reliability: 80 } },
    }));
    expect(rails.find((r) => r.rail === 'identity')?.level).toBe('partial');
    expect(rails.find((r) => r.rail === 'trust')?.level).toBe('partial');
  });
});

describe('offer ranking', () => {
  const base = { currency: 'usd' as const, message: null, referral_fee_bps: 0, created_at: '2027-01-01T00:00:00Z' };
  const trust = (score: number, tier: PenOffer['provider_trust']['tier'] = 'established') => ({
    score, tier, confidence: 'high' as const, samples: 99,
    components: { verification: score, insurance: score, job_outcomes: score, network_reliability: score } });
  const offers: PenOffer[] = [
    { ...base, id: 'cheap', price_cents: 40000, eta_hours: 24, provider_handle: 'a', provider_trust: trust(55, 'emerging') },
    { ...base, id: 'fast', price_cents: 60000, eta_hours: 2, provider_handle: 'b', provider_trust: trust(70) },
    { ...base, id: 'best', price_cents: 45000, eta_hours: 6, provider_handle: 'c', provider_trust: trust(92, 'trusted') },
    { ...base, id: 'flagged', price_cents: 30000, eta_hours: 1, provider_handle: 'd', provider_trust: trust(99, 'attention') },
  ];
  it('ranks balanced value first and never badges a flagged provider as most trusted', () => {
    const ranked = rankOffers(offers);
    expect(ranked[0].id).toBe('best');
    expect(ranked.find((o) => o.id === 'flagged')!.badges).not.toContain('Most trusted');
    expect(ranked.find((o) => o.id === 'best')!.badges).toContain('Most trusted');
  });
  it('handles empty input', () => expect(rankOffers([])).toEqual([]));
});

describe('misc', () => {
  it('timeLeft', () => {
    const now = Date.parse('2027-01-01T00:00:00Z');
    expect(timeLeft('2027-01-03T12:00:00Z', now)).toBe('2d left');
    expect(timeLeft('2027-01-01T05:00:00Z', now)).toBe('5h left');
    expect(timeLeft('2027-01-01T00:20:00Z', now)).toBe('20m left');
    expect(timeLeft('2026-12-31T00:00:00Z', now)).toBe('expired');
  });
  it('sha256Hex matches the known digest of "abc"', async () => {
    const buf = new TextEncoder().encode('abc');
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    expect(await sha256Hex(ab)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
