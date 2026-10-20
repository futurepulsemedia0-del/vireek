import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  EXPORT_COLUMNS,
  LEAK_REPAIR_DEADLINE_DAYS,
  certTypeFromCredential,
  checkTechnicianCertification,
  co2eMetricTons,
  computeLeakRate,
  friendlyError,
  isCredentialCurrent,
  isRefrigerantJob,
  normalizeRefrigerant,
  retentionUntil,
  totalsFor,
  validateEntry,
  type CredentialLike,
  type RefrigerantEntry,
} from '@/lib/refrigerantCompliance';

const NOW = new Date('2026-10-18T12:00:00Z');

const cred = (over: Partial<CredentialLike> = {}): CredentialLike => ({
  id: 'c1',
  technician_id: 't1',
  credential_type: 'epa_608_universal',
  credential_number: 'EPA-123',
  status: 'active',
  expires_at: null,
  ...over,
});

const add = (id: string, lbs: number, iso: string) => ({
  id,
  event_type: 'added' as const,
  pounds: lbs,
  performed_at: iso,
  voided_at: null,
});

describe('isRefrigerantJob / normalizeRefrigerant', () => {
  it('detects HVAC / refrigeration service types', () => {
    for (const s of [
      'HVAC repair',
      'AC tune-up',
      'Heat pump install',
      'Walk-in cooler',
      'Mini split',
      'Refrigeration',
    ]) {
      expect(isRefrigerantJob(s)).toBe(true);
    }
    for (const s of ['Plumbing', 'Electrical panel', 'Roof repair', '', null, undefined]) {
      expect(isRefrigerantJob(s)).toBe(false);
    }
  });

  it('normalises refrigerant codes and leaves unknown ones trimmed', () => {
    expect(normalizeRefrigerant('r410a')).toBe('R-410A');
    expect(normalizeRefrigerant(' R 134A ')).toBe('R-134a');
    expect(normalizeRefrigerant('  XYZ-9 ')).toBe('XYZ-9');
  });
});

describe('checkTechnicianCertification', () => {
  it('blocks when no technician is chosen or no cert exists', () => {
    expect(checkTechnicianCertification([cred()], null).ok).toBe(false);
    const r = checkTechnicianCertification([], 't1', { onDate: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/No EPA 608/);
  });

  it('accepts a valid universal certification', () => {
    const r = checkTechnicianCertification([cred()], 't1', { onDate: NOW });
    expect(r.ok).toBe(true);
    expect(r.certType).toBe('universal');
    expect(r.warnings).toEqual([]);
  });

  it('ignores other technicians and non-EPA credentials', () => {
    const r = checkTechnicianCertification(
      [cred({ technician_id: 't2' }), cred({ credential_type: 'gas_fitter' })],
      't1',
      { onDate: NOW },
    );
    expect(r.ok).toBe(false);
  });

  it('rejects expired, revoked and pending-renewal credentials, but accepts expiry on the day of work', () => {
    expect(
      checkTechnicianCertification([cred({ expires_at: '2026-10-17' })], 't1', { onDate: NOW }).ok,
    ).toBe(false);
    expect(
      checkTechnicianCertification([cred({ expires_at: '2026-10-18' })], 't1', { onDate: NOW }).ok,
    ).toBe(true);
    expect(
      checkTechnicianCertification([cred({ status: 'revoked' })], 't1', { onDate: NOW }).ok,
    ).toBe(false);
    expect(
      checkTechnicianCertification([cred({ status: 'pending_renewal' })], 't1', { onDate: NOW })
        .reason,
    ).toMatch(/expired, revoked/);
  });

  it('judges the certification on the date of work, not today', () => {
    const c = cred({ expires_at: '2026-06-01' });
    expect(
      checkTechnicianCertification([c], 't1', { onDate: new Date('2026-05-30T10:00:00Z') }).ok,
    ).toBe(true);
    expect(
      checkTechnicianCertification([c], 't1', { onDate: new Date('2026-06-02T10:00:00Z') }).ok,
    ).toBe(false);
  });

  it('limits Type I to small appliances (<= 5 lb)', () => {
    const typeI = cred({ credential_type: 'epa_608_type_i' });
    expect(checkTechnicianCertification([typeI], 't1', { chargeLbs: 4, onDate: NOW }).ok).toBe(
      true,
    );
    const big = checkTechnicianCertification([typeI], 't1', { chargeLbs: 12, onDate: NOW });
    expect(big.ok).toBe(false);
    expect(big.reason).toMatch(/Type I certification only covers/);
    const unknown = checkTechnicianCertification([typeI], 't1', { onDate: NOW });
    expect(unknown.ok).toBe(true);
    expect(unknown.warnings.join(' ')).toMatch(/charge is unknown/);
  });

  it('prefers the broadest certification when several are held', () => {
    const r = checkTechnicianCertification(
      [
        cred({ id: 'a', credential_type: 'epa_608_type_i' }),
        cred({ id: 'b', credential_type: 'epa_608_universal' }),
      ],
      't1',
      { chargeLbs: 3, onDate: NOW },
    );
    expect(r.credential?.id).toBe('b');
  });

  it('warns for legacy "epa_608" credentials without a type', () => {
    const r = checkTechnicianCertification([cred({ credential_type: 'epa_608' })], 't1', {
      onDate: NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.certType).toBe('unspecified');
    expect(r.warnings[0]).toMatch(/not recorded/);
  });

  it('maps credential codes to cert types', () => {
    expect(certTypeFromCredential('epa_608_type_ii')).toBe('type_ii');
    expect(certTypeFromCredential('forklift')).toBeNull();
    expect(isCredentialCurrent(cred({ expires_at: '2026-10-18T00:00:00Z' }), NOW)).toBe(true);
  });
});

describe('validateEntry', () => {
  const ok = {
    job_id: 'j',
    equipment_id: 'e',
    technician_id: 't',
    event_type: 'added' as const,
    refrigerant_type: 'R-410A',
    pounds: 2.5,
  };

  it('accepts a complete entry', () => {
    expect(validateEntry(ok, NOW)).toEqual([]);
  });

  it('rejects missing links, bad pounds, and missing disposition on recovery', () => {
    expect(validateEntry({}, NOW).length).toBeGreaterThanOrEqual(5);
    expect(validateEntry({ ...ok, pounds: 0 }, NOW)).toContain('Pounds must be greater than 0.');
    expect(validateEntry({ ...ok, pounds: NaN }, NOW)).toContain('Pounds must be greater than 0.');
    expect(validateEntry({ ...ok, pounds: -1 }, NOW)).toContain('Pounds must be greater than 0.');
    expect(validateEntry({ ...ok, pounds: 1.234 }, NOW)).toContain(
      'Pounds can have at most 2 decimal places.',
    );
    expect(validateEntry({ ...ok, pounds: 100_000 }, NOW).join()).toMatch(/cannot exceed/);
    expect(validateEntry({ ...ok, event_type: 'recovered' }, NOW)).toContain(
      'Say where the recovered refrigerant went.',
    );
    expect(
      validateEntry({ ...ok, event_type: 'recovered', disposition: 'destroyed' }, NOW),
    ).toEqual([]);
  });

  it('allows float-sum quantities like 0.1 + 0.2 and rejects future dates', () => {
    expect(validateEntry({ ...ok, pounds: 0.1 + 0.2 }, NOW)).toEqual([]);
    expect(validateEntry({ ...ok, performed_at: '2026-10-19T12:00:00Z' }, NOW)).toContain(
      'Date and time of work cannot be in the future.',
    );
    expect(validateEntry({ ...ok, performed_at: 'nope' }, NOW)).toContain(
      'Date and time of work is invalid.',
    );
  });
});

describe('computeLeakRate', () => {
  it('annualises the latest addition (method 1)', () => {
    // 5 lb on a 50 lb charge, 73 days after the previous addition -> 10% x 365/73 = 50%.
    const r = computeLeakRate({
      entries: [add('a', 1, '2026-06-01T00:00:00Z'), add('b', 5, '2026-08-13T00:00:00Z')],
      fullChargeLbs: 50,
      category: 'commercial_refrigeration',
      asOf: NOW,
    });
    expect(r.daysSincePreviousAddition).toBe(73);
    expect(r.annualizedPct).toBe(50);
    expect(r.rollingPct).toBe(12);
    expect(r.ratePct).toBe(50);
    expect(r.threshold).toBe(20);
    expect(r.exceeds).toBe(true);
    expect(r.state).toBe('exceeds');
    expect(r.covered).toBe(true);
    const due = new Date(r.repairDeadline!).getTime() - new Date('2026-08-13T00:00:00Z').getTime();
    expect(due).toBe(LEAK_REPAIR_DEADLINE_DAYS * 86_400_000);
  });

  it('uses the rolling 365-day sum (method 2) and ignores older / voided / recovered entries', () => {
    const r = computeLeakRate({
      entries: [
        add('old', 40, '2025-01-01T00:00:00Z'),
        { ...add('void', 30, '2026-09-01T00:00:00Z'), voided_at: '2026-09-02T00:00:00Z' },
        {
          id: 'rec',
          event_type: 'recovered',
          pounds: 20,
          performed_at: '2026-09-03T00:00:00Z',
          voided_at: null,
        },
        add('in', 3, '2026-03-01T00:00:00Z'),
      ],
      fullChargeLbs: 100,
      category: 'comfort_cooling',
      asOf: NOW,
    });
    expect(r.poundsAdded365).toBe(3);
    expect(r.rollingPct).toBe(3);
  });

  it('is within limits for a healthy unit', () => {
    const r = computeLeakRate({
      entries: [add('a', 1, '2025-11-01T00:00:00Z')],
      fullChargeLbs: 100,
      category: 'comfort_cooling',
      asOf: NOW,
    });
    expect(r.state).toBe('ok');
    expect(r.exceeds).toBe(false);
    expect(r.repairDeadline).toBeNull();
  });

  it('is unknown without a charge, and uses a baseline date for a first addition', () => {
    expect(
      computeLeakRate({
        entries: [add('a', 2, '2026-05-01T00:00:00Z')],
        fullChargeLbs: null,
        asOf: NOW,
      }).state,
    ).toBe('unknown');
    expect(computeLeakRate({ entries: [], fullChargeLbs: 40, asOf: NOW }).state).toBe('ok');
    const r = computeLeakRate({
      entries: [add('a', 4, '2026-04-01T00:00:00Z')],
      fullChargeLbs: 40,
      baselineDate: '2026-01-01T00:00:00Z',
      category: 'comfort_cooling',
      asOf: NOW,
    });
    expect(r.daysSincePreviousAddition).toBe(90);
    expect(r.annualizedPct).toBe(40.6);
  });

  it('never divides by zero for same-day additions and flags units under 15 lb as not covered', () => {
    const r = computeLeakRate({
      entries: [add('a', 1, '2026-10-01T00:00:00Z'), add('b', 1, '2026-10-01T06:00:00Z')],
      fullChargeLbs: 10,
      asOf: NOW,
    });
    expect(r.daysSincePreviousAddition).toBe(1);
    expect(Number.isFinite(r.ratePct)).toBe(true);
    expect(r.covered).toBe(false);
  });

  it('ignores additions dated after asOf', () => {
    const r = computeLeakRate({
      entries: [add('f', 9, '2027-01-01T00:00:00Z')],
      fullChargeLbs: 10,
      asOf: NOW,
    });
    expect(r.poundsAdded365).toBe(0);
  });
});

describe('totals, CO2e, retention, errors', () => {
  it('totals skip voided entries and round to 2 decimals', () => {
    const t = totalsFor([
      { event_type: 'added', pounds: 0.1, voided_at: null },
      { event_type: 'added', pounds: 0.2, voided_at: null },
      { event_type: 'recovered', pounds: 1.01, voided_at: null },
      { event_type: 'added', pounds: 50, voided_at: '2026-01-01T00:00:00Z' },
    ]);
    expect(t).toEqual({ added: 0.3, recovered: 1.01, net: -0.71, entries: 3 });
  });

  it('converts pounds to CO2e metric tons', () => {
    expect(co2eMetricTons('r410a', 100)).toBe(94.71);
    expect(co2eMetricTons('R-717', 100)).toBe(0);
    expect(co2eMetricTons('mystery', 100)).toBeNull();
  });

  it('retains records for three years', () => {
    expect(retentionUntil('2026-10-18T12:00:00Z')).toBe('2029-10-18');
  });

  it('maps server errors to readable messages', () => {
    expect(
      friendlyError(
        'refrigerant_cert_required: Sam has no valid EPA 608 certification on file for this work',
      ),
    ).toBe('Sam has no valid EPA 608 certification on file for this work');
    expect(friendlyError('refrigerant_log entries are immutable; void the entry instead')).toMatch(
      /Void the entry/,
    );
    expect(friendlyError('boom')).toBe('boom');
  });
});

describe('compliance CSV export', () => {
  const entry: RefrigerantEntry = {
    id: 'e1',
    job_id: 'j1',
    equipment_id: 'u1',
    technician_id: 't1',
    event_type: 'recovered',
    refrigerant_type: 'R-410A',
    pounds: 12.5,
    performed_at: '2026-10-18T12:00:00Z',
    cylinder_ref: 'CYL-9',
    disposition: 'sent_to_reclaimer',
    leak_found: true,
    leak_repaired: null,
    notes: 'Said "hi", then left',
    equipment_label: 'Carrier 24ACC',
    equipment_serial: 'SN1',
    site_address: '1 Main St',
    technician_name: 'Sam',
    cert_type: 'epa_608_universal',
    cert_number: 'EPA-123',
    voided_at: null,
    void_reason: null,
    created_at: '2026-10-18T12:00:01Z',
  };
  const row = (e: RefrigerantEntry) =>
    Object.fromEntries(EXPORT_COLUMNS.map((c) => [c.header, c.accessor(e)]));

  it('has unique headers and exports every audit-relevant field', () => {
    const headers = EXPORT_COLUMNS.map((c) => c.header);
    expect(new Set(headers).size).toBe(headers.length);
    const r = row(entry);
    expect(r['Event']).toBe('Recovered');
    expect(r['Pounds']).toBe('12.50');
    expect(r['EPA 608 type']).toBe('Universal');
    expect(r['EPA 608 certificate #']).toBe('EPA-123');
    expect(r['Disposition']).toBe('Sent to reclaimer');
    expect(r['Leak found']).toBe('Yes');
    expect(r['Leak repaired']).toBe('');
    expect(r['Retain until']).toBe('2029-10-18');
    expect(r['Status']).toBe('Active');
    expect(r['CO2e (metric tons)']).toBe(11.839);
  });

  it('keeps voided rows in the export, flagged with their reason', () => {
    const r = row({ ...entry, voided_at: '2026-10-19T00:00:00Z', void_reason: 'Wrong unit' });
    expect(r['Status']).toBe('VOIDED');
    expect(r['Void reason']).toBe('Wrong unit');
  });
});
