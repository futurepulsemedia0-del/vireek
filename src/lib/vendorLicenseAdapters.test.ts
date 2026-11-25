// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createSocrataAdapter,
  decisionToLicenseCheck,
  manualAdapter,
  resolveAdapter,
} from '../../supabase/functions/_shared/vendor-license/adapters';
import type { FetchLike } from '../../supabase/functions/_shared/verification-network/socrata';

// A made-up board: the config is TEST DATA, not a claim about any real state portal.
const SOURCE = {
  source_key: 'test_board_xx',
  jurisdiction: 'US-FL',
  config: {
    domain: 'data.example.gov',
    dataset_id: 'abcd-1234',
    fields: { license_number: 'lic_no', holder_name: 'holder', status: 'lic_status', expires_on: 'exp' },
    status_map: { active: ['Active'], expired: ['Expired'], suspended: ['Suspended'], revoked: ['Revoked'] },
  },
};
const REQ = { licenseNumber: 'cgc-123456', jurisdiction: 'US-FL', holderNames: ['Sunrise Roofing LLC'], today: '2026-11-24' };

const okFetch = (rows: unknown[]): FetchLike => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(rows) });

describe('manual adapter + resolution', () => {
  it('always asks for the manual workflow', async () => {
    expect(await manualAdapter.lookup(REQ)).toEqual({ kind: 'manual_required', reason: 'no_connector' });
  });
  it('falls back to manual when no connector covers the state', () => {
    const a = createSocrataAdapter(SOURCE, okFetch([]));
    expect(resolveAdapter([a], 'US-FL').key).toBe('test_board_xx');
    expect(resolveAdapter([a], 'US-TX').key).toBe('manual');
    expect(resolveAdapter([], 'US-FL').key).toBe('manual');
  });
});

describe('socrata adapter', () => {
  it('verifies only an active, name-matching, unexpired record', async () => {
    const a = createSocrataAdapter(SOURCE, okFetch([{ lic_no: 'CGC123456', holder: 'SUNRISE ROOFING LLC', lic_status: 'Active', exp: '2027-08-31' }]));
    const out = await a.lookup(REQ);
    expect(out.kind).toBe('result');
    if (out.kind === 'result') {
      expect(out.decision.status).toBe('verified_primary');
      expect(decisionToLicenseCheck(out.decision)).toMatchObject({ license_status: 'active', expires_on: '2027-08-31', needs_review: false });
    }
  });
  it('downgrades an "Active" row whose date has passed', async () => {
    const a = createSocrataAdapter(SOURCE, okFetch([{ lic_no: 'CGC123456', holder: 'Sunrise Roofing LLC', lic_status: 'Active', exp: '2026-01-01' }]));
    const out = await a.lookup(REQ);
    expect(out.kind === 'result' && out.decision.status).toBe('adverse');
  });
  it('sends a record for someone else to review, not to verified', async () => {
    const a = createSocrataAdapter(SOURCE, okFetch([{ lic_no: 'CGC123456', holder: 'Totally Different Plumbing Inc', lic_status: 'Active', exp: '2027-08-31' }]));
    const out = await a.lookup(REQ);
    expect(out.kind === 'result' && out.decision.status).toBe('needs_review');
    if (out.kind === 'result') expect(decisionToLicenseCheck(out.decision).needs_review).toBe(true);
  });
  it('treats "no record" as needs_review', async () => {
    const out = await createSocrataAdapter(SOURCE, okFetch([])).lookup(REQ);
    expect(out.kind === 'result' && out.decision.reason).toBe('record_not_found');
  });
  it('never throws and never verifies when the source fails', async () => {
    const failing: FetchLike = async () => { throw new Error('network down'); };
    const bad: FetchLike = async () => ({ ok: false, status: 503, text: async () => '' });
    const junk: FetchLike = async () => ({ ok: true, status: 200, text: async () => '<html>' });
    for (const f of [failing, bad, junk]) {
      const out = await createSocrataAdapter(SOURCE, f).lookup(REQ);
      expect(out).toMatchObject({ kind: 'manual_required', reason: 'lookup_failed' });
    }
  });
  it('rejects an invalid config, wrong state and empty number without any request', async () => {
    let calls = 0;
    const f: FetchLike = async () => { calls++; return { ok: true, status: 200, text: async () => '[]' }; };
    expect(await createSocrataAdapter({ ...SOURCE, config: { domain: 'x' } }, f).lookup(REQ)).toMatchObject({ reason: 'invalid_config' });
    expect(await createSocrataAdapter(SOURCE, f).lookup({ ...REQ, jurisdiction: 'US-TX' })).toMatchObject({ reason: 'invalid_request' });
    expect(await createSocrataAdapter(SOURCE, f).lookup({ ...REQ, licenseNumber: '  ' })).toMatchObject({ reason: 'invalid_request' });
    expect(calls).toBe(0);
  });
  it('an adapter with an invalid config supports no state', () => {
    expect(createSocrataAdapter({ ...SOURCE, config: {} }, okFetch([])).supports('US-FL')).toBe(false);
  });
});
