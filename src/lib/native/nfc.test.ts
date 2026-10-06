import { describe, expect, it } from 'vitest';
import { bytesToHex, decodeNdefRecord } from './nfc';

const enc = (s: string) => Array.from(new TextEncoder().encode(s));

describe('nfc decoding', () => {
  it('formats a tag UID as colon-separated hex', () => {
    expect(bytesToHex([4, 161, 178, 195])).toBe('04:A1:B2:C3');
    expect(bytesToHex(undefined)).toBe('');
  });

  it('decodes an NDEF text record (language prefix removed)', () => {
    const payload = [2, ...enc('en'), ...enc('Carrier 24ACC636A003')];
    expect(decodeNdefRecord({ type: [0x54], payload })).toBe('Carrier 24ACC636A003');
  });

  it('decodes an NDEF URI record using the prefix table', () => {
    expect(decodeNdefRecord({ type: [0x55], payload: [4, ...enc('vireek.com/e/123')] })).toBe('https://vireek.com/e/123');
    expect(decodeNdefRecord({ type: [0x55], payload: [5, ...enc('+16509106703')] })).toBe('tel:+16509106703');
  });

  it('ignores record types it does not understand', () => {
    expect(decodeNdefRecord({ type: [0x53, 0x70], payload: [1, 2, 3] })).toBeNull();
    expect(decodeNdefRecord({ type: [0x54], payload: [] })).toBeNull();
  });
});
