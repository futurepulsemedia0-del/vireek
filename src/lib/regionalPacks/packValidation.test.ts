import { describe, it, expect } from 'vitest';
import { parsePhone, validateAddress, validateTaxId, canReceiveSms, abnChecksumOk, gbVatChecksumOk, auStateForPostcode } from './packValidation';

describe('parsePhone', () => {
  it('parses US/CA numbers and tells them apart by area code', () => {
    const us = parsePhone('(512) 555-0123', 'US');
    expect(us.ok && us.e164).toBe('+15125550123');
    expect(us.country).toBe('US');
    expect(parsePhone('416-555-0199', 'US').country).toBe('CA');
    expect(parsePhone('+1 604 555 0100', 'US').country).toBe('CA');
  });
  it('rejects invalid NANP numbers', () => {
    expect(parsePhone('111-555-0123', 'US').ok).toBe(false);
    expect(parsePhone('512-155-0123', 'US').ok).toBe(false);
    expect(parsePhone('555-0123', 'US').ok).toBe(false);
  });
  it('parses UK mobile and landline', () => {
    const m = parsePhone('07911 123456', 'GB');
    expect(m.e164).toBe('+447911123456');
    expect(m.type).toBe('mobile');
    expect(m.national).toBe('07911 123456');
    expect(parsePhone('020 7946 0958', 'GB').type).toBe('fixed');
    expect(parsePhone('+44 20 7946 0958', 'US').country).toBe('GB');
  });
  it('parses Australian numbers', () => {
    const m = parsePhone('0412 345 678', 'AU');
    expect(m.e164).toBe('+61412345678');
    expect(m.type).toBe('mobile');
    expect(parsePhone('(02) 9374 4000', 'AU').type).toBe('fixed');
    expect(parsePhone('1800 123 456', 'AU').type).toBe('toll_free');
    expect(parsePhone('0612 345 678', 'AU').ok).toBe(false);
  });
  it('parses EU numbers and enforces lengths', () => {
    expect(parsePhone('06 12 34 56 78', 'FR').e164).toBe('+33612345678');
    expect(parsePhone('+49 30 123456', 'FR').country).toBe('DE');
    expect(parsePhone('0612345', 'FR').ok).toBe(false);
    expect(parsePhone('0049 30 123456', 'GB').country).toBe('DE');
  });
  it('rejects junk and unknown codes', () => {
    expect(parsePhone('', 'US').ok).toBe(false);
    expect(parsePhone('call me', 'US').ok).toBe(false);
    expect(parsePhone('+999 123', 'US').ok).toBe(false);
    expect(parsePhone('+44 20 7946 0958 ext 12', 'GB').ok).toBe(true);
  });
  it('does not send texts to landlines', () => {
    expect(canReceiveSms(parsePhone('020 7946 0958', 'GB'))).toBe(false);
    expect(canReceiveSms(parsePhone('07911 123456', 'GB'))).toBe(true);
  });
});

describe('validateAddress', () => {
  it('normalizes Canadian and UK postal codes', () => {
    const ca = validateAddress({ line1: '1 King St W', city: 'Toronto', subdivision: 'Ontario', postalCode: 'm5v2t6', country: 'ca' });
    expect(ca.valid).toBe(true);
    expect(ca.normalized.postalCode).toBe('M5V 2T6');
    expect(ca.normalized.subdivision).toBe('ON');
    const gb = validateAddress({ line1: '10 Downing Street', city: 'London', postalCode: 'sw1a2aa', country: 'GB' });
    expect(gb.normalized.postalCode).toBe('SW1A 2AA');
    expect(gb.valid).toBe(true);
  });
  it('requires state for US and validates ZIP', () => {
    const r = validateAddress({ line1: '100 Main St', city: 'Austin', postalCode: '7870', country: 'US' });
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.field).sort()).toEqual(['postalCode', 'subdivision']);
  });
  it('warns on postcode/state mismatch', () => {
    const r = validateAddress({ line1: '5 George St', city: 'Sydney', subdivision: 'VIC', postalCode: '2000', country: 'AU' });
    expect(r.valid).toBe(true);
    expect(r.issues[0].code).toBe('POSTAL_REGION_MISMATCH');
    expect(auStateForPostcode('2600')).toEqual(['ACT']);
  });
  it('validates EU formats and flags PO boxes for service sites', () => {
    expect(validateAddress({ line1: 'Hauptstr. 1', city: 'Berlin', postalCode: '10115', country: 'DE' }).valid).toBe(true);
    expect(validateAddress({ line1: 'Damrak 1', city: 'Amsterdam', postalCode: '1012ab', country: 'NL' }).normalized.postalCode).toBe('1012 AB');
    expect(validateAddress({ line1: 'Main St 1', city: 'Dublin', postalCode: 'D02X285', country: 'IE' }).valid).toBe(true);
    const po = validateAddress({ line1: 'PO Box 12', city: 'Austin', subdivision: 'TX', postalCode: '78701', country: 'US' }, { serviceSite: true });
    expect(po.issues.some((i) => i.code === 'PO_BOX_SITE')).toBe(true);
  });
  it('rejects unsupported countries and strips control characters', () => {
    expect(validateAddress({ line1: 'x', city: 'y', postalCode: '1', country: 'JP' }).valid).toBe(false);
    expect(validateAddress({ line1: 'A\u0000 Street 1', city: 'Z', postalCode: '10115', country: 'DE' }).normalized.line1).toBe('A Street 1');
  });
});

describe('validateTaxId', () => {
  it('validates ABN checksums', () => {
    expect(abnChecksumOk('51824753556')).toBe(true);
    expect(validateTaxId('AU', '51 824 753 556').valid).toBe(true);
    expect(validateTaxId('AU', '51 824 753 557').valid).toBe(false);
  });
  it('validates UK VAT checksums', () => {
    expect(gbVatChecksumOk('980780684')).toBe(true);
    expect(validateTaxId('GB', 'GB 980 7806 84').valid).toBe(true);
    expect(validateTaxId('GB', 'GB980780685').valid).toBe(false);
  });
  it('validates EU VAT formats', () => {
    expect(validateTaxId('DE', 'DE123456789').valid).toBe(true);
    expect(validateTaxId('DE', '123456789').normalized).toBe('DE123456789');
    expect(validateTaxId('GR', 'EL123456789').valid).toBe(true);
    expect(validateTaxId('NL', 'NL123456789B01').valid).toBe(true);
    expect(validateTaxId('FR', 'FR123').valid).toBe(false);
  });
  it('validates Canadian numbers', () => {
    expect(validateTaxId('CA', '123456789 RT 0001').valid).toBe(true);
    expect(validateTaxId('CA', '12345 RT 0001').valid).toBe(false);
    expect(validateTaxId('CA', '1234567890 TQ 0001', 'QST').valid).toBe(true);
  });
});
