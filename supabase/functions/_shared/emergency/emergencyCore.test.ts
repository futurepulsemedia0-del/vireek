import { describe, it, expect } from 'vitest';
import {
  customerMessage,
  decideRoute,
  estimateEta,
  explainNoTechnician,
  firstName,
  formatEta,
  haversineMiles,
  localHour,
  rankTechnicians,
  safetyText,
  slaState,
  technicianBrief,
  trafficProfile,
  type TechInput,
} from './emergencyCore';

const SITE = { lat: 40.7128, lon: -74.006 }; // New York

function tech(over: Partial<TechInput> = {}): TechInput {
  return {
    id: 't1',
    name: 'Alex Rivera',
    skills: ['plumbing'],
    maxJobsPerDay: 6,
    jobsToday: 0,
    busyNow: false,
    lat: 40.73,
    lon: -73.99,
    locationFresh: true,
    partsRequired: 0,
    partsOnVan: 0,
    ...over,
  };
}

describe('haversineMiles', () => {
  it('is ~0 for identical points and ~2,450 miles New York to Los Angeles', () => {
    expect(haversineMiles(1, 1, 1, 1)).toBeCloseTo(0, 5);
    const d = haversineMiles(40.7128, -74.006, 34.0522, -118.2437);
    expect(d).toBeGreaterThan(2400);
    expect(d).toBeLessThan(2500);
  });
});

describe('localHour', () => {
  it('uses the given timezone', () => {
    const d = new Date('2026-09-01T06:13:00Z'); // 02:13 in New York (EDT)
    expect(localHour(d, 'America/New_York')).toBe(2);
  });
  it('falls back to UTC for an invalid timezone or none', () => {
    const d = new Date('2026-09-01T06:13:00Z');
    expect(localHour(d, 'Not/AZone')).toBe(6);
    expect(localHour(d, null)).toBe(6);
  });
});

describe('trafficProfile', () => {
  it('is fast at night, slow at rush hour', () => {
    expect(trafficProfile(2).label).toBe('night');
    expect(trafficProfile(8).label).toBe('rush_hour');
    expect(trafficProfile(17).label).toBe('rush_hour');
    expect(trafficProfile(13).label).toBe('daytime');
    expect(trafficProfile(2).speedMph).toBeGreaterThan(trafficProfile(8).speedMph);
  });
});

describe('estimateEta', () => {
  it('rounds up to 5 minutes and never goes below 5', () => {
    expect(estimateEta({ distanceMiles: 0, hour: 13, busyNow: false }).minutes).toBe(5);
    expect(estimateEta({ distanceMiles: 3, hour: 13, busyNow: false }).minutes % 5).toBe(0);
  });
  it('is slower at rush hour than at night for the same distance', () => {
    const night = estimateEta({ distanceMiles: 10, hour: 2, busyNow: false }).minutes;
    const rush = estimateEta({ distanceMiles: 10, hour: 8, busyNow: false }).minutes;
    expect(rush).toBeGreaterThan(night);
  });
  it('adds a penalty when the technician is busy and flags an unknown location', () => {
    const free = estimateEta({ distanceMiles: 5, hour: 13, busyNow: false });
    const busy = estimateEta({ distanceMiles: 5, hour: 13, busyNow: true });
    expect(busy.minutes - free.minutes).toBeGreaterThanOrEqual(35);
    const unknown = estimateEta({ distanceMiles: null, hour: 13, busyNow: false });
    expect(unknown.basis.location_known).toBe(false);
    expect(unknown.minutes).toBeGreaterThan(5);
  });
});

describe('formatEta', () => {
  it('formats minutes and hours', () => {
    expect(formatEta(25)).toBe('about 25 minutes');
    expect(formatEta(60)).toBe('about 1 hour');
    expect(formatEta(120)).toBe('about 2 hours');
    expect(formatEta(70)).toBe('about 1 hr 10 min');
  });
});

describe('rankTechnicians', () => {
  const base = { trade: 'plumbing' as const, site: SITE, hour: 2, maxInternalEtaMinutes: 45 };

  it('excludes technicians without the skill or at capacity, with reasons', () => {
    const r = rankTechnicians({
      ...base,
      techs: [tech({ id: 'a' }), tech({ id: 'b', skills: ['hvac'] }), tech({ id: 'c', jobsToday: 6, maxJobsPerDay: 6 })],
    });
    expect(r.ranked.map((x) => x.id)).toEqual(['a']);
    expect(r.excluded).toEqual(
      expect.arrayContaining([
        { id: 'b', name: 'Alex Rivera', reason: 'no_matching_skill' },
        { id: 'c', name: 'Alex Rivera', reason: 'at_capacity' },
      ]),
    );
  });

  it('prefers the nearer technician, all else equal', () => {
    const r = rankTechnicians({
      ...base,
      techs: [tech({ id: 'far', lat: 41.5, lon: -73.5 }), tech({ id: 'near', lat: 40.72, lon: -74.0 })],
    });
    expect(r.ranked[0].id).toBe('near');
    expect(r.ranked[0].etaMinutes).toBeLessThan(r.ranked[1].etaMinutes);
  });

  it('prefers a van that already carries the parts', () => {
    const r = rankTechnicians({
      ...base,
      techs: [
        tech({ id: 'noparts', partsRequired: 4, partsOnVan: 0 }),
        tech({ id: 'stocked', partsRequired: 4, partsOnVan: 4 }),
      ],
    });
    expect(r.ranked[0].id).toBe('stocked');
  });

  it('penalises a technician who is currently busy', () => {
    const r = rankTechnicians({ ...base, techs: [tech({ id: 'busy', busyNow: true }), tech({ id: 'free' })] });
    expect(r.ranked[0].id).toBe('free');
  });

  it('keeps the score within 0-100 and is deterministic', () => {
    const techs = [tech({ id: 'b' }), tech({ id: 'a' })];
    const one = rankTechnicians({ ...base, techs });
    const two = rankTechnicians({ ...base, techs: [...techs].reverse() });
    expect(one.ranked.map((x) => x.id)).toEqual(two.ranked.map((x) => x.id));
    for (const x of one.ranked) {
      expect(x.score).toBeGreaterThanOrEqual(0);
      expect(x.score).toBeLessThanOrEqual(100);
    }
  });

  it('accepts any technician for a general trade', () => {
    const r = rankTechnicians({ ...base, trade: 'general', techs: [tech({ skills: [] })] });
    expect(r.ranked).toHaveLength(1);
  });

  it('copes with unknown positions', () => {
    const r = rankTechnicians({ ...base, techs: [tech({ lat: null, lon: null })] });
    expect(r.ranked[0].etaBasis.location_known).toBe(false);
    expect(r.ranked[0].breakdown.location).toBe(0);
  });
});

describe('decideRoute — "no technician available" is not "no service available"', () => {
  const member = { member: true, rejected: false, alreadyTried: false };

  it('dispatches internally when the best ETA is within the limit', () => {
    const ranking = rankTechnicians({ trade: 'plumbing', site: SITE, hour: 2, maxInternalEtaMinutes: 45, techs: [tech({ lat: 40.72, lon: -74.0 })] });
    const d = decideRoute({ ranking, autoDispatch: true, maxInternalEtaMinutes: 45, network: member });
    expect(d.route).toBe('internal');
    expect(d.candidate?.id).toBe('t1');
  });

  it('goes to the network when nobody is available', () => {
    const ranking = rankTechnicians({ trade: 'plumbing', site: SITE, hour: 2, maxInternalEtaMinutes: 45, techs: [tech({ skills: ['hvac'] })] });
    const d = decideRoute({ ranking, autoDispatch: true, maxInternalEtaMinutes: 45, network: member });
    expect(d.route).toBe('network');
    expect(d.reason).toMatch(/lack/);
  });

  it('goes to the network when our best ETA is too slow', () => {
    const ranking = rankTechnicians({ trade: 'plumbing', site: SITE, hour: 8, maxInternalEtaMinutes: 20, techs: [tech({ lat: 41.4, lon: -73.6 })] });
    const d = decideRoute({ ranking, autoDispatch: true, maxInternalEtaMinutes: 20, network: member });
    expect(d.route).toBe('network');
    expect(d.candidate).not.toBeNull();
  });

  it('falls back to our best technician (late) when the network cannot help', () => {
    const ranking = rankTechnicians({ trade: 'plumbing', site: SITE, hour: 8, maxInternalEtaMinutes: 20, techs: [tech({ lat: 41.4, lon: -73.6 })] });
    for (const network of [
      { member: false, rejected: false, alreadyTried: false },
      { member: true, rejected: true, alreadyTried: false },
      { member: true, rejected: false, alreadyTried: true },
    ]) {
      const d = decideRoute({ ranking, autoDispatch: true, maxInternalEtaMinutes: 20, network });
      expect(d.route).toBe('internal_late');
    }
  });

  it('needs a person when there is no technician and no network', () => {
    const ranking = rankTechnicians({ trade: 'plumbing', site: SITE, hour: 2, maxInternalEtaMinutes: 45, techs: [] });
    const d = decideRoute({ ranking, autoDispatch: true, maxInternalEtaMinutes: 45, network: { member: false, rejected: false, alreadyTried: false } });
    expect(d.route).toBe('needs_human');
    expect(d.reason).toMatch(/no dispatch-enabled technician/i);
  });

  it('never acts when automatic dispatch is off', () => {
    const ranking = rankTechnicians({ trade: 'plumbing', site: SITE, hour: 2, maxInternalEtaMinutes: 45, techs: [tech()] });
    const d = decideRoute({ ranking, autoDispatch: false, maxInternalEtaMinutes: 45, network: member });
    expect(d.route).toBe('needs_human');
  });
});

describe('explainNoTechnician', () => {
  it('describes capacity and skill gaps', () => {
    const text = explainNoTechnician([
      { id: 'a', name: null, reason: 'at_capacity' },
      { id: 'b', name: null, reason: 'no_matching_skill' },
      { id: 'c', name: null, reason: 'no_matching_skill' },
    ]);
    expect(text).toContain('1 technician is at daily capacity');
    expect(text).toContain('2 lack the required skill');
  });
});

describe('slaState', () => {
  const now = new Date('2026-09-01T02:13:00Z');
  it('is ok, at_risk, then breached', () => {
    expect(slaState(now, new Date(now.getTime() + 50 * 60000), 60).state).toBe('ok');
    expect(slaState(now, new Date(now.getTime() + 10 * 60000), 60).state).toBe('at_risk');
    expect(slaState(now, new Date(now.getTime() - 60000), 60).state).toBe('breached');
  });
});

describe('messages', () => {
  it('uses fixed life-safety text for hazards and none otherwise', () => {
    expect(safetyText(['gas'])).toContain('leave the building');
    expect(safetyText(['other'])).toBeNull();
    expect(safetyText(['gas', 'smoke', 'water'])!.split('. ').length).toBeGreaterThan(1);
  });

  it('builds the assigned message with the ETA labelled as an estimate', () => {
    const m = customerMessage('assigned', { businessName: 'Acme Plumbing', technicianName: 'Alex Rivera', etaMinutes: 25, hazards: ['water'] });
    expect(m).toContain('Alex');
    expect(m).toContain('about 25 minutes');
    expect(m).toContain('an estimate');
    expect(m).toContain('main water valve');
  });

  it('tells the customer honestly when a partner is used', () => {
    const search = customerMessage('partner_search', { businessName: 'Acme' });
    expect(search).toContain('fully booked');
    const found = customerMessage('partner_found', { businessName: 'Acme', partnerName: 'Rapid Pipes', partnerPhone: '+15551234567' });
    expect(found).toContain('Rapid Pipes');
    expect(found).toContain('+15551234567');
  });

  it('keeps SMS bodies short enough', () => {
    const m = customerMessage('assigned', { businessName: 'Acme', technicianName: 'A', etaMinutes: 25, hazards: ['gas', 'smoke'], trackingUrl: 'https://app.vireek.com/track/abc' });
    expect(m.length).toBeLessThan(700);
  });

  it('builds a technician brief with missing parts and insurance reminder', () => {
    const b = technicianBrief({
      customerName: 'Jane',
      customerPhone: '+1555',
      address: '1 Main St',
      description: 'Burst pipe in basement',
      hazards: ['water'],
      tier: 'critical',
      etaMinutes: 25,
      missingParts: ['3/4 coupling', 'PEX crimp ring'],
      insuranceInvolved: true,
    });
    expect(b).toContain('CRITICAL');
    expect(b).toContain('3/4 coupling');
    expect(b).toContain('photograph');
  });

  it('extracts a first name safely', () => {
    expect(firstName('Alex Rivera')).toBe('Alex');
    expect(firstName('  ')).toBe('your technician');
    expect(firstName(null)).toBe('your technician');
  });
});
