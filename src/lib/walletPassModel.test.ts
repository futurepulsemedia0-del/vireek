import { describe, expect, it } from 'vitest';
import {
  buildPassModel, formatGiftCode, googleClassId, googleObjectId, isValidTimezone, resolveColors, resolveEta, toApplePassJson,
  toGoogleObject, type PassPayload, type WalletKind,
} from '../../supabase/functions/_shared/wallet/passModel';

const NOW = new Date('2026-10-24T18:00:00Z'); // 2:00 PM New York
const apple = { passTypeIdentifier: 'pass.com.vireek.wallet', teamIdentifier: 'TEAM123456', webServiceURL: 'https://x.supabase.co/functions/v1/wallet-pass' };

function payload(kind: WalletKind, data: Record<string, unknown> | null, over: Partial<PassPayload['pass']> = {}): PassPayload {
  return {
    pass: { id: 'id', user_id: 'u', kind, serial: 'a'.repeat(32), auth_token: 'tok'.repeat(10), share_token: 'st', timezone: 'America/New_York', status: 'active', version: 1, last_changed_at: NOW.toISOString(), customer_id: null, ...over },
    org: { name: 'Acme HVAC', phone: '+15551234567', color: '#2563eb' },
    data,
    missing: data === null,
  };
}

describe('colors & timezone', () => {
  it('picks readable foregrounds and rejects bad hex', () => {
    expect(resolveColors('#FFFFFF').fg).toBe('#0B1220');
    expect(resolveColors('#0B1220').fg).toBe('#FFFFFF');
    expect(resolveColors('javascript:alert(1)').bg).toBe('#2563EB');
  });
  it('validates IANA zones', () => {
    expect(isValidTimezone('America/Chicago')).toBe(true);
    expect(isValidTimezone('Mars/Base')).toBe(false);
  });
});

describe('appointment ETA', () => {
  const base = { job_status: 'scheduled', scheduled_at: '2026-10-24T20:00:00Z', service_type: 'AC repair', technician_name: 'Tom Tech', address: '1 Main St' };

  it('uses eta_set_at + eta_minutes and shows it in the pass timezone', () => {
    const m = buildPassModel(payload('appointment', { ...base, eta_minutes: 25, eta_set_at: '2026-10-24T17:50:00Z' }), NOW);
    expect(m.headline).toBe('Arriving about 2:15 PM');
    expect(m.primary[0].label).toBe('TECHNICIAN ETA');
    expect(m.primary[0].value).toBe('2026-10-24T18:15:00Z');
    expect(m.secondary[0].value).toBe('Tom Tech');
  });
  it('ignores a stale ETA and falls back to the window, then the scheduled time', () => {
    const stale = { ...base, eta_minutes: 10, eta_set_at: '2026-10-24T10:00:00Z' };
    expect(resolveEta(stale, NOW).mode).toBe('scheduled');
    const win = { ...stale, window_start: '2026-10-24T18:00:00Z', window_end: '2026-10-24T20:00:00Z' };
    expect(resolveEta(win, NOW).mode).toBe('window');
    expect(buildPassModel(payload('appointment', win), NOW).primary[0].label).toBe('ARRIVAL WINDOW');
  });
  it('completed and cancelled states', () => {
    expect(buildPassModel(payload('appointment', { ...base, job_status: 'completed' }), NOW).googleState).toBe('COMPLETED');
    const c = buildPassModel(payload('appointment', { ...base, job_status: 'cancelled' }), NOW);
    expect(c.voided).toBe(true);
    expect(c.googleState).toBe('INACTIVE');
  });
  it('unassigned technician is explicit, never blank', () => {
    expect(buildPassModel(payload('appointment', { ...base, technician_name: null }), NOW).secondary[0].value).toBe('Being assigned');
  });
});

describe('other kinds', () => {
  it('gift card: balance, barcode = raw code, expiry and state', () => {
    const m = buildPassModel(payload('gift_card', { code: 'ABCDEFGHJKLM', balance_cents: 4000, currency: 'usd', status: 'active', expires_at: '2027-01-01T00:00:00Z' }), NOW);
    expect(m.headline).toBe('$40.00 balance');
    expect(m.barcode.message).toBe('ABCDEFGHJKLM');
    expect(m.barcode.altText).toBe('ABCD-EFGH-JKLM');
    expect(m.primary[0]).toMatchObject({ value: 40, currencyCode: 'USD' });
    expect(m.style).toBe('storeCard');
    expect(buildPassModel(payload('gift_card', { code: 'X', balance_cents: 0, currency: 'usd', status: 'depleted' }), NOW).googleState).toBe('EXPIRED');
    expect(buildPassModel(payload('gift_card', { code: 'X', balance_cents: 5, currency: 'usd', status: 'voided' }), NOW).voided).toBe(true);
  });
  it('protection: covered, expired and removed equipment', () => {
    const d = { make: 'Carrier', model: 'X1', equipment_type: 'AC', customer_name: 'Jane', serial_tail: '3456', equipment_status: 'active' };
    expect(buildPassModel(payload('protection', { ...d, warranty_expires_at: '2030-01-01' }), NOW).headline).toBe('Covered through Jan 1, 2030');
    const old = buildPassModel(payload('protection', { ...d, warranty_expires_at: '2020-01-01' }), NOW);
    expect(old.googleState).toBe('EXPIRED');
    expect(old.voided).toBe(false);
    expect(buildPassModel(payload('protection', { ...d, equipment_status: 'replaced' }), NOW).voided).toBe(true);
  });
  it('membership: active vs cancelled', () => {
    const d = { customer_name: 'Jane', plan_name: 'Gold', status: 'active', benefits: ['Priority service', '10% off parts'], member_ref: 'ABCD1234' };
    const m = buildPassModel(payload('membership', d), NOW);
    expect(m.back[0].value).toContain('• Priority service');
    expect(buildPassModel(payload('membership', { ...d, status: 'cancelled' }), NOW).voided).toBe(true);
  });
  it('tech badge never exposes email and uses a role label', () => {
    const m = buildPassModel(payload('tech_badge', { name: 'Tom Tech', role: 'member', badge_ref: 'ABCD1234' }), NOW);
    expect(JSON.stringify(m)).not.toContain('@');
    expect(m.subline).toContain('Field technician');
  });
  it('voided or missing subjects always void the pass', () => {
    expect(buildPassModel(payload('tech_badge', { name: 'T', role: 'member', badge_ref: 'X' }, { status: 'voided' }), NOW).voided).toBe(true);
    const gone = buildPassModel(payload('appointment', null), NOW);
    expect(gone.voided).toBe(true);
    expect(gone.googleState).toBe('INACTIVE');
  });
});

describe('serializers', () => {
  const m = buildPassModel(payload('appointment', { job_status: 'scheduled', scheduled_at: '2026-10-24T20:00:00Z', service_type: 'AC repair', technician_name: 'Tom', eta_minutes: 20, eta_set_at: '2026-10-24T17:55:00Z' }), NOW);

  it('Apple JSON has the required keys, change messages and no undefined values', () => {
    const j = toApplePassJson(m, 'secret-token', apple) as Record<string, unknown>;
    expect(j).toMatchObject({ formatVersion: 1, passTypeIdentifier: apple.passTypeIdentifier, teamIdentifier: apple.teamIdentifier, serialNumber: m.serial, authenticationToken: 'secret-token', webServiceURL: apple.webServiceURL });
    expect(j.backgroundColor).toBe('rgb(37, 99, 235)');
    const primary = (j.generic as { primaryFields: Record<string, unknown>[] }).primaryFields[0];
    expect(primary).toMatchObject({ key: 'eta', dateStyle: 'PKDateStyleNone', timeStyle: 'PKDateStyleShort', changeMessage: 'Technician ETA updated: %@' });
    expect(JSON.parse(JSON.stringify(j))).toEqual(j);
  });
  it('Apple storeCard style is used for cards with a balance', () => {
    const g = buildPassModel(payload('gift_card', { code: 'ABCDEFGHJKLM', balance_cents: 100, currency: 'usd', status: 'active' }), NOW);
    expect(Object.keys(toApplePassJson(g, 't', apple))).toContain('storeCard');
  });
  it('Google object references the class/object ids and renders text in the pass timezone', () => {
    const ids = { classId: googleClassId('3388', 'appointment'), objectId: googleObjectId('3388', m.serial) };
    const o = toGoogleObject(m, ids, 'America/New_York') as Record<string, any>;
    expect(o.classId).toBe('3388.vireek_appointment_v1');
    expect(o.id).toBe(`3388.${m.serial}`);
    expect(o.state).toBe('ACTIVE');
    expect(o.header.defaultValue.value).toBe('Arriving about 2:15 PM');
    expect(o.textModulesData.length).toBeLessThanOrEqual(10);
    expect(o.textModulesData[0]).toMatchObject({ header: 'Technician Eta', body: '2:15 PM' });
    expect(o.barcode).toMatchObject({ type: 'QR_CODE' });
  });
  it('formats gift codes', () => expect(formatGiftCode('ABCDEFGHJKLM')).toBe('ABCD-EFGH-JKLM'));
});
