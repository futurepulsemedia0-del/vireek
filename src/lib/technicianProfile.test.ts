import { describe, it, expect } from 'vitest';
import {
  clampMaxJobs,
  credentialExpiryState,
  credentialTitle,
  daysUntil,
  expiryLabel,
  sortCredentials,
  summarizeCredentials,
  type TechCredential,
} from './technicianProfile';

const NOW = new Date(2026, 9, 9, 15, 30); // 9 Oct 2026, local
const cred = (o: Partial<TechCredential> & { id: string }): TechCredential => ({
  credential_type: 'epa_608',
  credential_name: null,
  issuing_authority: null,
  credential_number: null,
  issued_at: null,
  expires_at: null,
  status: 'active',
  ...o,
});

describe('daysUntil', () => {
  it('counts calendar days regardless of time of day', () => {
    expect(daysUntil('2026-10-09', NOW)).toBe(0);
    expect(daysUntil('2026-10-10', NOW)).toBe(1);
    expect(daysUntil('2026-10-08', NOW)).toBe(-1);
    expect(daysUntil('2026-11-08', NOW)).toBe(30);
  });
  it('returns null for empty or invalid input', () => {
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil('soon', NOW)).toBeNull();
  });
});

describe('credentialExpiryState', () => {
  it('classifies by status and expiry window', () => {
    expect(credentialExpiryState({ status: 'revoked', expires_at: '2030-01-01' }, 30, NOW)).toBe('revoked');
    expect(credentialExpiryState({ status: 'pending_renewal', expires_at: '2020-01-01' }, 30, NOW)).toBe('pending_renewal');
    expect(credentialExpiryState({ status: 'active', expires_at: '2026-10-08' }, 30, NOW)).toBe('expired');
    expect(credentialExpiryState({ status: 'active', expires_at: '2026-10-09' }, 30, NOW)).toBe('expiring');
    expect(credentialExpiryState({ status: 'active', expires_at: '2026-11-08' }, 30, NOW)).toBe('expiring');
    expect(credentialExpiryState({ status: 'active', expires_at: '2026-11-09' }, 30, NOW)).toBe('valid');
    expect(credentialExpiryState({ status: 'active', expires_at: null }, 30, NOW)).toBe('no_expiry');
  });
  it('respects the technician alert lead time', () => {
    expect(credentialExpiryState({ status: 'active', expires_at: '2026-12-01' }, 90, NOW)).toBe('expiring');
    expect(credentialExpiryState({ status: 'active', expires_at: '2026-12-01' }, 14, NOW)).toBe('valid');
  });
});

describe('labels, sorting, summary', () => {
  it('formats expiry labels with correct plurals', () => {
    expect(expiryLabel('expired', '2026-10-08', NOW)).toBe('Expired 1 day ago');
    expect(expiryLabel('expired', '2026-10-01', NOW)).toBe('Expired 8 days ago');
    expect(expiryLabel('expiring', '2026-10-09', NOW)).toBe('Expires today');
    expect(expiryLabel('expiring', '2026-10-10', NOW)).toBe('Expires in 1 day');
    expect(expiryLabel('pending_renewal', null, NOW)).toBe('Renewal pending');
  });
  it('titles fall back to a humanized credential type', () => {
    expect(credentialTitle({ credential_name: ' HVAC Master ', credential_type: 'x' })).toBe('HVAC Master');
    expect(credentialTitle({ credential_name: null, credential_type: 'epa_608' })).toBe('Epa 608');
  });
  it('sorts most urgent first without mutating the input', () => {
    const list = [
      cred({ id: 'valid', expires_at: '2027-06-01' }),
      cred({ id: 'revoked', status: 'revoked' }),
      cred({ id: 'soon', expires_at: '2026-10-20' }),
      cred({ id: 'expired', expires_at: '2026-09-01' }),
      cred({ id: 'none' }),
    ];
    const copy = [...list];
    expect(sortCredentials(list, 30, NOW).map((c) => c.id)).toEqual(['expired', 'soon', 'valid', 'none', 'revoked']);
    expect(list).toEqual(copy);
  });
  it('summarizes what needs attention', () => {
    const s = summarizeCredentials(
      [
        cred({ id: '1', expires_at: '2026-09-01' }),
        cred({ id: '2', expires_at: '2026-10-20' }),
        cred({ id: '3', status: 'pending_renewal' }),
        cred({ id: '4', expires_at: '2027-06-01' }),
        cred({ id: '5', status: 'revoked' }),
      ],
      30,
      NOW
    );
    expect(s).toEqual({ expired: 1, expiring: 1, pendingRenewal: 1, valid: 1, attention: 3 });
  });
  it('clamps max jobs', () => {
    expect(clampMaxJobs(0)).toBe(1);
    expect(clampMaxJobs(99)).toBe(30);
    expect(clampMaxJobs(Number.NaN)).toBe(1);
    expect(clampMaxJobs(5.6)).toBe(6);
  });
});
