import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accelaAdapter,
  getPortalAdapter,
  openGovAdapter,
  resolveSubmissionMode,
  type PortalSubmission,
} from '@/lib/permitPortals';
import { summarizeDocuments } from '@/lib/permitDocuments';

// Pure-logic tests: keep the real Supabase client (and its env requirements) out of the unit run.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const submission = (over: Partial<PortalSubmission> = {}): PortalSubmission => ({
  applicationId: 'app-1',
  permitType: 'electrical',
  authorityId: 'auth-1',
  portalUrl: 'https://permits.example.test',
  formName: null,
  scopeDescription: null,
  applicationData: {},
  documents: [],
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe('portal adapter stubs', () => {
  it.each([accelaAdapter, openGovAdapter])('$displayName is never connected and never reports success', async (a) => {
    expect(a.connected).toBe(false);
    expect(a.capabilities).toHaveLength(0);
    const res = await a.submit(submission());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_connected');
    const st = await a.fetchStatus('REF-1');
    expect(st.ok).toBe(false);
  });

  it('makes no network calls', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await accelaAdapter.submit(submission());
    await openGovAdapter.fetchStatus('REF-1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('validates input before reporting not_connected', async () => {
    const noApp = await accelaAdapter.submit(submission({ applicationId: ' ' }));
    const noAuthority = await accelaAdapter.submit(submission({ authorityId: '' }));
    const insecure = await accelaAdapter.submit(submission({ portalUrl: 'http://x.test' }));
    const noRef = await openGovAdapter.fetchStatus('  ');
    for (const r of [noApp, noAuthority, insecure, noRef]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('invalid_input');
    }
  });
});

describe('registry and submission mode', () => {
  it('returns adapters only for accela and opengov', () => {
    expect(getPortalAdapter('accela')).toBe(accelaAdapter);
    expect(getPortalAdapter('opengov')).toBe(openGovAdapter);
    for (const s of ['energov', 'cityview', 'email', 'in_person', 'mail', 'other'] as const) {
      expect(getPortalAdapter(s)).toBeNull();
    }
  });

  it('falls back to manual tracking for every system today', () => {
    for (const s of ['accela', 'opengov', 'energov', 'email', 'in_person', 'mail', 'other'] as const) {
      const m = resolveSubmissionMode(s);
      expect(m.mode).toBe('manual');
    }
  });
});

describe('document checklist summary', () => {
  it('is not ready with no required documents', () => {
    expect(summarizeDocuments([]).readyToFile).toBe(false);
    expect(summarizeDocuments([{ required: false, status: 'needed' }]).readyToFile).toBe(false);
  });

  it('is ready only when all required documents are attached or later and none rejected', () => {
    const ok = summarizeDocuments([
      { required: true, status: 'attached' },
      { required: true, status: 'accepted' },
      { required: false, status: 'needed' },
    ]);
    expect(ok).toMatchObject({ total: 3, requiredTotal: 2, requiredReady: 2, readyToFile: true });

    expect(summarizeDocuments([{ required: true, status: 'needed' }]).readyToFile).toBe(false);
    expect(
      summarizeDocuments([
        { required: true, status: 'attached' },
        { required: false, status: 'rejected' },
      ]).readyToFile,
    ).toBe(false);
  });
});
