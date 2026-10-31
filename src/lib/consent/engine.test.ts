import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSENT_MAX_AGE_MS,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  __resetConsentForTests,
  acceptAll,
  applySignals,
  cookieDomainCandidates,
  evaluatePrompt,
  getConsentSnapshot,
  hasConsent,
  onCategoryChange,
  parseConsentRecord,
  rejectNonEssential,
  saveChoices,
  type ConsentRecord,
} from '@/lib/consent/engine';

function setSignals(gpc: boolean, dnt = false) {
  Object.defineProperty(navigator, 'globalPrivacyControl', { value: gpc, configurable: true });
  Object.defineProperty(navigator, 'doNotTrack', { value: dnt ? '1' : null, configurable: true });
}

function stored(partial: Partial<ConsentRecord> = {}): string {
  const record: ConsentRecord = {
    version: CONSENT_VERSION,
    timestamp: new Date().toISOString(),
    subjectId: 'subject-12345678',
    choices: { analytics: true, marketing: true },
    source: 'accept_all',
    synced: false,
    ...partial,
  };
  return JSON.stringify(record);
}

beforeEach(() => {
  localStorage.clear();
  document.cookie.split(';').forEach((c) => {
    const name = c.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
  setSignals(false);
  __resetConsentForTests();
});

afterEach(() => vi.useRealTimers());

describe('defaults', () => {
  it('first visit: everything optional is off and the visitor is prompted', () => {
    const s = getConsentSnapshot();
    expect(s.needsPrompt).toBe(true);
    expect(s.reason).toBe('first_visit');
    expect(hasConsent('analytics')).toBe(false);
    expect(hasConsent('marketing')).toBe(false);
  });

  it('ignores corrupt or tampered storage', () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, '{"version":3,"choices":"yes"}');
    expect(getConsentSnapshot().reason).toBe('first_visit');
    expect(parseConsentRecord('not json')).toBeNull();
  });

  it('removes the legacy v2 record', () => {
    localStorage.setItem('vireek-consent-v2', '{"analytics":true}');
    getConsentSnapshot();
    expect(localStorage.getItem('vireek-consent-v2')).toBeNull();
  });
});

describe('choices', () => {
  it('accept all grants both categories and persists a versioned record with a pseudonymous id', () => {
    const rec = acceptAll();
    expect(hasConsent('analytics')).toBe(true);
    expect(hasConsent('marketing')).toBe(true);
    expect(rec.version).toBe(CONSENT_VERSION);
    expect(rec.subjectId.length).toBeGreaterThanOrEqual(8);
    expect(getConsentSnapshot().needsPrompt).toBe(false);
  });

  it('keeps the same subject id across later decisions', () => {
    const first = acceptAll();
    const second = rejectNonEssential();
    expect(second.subjectId).toBe(first.subjectId);
  });

  it('custom choices are honored per category', () => {
    saveChoices({ analytics: true, marketing: false });
    expect(hasConsent('analytics')).toBe(true);
    expect(hasConsent('marketing')).toBe(false);
  });

  it('restores stored consent on a fresh load', () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, stored());
    expect(hasConsent('analytics')).toBe(true);
  });
});

describe('re-prompt', () => {
  it('prompts again when CONSENT_VERSION changes', () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, stored({ version: CONSENT_VERSION - 1 }));
    const s = getConsentSnapshot();
    expect(s.needsPrompt).toBe(true);
    expect(s.reason).toBe('version_changed');
    expect(hasConsent('analytics')).toBe(false);
  });

  it('prompts again after 12 months, not before', () => {
    const now = Date.now();
    const rec = (age: number) =>
      ({ ...JSON.parse(stored()), timestamp: new Date(now - age).toISOString() }) as ConsentRecord;
    expect(evaluatePrompt(rec(CONSENT_MAX_AGE_MS - 60_000), now)).toBe('none');
    expect(evaluatePrompt(rec(CONSENT_MAX_AGE_MS), now)).toBe('expired');
  });

  it('an expired record grants nothing', () => {
    const old = new Date(Date.now() - CONSENT_MAX_AGE_MS - 1000).toISOString();
    localStorage.setItem(CONSENT_STORAGE_KEY, stored({ timestamp: old }));
    expect(hasConsent('analytics')).toBe(false);
    expect(getConsentSnapshot().reason).toBe('expired');
  });
});

describe('withdrawal', () => {
  it('notifies listeners immediately and wipes cookies and storage without a reload', () => {
    acceptAll();
    document.cookie = '_ga=GA1.1.1; path=/';
    document.cookie = '_ga_ABC123=GS1; path=/';
    localStorage.setItem('vireek-visitor-id', 'x');
    localStorage.setItem('vireek-experiment-assignments', '{}');
    localStorage.setItem('vk_lp_vid', 'v');
    localStorage.setItem('vk_lp_attr:page1', '{}');
    localStorage.setItem('vireek-theme', 'dark');

    const seen: boolean[] = [];
    onCategoryChange('analytics', (g) => seen.push(g));
    rejectNonEssential();

    expect(seen).toEqual([true, false]);
    expect(document.cookie).not.toMatch(/_ga/);
    expect(localStorage.getItem('vireek-visitor-id')).toBeNull();
    expect(localStorage.getItem('vireek-experiment-assignments')).toBeNull();
    expect(localStorage.getItem('vk_lp_vid')).toBeNull();
    expect(localStorage.getItem('vk_lp_attr:page1')).toBeNull();
    expect(localStorage.getItem('vireek-theme')).toBe('dark'); // essential settings survive
    expect(hasConsent('analytics')).toBe(false);
  });

  it('withdrawing only one category leaves the other untouched', () => {
    acceptAll();
    localStorage.setItem('vk_lp_vid', 'v');
    saveChoices({ analytics: false, marketing: true });
    expect(localStorage.getItem('vk_lp_vid')).toBe('v');
  });
});

describe('Global Privacy Control / Do Not Track', () => {
  it('GPC forces marketing off even after Accept All, analytics is unaffected', () => {
    setSignals(true);
    acceptAll();
    expect(hasConsent('marketing')).toBe(false);
    expect(hasConsent('analytics')).toBe(true);
    expect(getConsentSnapshot().signals.gpc).toBe(true);
  });

  it('DNT is treated as a marketing opt-out too', () => {
    setSignals(false, true);
    acceptAll();
    expect(hasConsent('marketing')).toBe(false);
  });

  it('signals never grant consent', () => {
    expect(applySignals({ analytics: false, marketing: false }, { gpc: false, dnt: false })).toEqual({
      analytics: false,
      marketing: false,
    });
  });

  it('a stored marketing grant is overridden when GPC appears later', () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, stored());
    setSignals(true);
    expect(hasConsent('marketing')).toBe(false);
  });
});

describe('cookieDomainCandidates', () => {
  it('lists host and parent domains, never a bare TLD', () => {
    expect(cookieDomainCandidates('app.vireek.com')).toEqual(['app.vireek.com', 'vireek.com']);
    expect(cookieDomainCandidates('localhost')).toEqual(['localhost']);
  });
});
