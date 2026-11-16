import { DEFAULT_SETTINGS, sanitizeSettings, type AccessibilitySettings } from './settings';

/** User-made profiles: a named snapshot of the appearance/behaviour settings, stored on this device only.
 *  Personal speech and shortcut preferences are never part of a profile, so applying one cannot overwrite them. */
export const CUSTOM_PROFILES_KEY = 'vk-a11y-custom-profiles-v1';
export const MAX_CUSTOM_PROFILES = 8;
export const MAX_PROFILE_NAME = 40;

export interface CustomProfile {
  id: string;
  name: string;
  createdAt: number;
  settings: AccessibilitySettings;
}

export type AddResult =
  | { ok: true; profiles: CustomProfile[]; profile: CustomProfile; replaced: boolean }
  | { ok: false; reason: 'name' | 'limit' };

/** Strips control and bidi-override characters, collapses whitespace, trims and caps the length. */
export function normalizeProfileName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PROFILE_NAME);
}

const sameName = (a: string, b: string): boolean => a.toLocaleLowerCase() === b.toLocaleLowerCase();

function personalFrom(s: AccessibilitySettings): Pick<AccessibilitySettings, 'ttsRate' | 'ttsPitch' | 'ttsVolume' | 'ttsVoiceURI' | 'shortcuts'> {
  return { ttsRate: s.ttsRate, ttsPitch: s.ttsPitch, ttsVolume: s.ttsVolume, ttsVoiceURI: s.ttsVoiceURI, shortcuts: s.shortcuts };
}

/** The settings a profile stores: everything except the personal speech/shortcut preferences (kept at defaults). */
export function snapshotSettings(s: AccessibilitySettings): AccessibilitySettings {
  return sanitizeSettings({ ...s, ...personalFrom(DEFAULT_SETTINGS), shortcuts: { ...DEFAULT_SETTINGS.shortcuts } });
}

/** Settings after applying `p` on top of `current` (personal preferences are carried over from `current`). */
export function applyCustomProfile(current: AccessibilitySettings, p: CustomProfile): AccessibilitySettings {
  return sanitizeSettings({ ...p.settings, ...personalFrom(current) });
}

const near = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : a === b;

/** Id of the custom profile whose every setting matches the current ones, if any. */
export function detectActiveCustom(s: AccessibilitySettings, profiles: readonly CustomProfile[]): string | null {
  const keys = Object.keys(DEFAULT_SETTINGS) as (keyof AccessibilitySettings)[];
  for (const p of profiles) {
    const target = applyCustomProfile(s, p);
    if (keys.every((k) => k === 'shortcuts' || near(s[k], target[k]))) return p.id;
  }
  return null;
}

export function addCustomProfile(
  list: readonly CustomProfile[],
  rawName: string,
  settings: AccessibilitySettings,
  now: number,
  newId: string,
): AddResult {
  const name = normalizeProfileName(rawName);
  if (!name) return { ok: false, reason: 'name' };
  const snap = snapshotSettings(settings);
  const idx = list.findIndex((p) => sameName(p.name, name));
  if (idx >= 0) {
    const profile: CustomProfile = { ...list[idx], name, settings: snap };
    const profiles = list.map((p, i) => (i === idx ? profile : p));
    return { ok: true, profiles, profile, replaced: true };
  }
  if (list.length >= MAX_CUSTOM_PROFILES) return { ok: false, reason: 'limit' };
  const profile: CustomProfile = { id: newId, name, createdAt: now, settings: snap };
  return { ok: true, profiles: [...list, profile], profile, replaced: false };
}

export function removeCustomProfile(list: readonly CustomProfile[], id: string): CustomProfile[] {
  return list.filter((p) => p.id !== id);
}

/** Validates untrusted stored data: drops malformed entries, re-sanitizes settings, enforces limits and unique ids. */
export function sanitizeProfileList(raw: unknown): CustomProfile[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomProfile[] = [];
  const ids = new Set<string>();
  for (const e of raw) {
    if (out.length >= MAX_CUSTOM_PROFILES) break;
    if (typeof e !== 'object' || e === null) continue;
    const r = e as Record<string, unknown>;
    const id = typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 64 ? r.id : null;
    const name = typeof r.name === 'string' ? normalizeProfileName(r.name) : '';
    if (!id || !name || ids.has(id)) continue;
    ids.add(id);
    const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0;
    out.push({ id, name, createdAt, settings: snapshotSettings(sanitizeSettings(r.settings)) });
  }
  return out;
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadCustomProfiles(storage: Storage | null = defaultStorage()): CustomProfile[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(CUSTOM_PROFILES_KEY);
    return raw ? sanitizeProfileList(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** Returns false when storage is unavailable or full, so the UI can say so instead of pretending it saved. */
export function saveCustomProfiles(list: readonly CustomProfile[], storage: Storage | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(CUSTOM_PROFILES_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function newProfileId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  return c && typeof c.randomUUID === 'function' ? c.randomUUID() : `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
