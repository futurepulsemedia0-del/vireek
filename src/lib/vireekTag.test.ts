import { describe, expect, it, vi } from 'vitest';
import {
  detectDevice, detectSource, formatTagToken, isValidTagToken, normalizeTagToken, tagErrorMessage, tagUrl, validateServiceRequest,
} from '@/lib/vireekTag';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const TOKEN = 'ABCDEFGH23456789';

describe('token helpers', () => {
  it('normalizes raw, formatted and URL input', () => {
    expect(normalizeTagToken('abcd-efgh-2345-6789')).toBe(TOKEN);
    expect(normalizeTagToken('VTG-ABCD-EFGH-2345-6789')).toBe(TOKEN);
    expect(normalizeTagToken('https://vireek.com/t/ABCD-EFGH-2345-6789?s=nfc')).toBe(TOKEN);
  });
  it('repairs confusable characters like the SQL function', () => {
    expect(normalizeTagToken('abcdefgh2345678o')).toBe('ABCDEFGH23456780');
    expect(normalizeTagToken('ABCDEFGH2345678l')).toBe('ABCDEFGH23456781');
  });
  it('validates length and alphabet', () => {
    expect(isValidTagToken(TOKEN)).toBe(true);
    expect(isValidTagToken('SHORT')).toBe(false);
    expect(isValidTagToken('ABCDEFGH2345678U')).toBe(false); // U is not in the alphabet
  });
  it('formats for humans and leaves junk untouched', () => {
    expect(formatTagToken(TOKEN)).toBe('VTG-ABCD-EFGH-2345-6789');
    expect(formatTagToken('nope')).toBe('nope');
  });
  it('builds QR and NFC URLs', () => {
    expect(tagUrl(TOKEN, 'qr', 'https://vireek.com/')).toBe(`https://vireek.com/t/${TOKEN}`);
    expect(tagUrl(TOKEN, 'nfc', 'https://vireek.com')).toBe(`https://vireek.com/t/${TOKEN}?s=nfc`);
  });
});

describe('client signals', () => {
  it('classifies devices', () => {
    expect(detectDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148')).toBe('mobile');
    expect(detectDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(detectDevice('Mozilla/5.0 (Linux; Android 14; Pixel Tablet)')).toBe('tablet');
    expect(detectDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120')).toBe('desktop');
    expect(detectDevice('')).toBe('unknown');
  });
  it('reads the scan source', () => {
    expect(detectSource('?s=nfc')).toBe('nfc');
    expect(detectSource('?s=link')).toBe('link');
    expect(detectSource('?s=evil')).toBe('qr');
    expect(detectSource('')).toBe('qr');
  });
});

describe('validateServiceRequest', () => {
  const ok = { name: 'Maria Gomez', phone: '+1 555 010 0001', email: '', issue: 'No heat' };
  it('accepts phone-only or email-only contact', () => {
    expect(validateServiceRequest(ok)).toEqual({});
    expect(validateServiceRequest({ ...ok, phone: '', email: 'm@example.com' })).toEqual({});
  });
  it('requires a way to reach the customer', () => {
    expect(validateServiceRequest({ ...ok, phone: '' }).contact).toBeTruthy();
  });
  it('rejects bad names, phones and emails', () => {
    expect(validateServiceRequest({ ...ok, name: 'M' }).name).toBeTruthy();
    expect(validateServiceRequest({ ...ok, phone: '12' }).phone).toBeTruthy();
    expect(validateServiceRequest({ ...ok, email: 'nope' }).email).toBeTruthy();
    expect(validateServiceRequest({ ...ok, issue: 'x'.repeat(1001) }).issue).toBeTruthy();
  });
});

describe('tagErrorMessage', () => {
  it('maps server codes to friendly copy', () => {
    expect(tagErrorMessage({ message: 'TAG_RATE_LIMITED' })).toMatch(/Too many/);
    expect(tagErrorMessage({ message: 'TAG_PASSPORT_ALREADY_TAGGED' })).toMatch(/Rotate/);
    expect(tagErrorMessage(new Error('boom'))).toMatch(/Something went wrong/);
  });
});
