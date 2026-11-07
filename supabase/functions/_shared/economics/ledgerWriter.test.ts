import { describe, it, expect } from 'vitest';
import { buildLedgerRow, componentToResource, hasCorrelation, usdEvent } from './ledgerWriter';

describe('ledger row builder', () => {
  it('maps components to resource types', () => {
    expect(componentToResource('asr')).toBe('stt');
    expect(componentToResource('carrier_inbound')).toBe('telephony');
    expect(componentToResource('provider_total_unbroken')).toBe('other_api');
  });
  it('rejects float/negative micro-dollars and empty provider/source', () => {
    const base = { accountId: 'a', provider: 'vapi', resourceType: 'stt' as const, costMicro: 5, basis: 'provider_reported' as const, source: 's' };
    expect(() => buildLedgerRow({ ...base, costMicro: 1.5 })).toThrow();
    expect(() => buildLedgerRow({ ...base, costMicro: -1 })).toThrow();
    expect(() => buildLedgerRow({ ...base, provider: ' ' })).toThrow();
    expect(buildLedgerRow({ ...base, provider: ' Vapi ' }).provider).toBe('vapi');
  });
  it('usdEvent converts float USD to integer micro and flags correlation', () => {
    const e = usdEvent({ accountId: 'a', provider: 'x', resourceType: 'llm_tokens', costUsd: 0.012345678, basis: 'estimated', source: 's', callId: 'c1' });
    expect(e.costMicro).toBe(12346);
    expect(hasCorrelation(e)).toBe(true);
    expect(hasCorrelation({})).toBe(false);
  });
});
