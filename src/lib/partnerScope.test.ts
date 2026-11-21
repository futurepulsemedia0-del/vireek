import { describe, expect, it } from 'vitest';
import { NO_PARTNER_SCOPE, parseReferredAccounts, parseScopeContext, scopeErrorKey } from './partnerScope';

describe('parseScopeContext', () => {
  it('parses an owner context', () => {
    expect(parseScopeContext({ has_scope: true, partner_id: 'p1', company_name: 'Acme', tier: 'agency', is_owner: true, can_view_commissions: true }))
      .toEqual({ hasScope: true, partnerId: 'p1', companyName: 'Acme', tier: 'agency', isOwner: true, canViewCommissions: true });
  });
  it('fails closed on anything unexpected', () => {
    for (const bad of [null, undefined, 'x', [], {}, { has_scope: false }, { has_scope: true }, { has_scope: 'true', partner_id: 'p' }]) {
      expect(parseScopeContext(bad)).toEqual(NO_PARTNER_SCOPE);
    }
  });
  it('never grants commission or owner rights from non-boolean values', () => {
    const c = parseScopeContext({ has_scope: true, partner_id: 'p', is_owner: 'yes', can_view_commissions: 1 });
    expect(c.isOwner).toBe(false);
    expect(c.canViewCommissions).toBe(false);
  });
});

describe('parseReferredAccounts', () => {
  it('keeps null money as null (hidden), not zero', () => {
    const [a] = parseReferredAccounts([{ account_id: 'a1', company_name: 'Blue Pipe', plan: 'professional', mrr_cents: null, commission_cents: null, commission_status: null }]);
    expect(a.mrrCents).toBeNull();
    expect(a.commissionCents).toBeNull();
    expect(a.commissionStatus).toBeNull();
  });
  it('coerces numeric strings, drops rows without an account id and non-arrays', () => {
    const rows = parseReferredAccounts([{ account_id: 'a1', mrr_cents: '19900', commission_cents: 3980, commission_status: 'approved' }, { company_name: 'x' }, null]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mrrCents: 19900, commissionCents: 3980, commissionStatus: 'approved', companyName: '—' });
    expect(parseReferredAccounts(null)).toEqual([]);
    expect(parseReferredAccounts({})).toEqual([]);
  });
  it('does not carry through fields outside the contract', () => {
    const [a] = parseReferredAccounts([{ account_id: 'a1', email: 'secret@x.com', phone: '+1', full_name: 'N' }]);
    expect(JSON.stringify(a)).not.toMatch(/secret|\+1|"N"/);
  });
});

describe('scopeErrorKey', () => {
  it('maps the database messages', () => {
    expect(scopeErrorKey('Account not found.')).toBe('not_found');
    expect(scopeErrorKey('No partner access.')).toBe('no_access');
    expect(scopeErrorKey('Authentication required.')).toBe('sign_in');
    expect(scopeErrorKey('Member limit reached (10).')).toBe('member_limit');
    expect(scopeErrorKey('Could not add that member.')).toBe('cannot_add');
    expect(scopeErrorKey('Only an approved partner owner can manage members.')).toBe('owner_only');
    expect(scopeErrorKey(undefined)).toBe('unknown');
    expect(scopeErrorKey('boom')).toBe('unknown');
  });
});
