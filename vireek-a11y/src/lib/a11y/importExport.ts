import { sanitizeSettings, type AccessibilitySettings } from './settings';

export const EXPORT_APP_ID = 'vireek-accessibility';
export const EXPORT_VERSION = 2;
export const MAX_IMPORT_CHARS = 20_000;

export function serializeSettings(s: AccessibilitySettings): string {
  return JSON.stringify({ app: EXPORT_APP_ID, version: EXPORT_VERSION, settings: s }, null, 2);
}

export type ImportResult =
  | { ok: true; settings: AccessibilitySettings }
  | { ok: false; reason: 'tooLarge' | 'invalidJson' | 'wrongFormat' };

export function parseImportedSettings(text: string): ImportResult {
  if (text.length > MAX_IMPORT_CHARS) return { ok: false, reason: 'tooLarge' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalidJson' };
  }
  if (typeof data !== 'object' || data === null) return { ok: false, reason: 'wrongFormat' };
  const rec = data as Record<string, unknown>;
  if (rec.app !== EXPORT_APP_ID || typeof rec.settings !== 'object' || rec.settings === null) return { ok: false, reason: 'wrongFormat' };
  return { ok: true, settings: sanitizeSettings(rec.settings) };
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
