import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_CHARS, parseImportedSettings, serializeSettings } from './importExport';
import { DEFAULT_SETTINGS } from './settings';

describe('import/export', () => {
  it('round-trips', () => {
    const s = { ...DEFAULT_SETTINGS, highContrast: true, textSize: 1.25 };
    const r = parseImportedSettings(serializeSettings(s));
    expect(r.ok && r.settings).toEqual(s);
  });
  it('rejects oversized, invalid JSON and foreign files', () => {
    expect(parseImportedSettings('x'.repeat(MAX_IMPORT_CHARS + 1))).toEqual({ ok: false, reason: 'tooLarge' });
    expect(parseImportedSettings('{oops')).toEqual({ ok: false, reason: 'invalidJson' });
    expect(parseImportedSettings('[]')).toEqual({ ok: false, reason: 'wrongFormat' });
    expect(parseImportedSettings('{"app":"other","settings":{}}')).toEqual({ ok: false, reason: 'wrongFormat' });
  });
  it('sanitizes imported values', () => {
    const r = parseImportedSettings('{"app":"vireek-accessibility","settings":{"textSize":42,"evil":1}}');
    expect(r.ok && r.settings.textSize).toBe(1.5);
  });
});
