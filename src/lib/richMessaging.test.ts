import { describe, it, expect } from 'vitest';
import { mapAccountRow, validateSettings, type EditableSettings } from '@/lib/richMessaging';
import { richCardOf, richStatusLabel, isRichChannel } from '@/lib/unifiedInbox';

const ok: EditableSettings = {
  rcsEnabled: true,
  ambEnabled: false,
  brandName: 'Acme',
  brandLogoUrl: 'https://cdn.example.com/l.png',
  brandColor: '#12ab34',
  fallbackToSms: true,
  fallbackAfterSeconds: 45,
  attemptOnUnknown: true,
};

describe('validateSettings (mirrors DB CHECK constraints)', () => {
  it('accepts valid and blank optional fields', () => {
    expect(validateSettings(ok)).toBeNull();
    expect(validateSettings({ ...ok, brandColor: '', brandLogoUrl: '' })).toBeNull();
  });
  it('rejects bad colour, non-https or malformed logo, out-of-range delay', () => {
    expect(validateSettings({ ...ok, brandColor: 'red' })).toMatch(/colour/);
    expect(validateSettings({ ...ok, brandLogoUrl: 'http://x.example.com/a.png' })).toMatch(
      /https/,
    );
    expect(validateSettings({ ...ok, brandLogoUrl: 'nope' })).toMatch(/valid URL/);
    expect(validateSettings({ ...ok, fallbackAfterSeconds: 5 })).toMatch(/between/);
    expect(validateSettings({ ...ok, fallbackAfterSeconds: 901 })).toMatch(/between/);
    expect(validateSettings({ ...ok, fallbackAfterSeconds: 12.5 })).toMatch(/between/);
  });
});

describe('mapAccountRow', () => {
  it('maps snake_case and applies safe defaults', () => {
    const a = mapAccountRow({ user_id: 'u', rcs_status: 'approved', amb_status: 'requested' });
    expect(a).toMatchObject({
      userId: 'u',
      rcsStatus: 'approved',
      brandName: '',
      fallbackToSms: true,
      fallbackAfterSeconds: 45,
      attemptOnUnknown: true,
      rcsEnabled: false,
    });
  });
});

describe('inbox helpers', () => {
  it('richCardOf only returns well-formed card content', () => {
    const card = { title: 'T', actions: [] };
    expect(richCardOf({ kind: 'card', card })).toEqual(card);
    expect(richCardOf({ kind: 'text', text: 'x' })).toBeUndefined();
    expect(richCardOf(null)).toBeUndefined();
    expect(richCardOf({ kind: 'card', card: { title: 5 } })).toBeUndefined();
  });
  it('status labels', () => {
    expect(richStatusLabel('read')).toBe('Read');
    expect(richStatusLabel('fallback_sent')).toBe('Sent as SMS');
    expect(richStatusLabel('received')).toBeNull();
    expect(richStatusLabel(undefined)).toBeNull();
  });
  it('isRichChannel', () => {
    expect(isRichChannel('rcs')).toBe(true);
    expect(isRichChannel('amb')).toBe(true);
    expect(isRichChannel('sms')).toBe(false);
  });
});
