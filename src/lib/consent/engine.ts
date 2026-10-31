/**
 * Vireek consent engine — framework-free and the single source of truth for
 * cookie / browser-storage consent.
 *
 *  - Opt-in only: every optional category is OFF until the visitor says otherwise.
 *  - Versioned + expiring: a new CONSENT_VERSION or a record older than 12 months re-prompts.
 *  - Honors Global Privacy Control and Do Not Track: marketing can never be ON while either is set.
 *  - Withdrawal is enforced here: storage/cookies for a withdrawn category are deleted immediately.
 *
 * UI lives in src/components/consent/*. Other code calls hasConsent('analytics').
 */

export const CONSENT_VERSION = 3;
export const CONSENT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
export const CONSENT_STORAGE_KEY = 'vireek-consent-v3';
/** Pre-v3 record (had personalization/ai toggles that controlled nothing). Removed on first run. */
export const LEGACY_CONSENT_KEYS: readonly string[] = ['vireek-consent-v2'];
export const OPEN_PREFERENCES_EVENT = 'vireek:open-consent';

/** Optional categories. Add one only together with real code that it gates. */
export const CONSENT_CATEGORIES = ['analytics', 'marketing'] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];
export type ConsentChoices = Record<ConsentCategory, boolean>;
export type ConsentSource = 'accept_all' | 'reject_all' | 'custom';
export type PromptReason = 'none' | 'first_visit' | 'version_changed' | 'expired';

export interface ConsentRecord {
  version: number;
  /** ISO-8601 time the choice was made. */
  timestamp: string;
  /** Random pseudonymous id (not derived from any personal data). */
  subjectId: string;
  choices: ConsentChoices;
  source: ConsentSource;
  /** True once the record was stored server-side. */
  synced: boolean;
}

export interface PrivacySignals {
  gpc: boolean;
  dnt: boolean;
}

export interface ConsentSnapshot {
  record: ConsentRecord | null;
  /** Effective choices: the stored choice with GPC/DNT restrictions applied. */
  choices: ConsentChoices;
  signals: PrivacySignals;
  needsPrompt: boolean;
  reason: PromptReason;
}

/** What each category stores — the single list used for withdrawal cleanup. */
export interface CategoryFootprint {
  cookies: readonly RegExp[];
  storageKeys: readonly string[];
  storagePrefixes: readonly string[];
}

export const CATEGORY_FOOTPRINT: Record<ConsentCategory, CategoryFootprint> = {
  analytics: {
    cookies: [/^_ga$/, /^_ga_.+$/, /^_gid$/, /^_gat(_.+)?$/],
    storageKeys: ['vireek-visitor-id', 'vireek-experiment-assignments'],
    storagePrefixes: [],
  },
  marketing: {
    cookies: [],
    storageKeys: ['vk_lp_vid'],
    storagePrefixes: ['vk_lp_attr:'],
  },
};

const NO_CONSENT: ConsentChoices = { analytics: false, marketing: false };

/* ------------------------------------------------------------------ */
/*  Pure helpers (exported for tests)                                  */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SOURCES: readonly string[] = ['accept_all', 'reject_all', 'custom'];

export function parseConsentRecord(raw: string | null): ConsentRecord | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || !isRecord(data.choices)) return null;
  const { version, timestamp, subjectId, choices, source, synced } = data;
  if (typeof version !== 'number' || !Number.isInteger(version)) return null;
  if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) return null;
  if (typeof subjectId !== 'string' || subjectId.length < 8 || subjectId.length > 64) return null;
  if (typeof source !== 'string' || !SOURCES.includes(source)) return null;
  const parsedChoices: ConsentChoices = { analytics: false, marketing: false };
  for (const category of CONSENT_CATEGORIES) {
    parsedChoices[category] = choices[category] === true;
  }
  return {
    version,
    timestamp,
    subjectId,
    choices: parsedChoices,
    source: source as ConsentSource,
    synced: synced === true,
  };
}

export function evaluatePrompt(record: ConsentRecord | null, now: number): PromptReason {
  if (!record) return 'first_visit';
  if (record.version !== CONSENT_VERSION) return 'version_changed';
  if (now - Date.parse(record.timestamp) >= CONSENT_MAX_AGE_MS) return 'expired';
  return 'none';
}

export function readPrivacySignals(): PrivacySignals {
  if (typeof navigator === 'undefined') return { gpc: false, dnt: false };
  const nav = navigator as Navigator & {
    globalPrivacyControl?: boolean;
    msDoNotTrack?: string;
  };
  const win = (typeof window !== 'undefined' ? window : {}) as { doNotTrack?: string };
  const dntValues = [nav.doNotTrack, win.doNotTrack, nav.msDoNotTrack];
  return {
    gpc: nav.globalPrivacyControl === true,
    dnt: dntValues.some((v) => v === '1' || v === 'yes'),
  };
}

/** GPC / DNT are opt-out signals for marketing. They never grant anything. */
export function applySignals(choices: ConsentChoices, signals: PrivacySignals): ConsentChoices {
  const optedOut = signals.gpc || signals.dnt;
  return { ...choices, marketing: optedOut ? false : choices.marketing };
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/*  Cookie + storage cleanup                                           */
/* ------------------------------------------------------------------ */

/** Host plus every parent domain: a.b.vireek.com -> a.b.vireek.com, b.vireek.com, vireek.com */
export function cookieDomainCandidates(hostname: string): string[] {
  const parts = hostname.split('.');
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i += 1) out.push(parts.slice(i).join('.'));
  if (parts.length === 1) out.push(hostname);
  return out;
}

export function deleteCookiesMatching(patterns: readonly RegExp[]): void {
  if (typeof document === 'undefined' || patterns.length === 0) return;
  const hostname = typeof location !== 'undefined' ? location.hostname : '';
  const domains = hostname ? cookieDomainCandidates(hostname) : [];
  for (const entry of document.cookie.split(';')) {
    const name = entry.split('=')[0]?.trim();
    if (!name || !patterns.some((p) => p.test(name))) continue;
    const expired = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0; path=/`;
    document.cookie = expired;
    for (const domain of domains) {
      document.cookie = `${expired}; domain=${domain}`;
      document.cookie = `${expired}; domain=.${domain}`;
    }
  }
}

function clearStorage(keys: readonly string[], prefixes: readonly string[]): void {
  for (const store of [safeStorage('local'), safeStorage('session')]) {
    if (!store) continue;
    try {
      for (const key of keys) store.removeItem(key);
      if (prefixes.length > 0) {
        const doomed: string[] = [];
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i);
          if (key && prefixes.some((p) => key.startsWith(p))) doomed.push(key);
        }
        for (const key of doomed) store.removeItem(key);
      }
    } catch {
      /* storage blocked — nothing to clean */
    }
  }
}

function safeStorage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? localStorage : sessionStorage;
  } catch {
    return null;
  }
}

export function clearCategoryFootprint(category: ConsentCategory): void {
  const fp = CATEGORY_FOOTPRINT[category];
  deleteCookiesMatching(fp.cookies);
  clearStorage(fp.storageKeys, fp.storagePrefixes);
}

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

type Listener = () => void;
type CategoryListener = (granted: boolean) => void;

let initialized = false;
let snapshot: ConsentSnapshot = {
  record: null,
  choices: NO_CONSENT,
  signals: { gpc: false, dnt: false },
  needsPrompt: false,
  reason: 'none',
};
const listeners = new Set<Listener>();
const categoryListeners: Record<ConsentCategory, Set<CategoryListener>> = {
  analytics: new Set(),
  marketing: new Set(),
};
/** Last effective value announced to category listeners. */
const announced: Record<ConsentCategory, boolean | null> = { analytics: null, marketing: null };

function readStored(): ConsentRecord | null {
  const store = safeStorage('local');
  if (!store) return null;
  try {
    return parseConsentRecord(store.getItem(CONSENT_STORAGE_KEY));
  } catch {
    return null;
  }
}

function persist(record: ConsentRecord): void {
  const store = safeStorage('local');
  if (!store) return;
  try {
    store.setItem(CONSENT_STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* quota / blocked: choice still applies for this page session via the in-memory snapshot */
  }
}

function buildSnapshot(record: ConsentRecord | null, now: number): ConsentSnapshot {
  const reason = evaluatePrompt(record, now);
  const signals = readPrivacySignals();
  const valid = record !== null && reason === 'none';
  return {
    record,
    choices: applySignals(valid ? record.choices : NO_CONSENT, signals),
    signals,
    needsPrompt: reason !== 'none',
    reason,
  };
}

function publish(next: ConsentSnapshot): void {
  const previous = snapshot;
  snapshot = next;
  for (const category of CONSENT_CATEGORIES) {
    const granted = next.choices[category];
    const wasGranted = announced[category];
    if (wasGranted === granted) continue;
    announced[category] = granted;
    // Withdrawal: wipe immediately, but only when something was (or may have been) granted before.
    if (!granted && wasGranted !== false) clearCategoryFootprint(category);
    for (const cb of categoryListeners[category]) cb(granted);
  }
  if (previous !== next) for (const cb of listeners) cb();
}

/** Idempotent. Called lazily by every accessor, so stored consent applies on any route at boot. */
export function initConsent(): void {
  if (initialized) return;
  initialized = true;
  const store = safeStorage('local');
  if (store) {
    for (const key of LEGACY_CONSENT_KEYS) {
      try {
        store.removeItem(key);
      } catch {
        /* ignore */
      }
    }
  }
  const record = readStored();
  // Optional categories always start denied: clear leftovers if there is no valid grant.
  const next = buildSnapshot(record, Date.now());
  for (const category of CONSENT_CATEGORIES) {
    if (!next.choices[category]) clearCategoryFootprint(category);
    announced[category] = null;
  }
  publish(next);
}

export function getConsentSnapshot(): ConsentSnapshot {
  initConsent();
  return snapshot;
}

export function hasConsent(category: ConsentCategory): boolean {
  return getConsentSnapshot().choices[category];
}

export function subscribeConsent(listener: Listener): () => void {
  initConsent();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Calls `cb` immediately with the current value, then whenever the effective value changes. */
export function onCategoryChange(category: ConsentCategory, cb: CategoryListener): () => void {
  initConsent();
  categoryListeners[category].add(cb);
  cb(snapshot.choices[category]);
  return () => {
    categoryListeners[category].delete(cb);
  };
}

function commit(choices: ConsentChoices, source: ConsentSource): ConsentRecord {
  initConsent();
  const previousId = snapshot.record?.subjectId ?? readStored()?.subjectId ?? newId();
  const record: ConsentRecord = {
    version: CONSENT_VERSION,
    timestamp: new Date().toISOString(),
    subjectId: previousId,
    choices: { ...choices },
    source,
    synced: false,
  };
  persist(record);
  publish(buildSnapshot(record, Date.now()));
  return record;
}

export function acceptAll(): ConsentRecord {
  return commit({ analytics: true, marketing: true }, 'accept_all');
}

/** Also used to withdraw consent: as easy as granting, no reload needed. */
export function rejectNonEssential(): ConsentRecord {
  return commit({ analytics: false, marketing: false }, 'reject_all');
}

export function saveChoices(choices: ConsentChoices): ConsentRecord {
  return commit(choices, 'custom');
}

/** Flags the stored record as delivered to the server (only if it is still the same decision). */
export function markConsentSynced(timestamp: string): void {
  const current = snapshot.record;
  if (!current || current.timestamp !== timestamp || current.synced) return;
  const record: ConsentRecord = { ...current, synced: true };
  persist(record);
  snapshot = { ...snapshot, record };
  for (const cb of listeners) cb();
}

export function openConsentPreferences(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_PREFERENCES_EVENT));
}

/** Test-only: forget in-memory state so initConsent() runs again. */
export function __resetConsentForTests(): void {
  initialized = false;
  snapshot = {
    record: null,
    choices: NO_CONSENT,
    signals: { gpc: false, dnt: false },
    needsPrompt: false,
    reason: 'none',
  };
  listeners.clear();
  for (const category of CONSENT_CATEGORIES) {
    categoryListeners[category].clear();
    announced[category] = null;
  }
}
