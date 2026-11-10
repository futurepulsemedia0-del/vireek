import { describe, it, expect } from 'vitest';
import { consentRequirementsFor, createConsentBus, type ConsentEvent } from './consentHooks';

const ev = (o: Partial<ConsentEvent> = {}): ConsentEvent => ({
  eventId: 'evt-00000001', type: 'granted', purpose: 'marketing_email', accountOwnerId: 'owner-1', subjectId: 'cust-1', country: 'DE', occurredAt: '2026-11-10T10:00:00Z', ...o,
});

describe('consentRequirementsFor — always flagged REQUIRES COUNSEL', () => {
  it('EU/UK/CA/AU suggest an explicit choice for non-service purposes; service messages never do', () => {
    for (const c of ['DE', 'GB', 'CA', 'AU']) {
      const r = consentRequirementsFor(c);
      expect(r.requiresCounsel).toBe(true);
      expect(r.notice).toMatch(/REQUIRES COUNSEL/);
      expect(r.purposes.find((p) => p.purpose === 'service_communications')!.explicitChoiceSuggested).toBe(false);
      expect(r.purposes.find((p) => p.purpose === 'marketing_email')!.explicitChoiceSuggested).toBe(true);
    }
  });
  it('maps regimes from the audited packs (QC adds Law 25, CA adds CCPA for US-CA)', () => {
    expect(consentRequirementsFor('DE').regimes).toEqual(['GDPR']);
    expect(consentRequirementsFor('CA', 'QC').regimes).toEqual(['PIPEDA', 'QC_LAW25', 'CASL']);
    expect(consentRequirementsFor('US', 'CA').regimes).toEqual(['CCPA', 'CAN_SPAM']);
  });
  it('unknown countries fail toward ASKING, not toward assuming consent', () => {
    const r = consentRequirementsFor('JP');
    expect(r.regimes).toEqual([]);
    expect(r.purposes.find((p) => p.purpose === 'marketing_sms')!.explicitChoiceSuggested).toBe(true);
  });
});

describe('consent bus', () => {
  it('delivers once; re-delivery of the same event id is a no-op (idempotent)', async () => {
    const bus = createConsentBus(); const seen: string[] = [];
    bus.register({ name: 'a', handle: (e) => { seen.push(e.eventId); } });
    expect(await bus.emit(ev())).toMatchObject({ delivered: 1, duplicate: false });
    expect(await bus.emit(ev())).toMatchObject({ delivered: 0, duplicate: true });
    expect(seen).toEqual(['evt-00000001']);
  });
  it('event ids are scoped per tenant (no cross-tenant collision or suppression)', async () => {
    const bus = createConsentBus(); let n = 0;
    bus.register({ name: 'a', handle: () => { n += 1; } });
    await bus.emit(ev({ accountOwnerId: 'owner-1' }));
    expect((await bus.emit(ev({ accountOwnerId: 'owner-2' }))).duplicate).toBe(false);
    expect(n).toBe(2);
  });
  it('one failing hook never blocks the others, and is reported', async () => {
    const bus = createConsentBus(); let ok = 0;
    bus.register({ name: 'bad', handle: () => { throw new Error('boom'); } });
    bus.register({ name: 'good', handle: () => { ok += 1; } });
    const r = await bus.emit(ev());
    expect(r.delivered).toBe(1); expect(r.failed).toEqual([{ hook: 'bad', error: 'boom' }]); expect(ok).toBe(1);
  });
  it('if EVERY hook fails the event can be retried', async () => {
    const bus = createConsentBus(); let fail = true; let got = 0;
    bus.register({ name: 'flaky', handle: () => { if (fail) throw new Error('down'); got += 1; } });
    await bus.emit(ev()); fail = false;
    expect(await bus.emit(ev())).toMatchObject({ delivered: 1, duplicate: false });
    expect(got).toBe(1);
  });
  it('rejects malformed events and duplicate hook names; unregister works', async () => {
    const bus = createConsentBus();
    await expect(bus.emit(ev({ eventId: 'x' }))).rejects.toThrow();
    await expect(bus.emit(ev({ accountOwnerId: '' }))).rejects.toThrow();
    await expect(bus.emit(ev({ occurredAt: 'yesterday' }))).rejects.toThrow();
    const off = bus.register({ name: 'a', handle: () => {} });
    expect(() => bus.register({ name: 'a', handle: () => {} })).toThrow();
    off();
    expect(() => bus.register({ name: 'a', handle: () => {} })).not.toThrow();
  });
});
