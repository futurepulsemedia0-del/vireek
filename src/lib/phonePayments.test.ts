import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { auditToCsv, cardLabel, csvCell, isActive, money, type PhonePaymentAuditEvent, type PhonePaymentSession } from './phonePayments';


const session = { id: 's1' } as PhonePaymentSession;
const ev = (seq: number, metadata: PhonePaymentAuditEvent['metadata'], event_type = 'capture_completed'): PhonePaymentAuditEvent =>
  ({ id: seq, seq, event_type, actor_type: 'provider', metadata, event_hash: 'h' + seq, created_at: '2027-11-02T12:00:00Z' });

describe('phonePayments helpers', () => {
  it('formats money and masked cards', () => {
    expect(money(12500)).toBe('$125.00');
    expect(cardLabel('visa', '1111')).toBe('visa •••• 1111');
    expect(cardLabel(null, null)).toBe('—');
  });
  it('knows active statuses', () => {
    expect(isActive('capturing')).toBe(true);
    expect(isActive('succeeded')).toBe(false);
  });
  it('exports a CSV with one row per event, escaping quotes and neutralising formulas', () => {
    const csv = auditToCsv(session, [ev(1, { card_brand: 'visa', card_last4: '1111' }), ev(2, { reason: '=HYPERLINK("x")' }, 'capture_failed')]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('card_brand=visa; card_last4=1111');
    expect(lines[2]).toContain('reason==HYPERLINK(""x"")'); // quotes doubled, cell does not start with "="
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`); // a leading "=" is neutralised
    expect(csvCell('+1')).toBe(`"'+1"`);
    expect(csv).not.toMatch(/\d{13}/);
  });
});
