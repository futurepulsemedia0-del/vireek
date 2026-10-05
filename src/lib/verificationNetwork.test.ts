// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  canonicalJson,
  decisionFromManual,
  evaluateInsurancePolicy,
  evaluateLicenseRecords,
  inferJurisdiction,
  isValidJurisdiction,
  licenseNumberCandidates,
  nameMatchScore,
  nextCheckAt,
  normalizeLicenseNumber,
  parseDate,
  sealEvidence,
  type NormalizedRecord,
  type PolicyInput,
} from '../../supabase/functions/_shared/verification-network/engine';
import {
  buildSocrataUrl,
  normalizeSocrataRow,
  querySocrata,
  validateSocrataConfig,
  type FetchLike,
  type SocrataConfig,
} from '../../supabase/functions/_shared/verification-network/socrata';
import {
  combinedTrustScore,
  pickCheck,
  reasonText,
  type VerificationCheck,
} from './verificationNetwork';

const TODAY = '2026-10-04';
const statusMap = {
  active: ['Active'],
  expired: ['Expired'],
  suspended: ['Suspended'],
  revoked: ['Revoked'],
  inactive: ['Inactive'],
};
const rec = (o: Partial<NormalizedRecord> = {}): NormalizedRecord => ({
  licenseNumber: 'TX123456',
  holderName: 'SMITH, JOHN',
  rawStatus: 'Active',
  expiresOn: '2027-03-01',
  classification: 'HVAC',
  disciplinary: false,
  ...o,
});
const ctx = { holderNames: ['John Smith', 'Acme Heating & Air LLC'], today: TODAY, statusMap };

describe('license numbers', () => {
  it('normalises and builds lookup candidates', () => {
    expect(normalizeLicenseNumber(' tx-12 34/5 ')).toBe('TX-12345');
    expect(licenseNumberCandidates('tx-000123')).toEqual(['TX-000123', 'TX000123']);
    expect(licenseNumberCandidates('000123')).toEqual(['000123', '123']);
    expect(licenseNumberCandidates('')).toEqual([]);
    expect(normalizeLicenseNumber(42)).toBe('');
  });
});

describe('name matching', () => {
  it('is order independent and ignores company suffixes', () => {
    expect(nameMatchScore('SMITH, JOHN', 'John Smith')).toBe(1);
    expect(nameMatchScore('Acme Heating & Air, LLC', 'ACME HEATING AND AIR INC')).toBe(1);
  });
  it('tolerates a middle name and a one-letter typo in long tokens', () => {
    expect(nameMatchScore('John Michael Smith', 'John Smith')).toBeGreaterThanOrEqual(0.67);
    expect(nameMatchScore('Johnson Smith', 'Johnsen Smith')).toBeGreaterThanOrEqual(0.67);
  });
  it('rejects a different person sharing one name', () => {
    expect(nameMatchScore('John Doe', 'John Smith')).toBeLessThan(0.67);
    expect(nameMatchScore('', 'John Smith')).toBe(0);
  });
});

describe('jurisdiction inference', () => {
  it('reads full names, codes, and prefers longest names', () => {
    expect(inferJurisdiction('Texas Department of Licensing')).toBe('US-TX');
    expect(inferJurisdiction('West Virginia Division of Labor')).toBe('US-WV');
    expect(inferJurisdiction('State of New York')).toBe('US-NY');
    expect(inferJurisdiction('CSLB CA')).toBe('US-CA');
    expect(inferJurisdiction('us-fl')).toBe('US-FL');
  });
  it('refuses ambiguous input instead of guessing', () => {
    expect(inferJurisdiction('Texas and Florida joint board')).toBeNull();
    expect(inferJurisdiction('Board for HVAC licence in town')).toBeNull();
    expect(inferJurisdiction('Master license IN good standing')).toBeNull(); // "IN" is an English word
    expect(inferJurisdiction('')).toBeNull();
    expect(isValidJurisdiction('US-ZZ')).toBe(false);
    expect(isValidJurisdiction('US-TX')).toBe(true);
  });
});

describe('dates', () => {
  it('parses ISO and US formats and rejects impossible dates', () => {
    expect(parseDate('2027-03-01T00:00:00.000')).toBe('2027-03-01');
    expect(parseDate('3/1/2027')).toBe('2027-03-01');
    expect(parseDate('02/30/2027')).toBeNull();
    expect(parseDate('soon')).toBeNull();
  });
});

describe('licence evaluation', () => {
  it('verifies an active, matching, in-date record at the primary source', () => {
    const d = evaluateLicenseRecords([rec()], ctx);
    expect(d.status).toBe('verified_primary');
    expect(d.method).toBe('primary_source_api');
    expect(d.nameMatchScore).toBe(1);
  });
  it('accepts a licence issued to the company', () => {
    expect(
      evaluateLicenseRecords([rec({ holderName: 'ACME HEATING AND AIR LLC' })], ctx).status,
    ).toBe('verified_primary');
  });
  it('never verifies an identity mismatch', () => {
    const d = evaluateLicenseRecords([rec({ holderName: 'DOE, JANE' })], ctx);
    expect(d.status).toBe('needs_review');
    expect(d.reason).toBe('name_mismatch');
  });
  it('treats a lapsed expiry date as expired even if the board still says Active', () => {
    const d = evaluateLicenseRecords([rec({ expiresOn: '2026-09-01' })], ctx);
    expect(d.status).toBe('adverse');
    expect(d.reason).toBe('license_expired');
  });
  it('flags suspended and revoked as adverse', () => {
    expect(evaluateLicenseRecords([rec({ rawStatus: 'Suspended' })], ctx).reason).toBe(
      'license_suspended',
    );
    expect(evaluateLicenseRecords([rec({ rawStatus: 'Revoked' })], ctx).status).toBe('adverse');
  });
  it('asks for review when nothing is found or the status is unknown', () => {
    expect(evaluateLicenseRecords([], ctx).reason).toBe('record_not_found');
    expect(evaluateLicenseRecords([rec({ rawStatus: 'Pending' })], ctx).reason).toBe(
      'status_unrecognised',
    );
    expect(evaluateLicenseRecords([rec({ holderName: null })], ctx).reason).toBe(
      'name_unavailable',
    );
  });
  it('picks the best-matching record when several are returned', () => {
    const d = evaluateLicenseRecords(
      [rec({ holderName: 'DOE, JANE', rawStatus: 'Revoked' }), rec()],
      ctx,
    );
    expect(d.status).toBe('verified_primary');
  });
  it('carries a disciplinary flag through while still verified', () => {
    const d = evaluateLicenseRecords([rec({ disciplinary: true })], ctx);
    expect(d.status).toBe('verified_primary');
    expect(d.disciplinaryFlag).toBe(true);
  });
});

describe('insurance evaluation', () => {
  const policy = (o: Partial<PolicyInput> = {}): PolicyInput => ({
    policy_type: 'general_liability',
    carrier: 'Acme Mutual',
    status: 'active',
    expires_at: '2027-01-01',
    effective_date: '2026-01-01',
    coverage_amount_cents: 100_000_000,
    verified_at: '2026-09-01T00:00:00Z',
    ...o,
  });
  it('verifies a reviewed, in-date policy that meets the minimum', () => {
    expect(evaluateInsurancePolicy(policy(), TODAY).status).toBe('verified_document');
  });
  it('is adverse when expired, cancelled or under-covered', () => {
    expect(evaluateInsurancePolicy(policy({ expires_at: '2026-10-03' }), TODAY).reason).toBe(
      'policy_expired',
    );
    expect(evaluateInsurancePolicy(policy({ status: 'cancelled' }), TODAY).reason).toBe(
      'policy_cancelled',
    );
    expect(
      evaluateInsurancePolicy(policy({ coverage_amount_cents: 50_000_000 }), TODAY).reason,
    ).toBe('coverage_below_minimum');
  });
  it('needs review when the certificate was never reviewed or cover is unknown', () => {
    expect(evaluateInsurancePolicy(policy({ verified_at: null }), TODAY).reason).toBe(
      'coi_not_reviewed',
    );
    expect(evaluateInsurancePolicy(policy({ coverage_amount_cents: null }), TODAY).reason).toBe(
      'coverage_unknown',
    );
  });
  it('does not enforce a minimum for types without one', () => {
    expect(
      evaluateInsurancePolicy(
        policy({ policy_type: 'workers_comp', coverage_amount_cents: null }),
        TODAY,
      ).status,
    ).toBe('verified_document');
  });
});

describe('manual resolution', () => {
  it('records documented evidence, and refuses to verify something already expired', () => {
    const ok = decisionFromManual(
      { kind: 'license', outcome: 'verified', note: 'Portal screenshot', expiresOn: '2027-05-01' },
      TODAY,
    );
    expect(ok.status).toBe('verified_document');
    expect(ok.method).toBe('document_review');
    const stale = decisionFromManual(
      { kind: 'license', outcome: 'verified', note: 'Old certificate', expiresOn: '2026-01-01' },
      TODAY,
    );
    expect(stale.status).toBe('adverse');
    expect(stale.reason).toBe('manual_expired');
  });
});

describe('scheduling', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  it('re-checks verified results monthly but never later than just after expiry', () => {
    const monthly = nextCheckAt(
      { status: 'verified_primary', expiresOn: '2027-12-01' },
      'license',
      now,
    )!;
    expect(monthly.toISOString().slice(0, 10)).toBe('2026-11-03');
    const soon = nextCheckAt(
      { status: 'verified_primary', expiresOn: '2026-10-10' },
      'license',
      now,
    )!;
    expect(soon.toISOString().slice(0, 10)).toBe('2026-10-11');
  });
  it('retries licences after an adverse finding, backs off on errors, and waits for humans on review', () => {
    expect(nextCheckAt({ status: 'adverse', expiresOn: null }, 'license', now)).not.toBeNull();
    expect(nextCheckAt({ status: 'adverse', expiresOn: null }, 'insurance', now)).toBeNull();
    expect(nextCheckAt({ status: 'needs_review', expiresOn: null }, 'license', now)).toBeNull();
    const first = nextCheckAt({ status: 'error', expiresOn: null }, 'license', now, 1)!;
    const third = nextCheckAt({ status: 'error', expiresOn: null }, 'license', now, 3)!;
    expect(third.getTime()).toBeGreaterThan(first.getTime());
  });
});

describe('evidence seal', () => {
  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }),
    );
  });
  it('changes when the evidence changes and is stable otherwise', async () => {
    const d = evaluateLicenseRecords([rec()], ctx);
    const args = {
      kind: 'license' as const,
      sourceKey: 'tx_board',
      subjectFingerprint: 'abc',
      checkedAt: '2026-10-04T00:00:00Z',
      decision: d,
    };
    const a = await sealEvidence(args);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await sealEvidence(args)).toBe(a);
    const tampered = evaluateLicenseRecords([rec({ rawStatus: 'Suspended' })], ctx);
    expect(await sealEvidence({ ...args, decision: tampered })).not.toBe(a);
  });
});

describe('socrata adapter', () => {
  const cfg: SocrataConfig = {
    domain: 'data.example.gov',
    dataset_id: 'abcd-1234',
    fields: {
      license_number: 'lic_no',
      holder_name: 'name',
      status: 'status',
      expires_on: 'exp',
      classification: 'class',
      disciplinary: 'action',
    },
    status_map: statusMap,
  };
  it('validates configuration and rejects injection-shaped values', () => {
    expect(validateSocrataConfig(cfg).ok).toBe(true);
    expect(validateSocrataConfig({ ...cfg, domain: 'evil.com/../x' }).ok).toBe(false);
    expect(validateSocrataConfig({ ...cfg, dataset_id: 'nope' }).ok).toBe(false);
    expect(
      validateSocrataConfig({ ...cfg, fields: { ...cfg.fields, status: 'status; drop' } }).ok,
    ).toBe(false);
    expect(validateSocrataConfig({ ...cfg, status_map: {} }).ok).toBe(false);
    expect(validateSocrataConfig(null).ok).toBe(false);
  });
  it('builds an escaped, bounded query', () => {
    const url = buildSocrataUrl(cfg, ["A'B", 'TX1']);
    expect(url.startsWith('https://data.example.gov/resource/abcd-1234.json?')).toBe(true);
    expect(decodeURIComponent(url.replace(/\+/g, ' '))).toContain(
      "upper(lic_no) in ('A''B','TX1')",
    );
    expect(url).toContain('%24limit=10');
  });
  it('maps rows and parses the disciplinary flag', () => {
    const r = normalizeSocrataRow(
      {
        lic_no: 'TX1',
        name: 'SMITH, JOHN',
        status: 'Active',
        exp: '03/01/2027',
        class: 'HVAC',
        action: 'Yes',
      },
      cfg,
    );
    expect(r).toMatchObject({ licenseNumber: 'TX1', expiresOn: '2027-03-01', disciplinary: true });
    expect(normalizeSocrataRow({ lic_no: 'TX1' }, cfg).disciplinary).toBeNull();
  });
  it('fetches via the injected client and surfaces failures', async () => {
    const ok: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ lic_no: 'TX1', name: 'J SMITH', status: 'Active' }]),
    });
    expect(await querySocrata(cfg, ['TX1'], ok, 'token')).toHaveLength(1);
    const down: FetchLike = async () => ({ ok: false, status: 503, text: async () => '' });
    await expect(querySocrata(cfg, ['TX1'], down)).rejects.toThrow('503');
    const bad: FetchLike = async () => ({ ok: true, status: 200, text: async () => '{"oops":1}' });
    await expect(querySocrata(cfg, ['TX1'], bad)).rejects.toThrow('unexpected');
    expect(await querySocrata(cfg, [], ok)).toEqual([]);
  });
});

describe('client helpers', () => {
  const check = (o: Partial<VerificationCheck>): VerificationCheck => ({
    id: 'x',
    technician_id: 't',
    kind: 'license',
    subject_key: 'k',
    credential_id: 'c1',
    insurance_policy_id: null,
    jurisdiction: null,
    status: 'verified_primary',
    reason: null,
    method: null,
    license_status: null,
    holder_name: null,
    name_match_score: null,
    classification: null,
    expires_on: null,
    disciplinary_flag: null,
    coverage_cents: null,
    carrier: null,
    evidence_sha256: null,
    checked_at: null,
    next_check_at: null,
    created_at: '2026-10-01T00:00:00Z',
    ...o,
  });
  it('blends the trust score 80/20 and stays null without a track record', () => {
    expect(combinedTrustScore(90, 100)).toBe(92);
    expect(combinedTrustScore(90, 0)).toBe(72);
    expect(combinedTrustScore(null, 100)).toBeNull();
    expect(combinedTrustScore(150, 150)).toBe(100);
  });
  it('shows the newest check for a subject', () => {
    const rows = [
      check({ id: 'old' }),
      check({ id: 'new', created_at: '2026-10-03T00:00:00Z', status: 'pending' }),
      check({ id: 'other', credential_id: 'c2' }),
    ];
    expect(pickCheck(rows, { credentialId: 'c1' })?.id).toBe('new');
    expect(pickCheck(rows, { credentialId: 'zzz' })).toBeNull();
  });
  it('has human text for known reasons and a safe fallback', () => {
    expect(reasonText('matched_active')).toMatch(/Active record/);
    expect(reasonText('some_new_code')).toBe('some new code');
    expect(reasonText(null)).toBe('');
  });
});
