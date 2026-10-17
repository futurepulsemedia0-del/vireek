import { describe, expect, it, vi } from 'vitest';
import {
  buildChecklistSnapshot,
  canManageInspectionReports as serverCan,
  checklistProgress,
  clampShareDays,
  clip,
  collectPhotos,
  deriveOverallResult,
  isPdfStale,
  isSafeStoragePath,
  isUuid,
  makeReportNumber,
  mergePhotoEdits,
  shareState,
  type ReportPhoto,
} from '../../supabase/functions/_shared/inspection/reportEngine';
import { canManageInspectionReports, type ReportFull } from './inspectionReports';
import { buildInspectionReportPdf } from './inspectionReportPdf';
import type { UserPermissions } from '@/contexts/AuthContext';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const NO_PERMS: UserPermissions = {
  can_view_billing: false,
  can_manage_numbers: false,
  can_manage_team: false,
  can_edit_business_profile: false,
  can_view_all_jobs: false,
  can_view_audit_log: false,
  can_manage_security: false,
};

describe('permission gate', () => {
  it('client: owner or can_view_all_jobs', () => {
    expect(canManageInspectionReports(true, NO_PERMS)).toBe(true);
    expect(canManageInspectionReports(false, NO_PERMS)).toBe(false);
    expect(canManageInspectionReports(false, { ...NO_PERMS, can_view_all_jobs: true })).toBe(true);
  });

  it('server: custom role overrides the member flag', () => {
    expect(serverCan({ role: 'owner' })).toBe(true);
    expect(serverCan({ role: 'member', teamPermissions: { can_view_all_jobs: true } })).toBe(true);
    expect(
      serverCan({ role: 'member', teamPermissions: { can_view_all_jobs: true }, customRolePermissions: { can_view_all_jobs: false } }),
    ).toBe(false);
    expect(serverCan({ role: 'member' })).toBe(false);
  });
});

describe('checklist snapshot (real job data only)', () => {
  const templates = [
    { id: 't2', item_label: 'Check filter', sort_order: 2 },
    { id: 't1', item_label: 'Test thermostat', sort_order: 1 },
    { id: 't3', item_label: 'Photograph unit', sort_order: 3 },
  ];

  it('orders by sort_order and marks completions', () => {
    const items = buildChecklistSnapshot(templates, [{ template_item_id: 't1', completed_at: '2026-10-01T10:00:00Z' }]);
    expect(items.map((i) => i.label)).toEqual(['Test thermostat', 'Check filter', 'Photograph unit']);
    expect(items.map((i) => i.done)).toEqual([true, false, false]);
    expect(items[0].completed_at).toBe('2026-10-01T10:00:00Z');
  });

  it('empty stays empty (nothing invented)', () => {
    expect(buildChecklistSnapshot([], [])).toEqual([]);
    expect(checklistProgress([])).toEqual({ done: 0, total: 0, percent: 0 });
  });

  it('progress percent rounds', () => {
    const items = buildChecklistSnapshot(templates, [{ template_item_id: 't1', completed_at: 'x' }]);
    expect(checklistProgress(items)).toEqual({ done: 1, total: 3, percent: 33 });
  });
});

describe('overall result suggestion', () => {
  const done = [{ label: 'a', done: true, completed_at: null }];
  const open = [{ label: 'a', done: false, completed_at: null }];

  it('null with no data at all', () => expect(deriveOverallResult([], null)).toBeNull());
  it('pass when everything is complete', () => expect(deriveOverallResult(done, { verdict: 'pass' })).toBe('pass'));
  it('attention for incomplete checklist or needs_attention', () => {
    expect(deriveOverallResult(open, null)).toBe('attention');
    expect(deriveOverallResult(done, { verdict: 'needs_attention' })).toBe('attention');
  });
  it('a failed evidence check always wins', () => expect(deriveOverallResult(done, { verdict: 'fail' })).toBe('fail'));
  it('evidence alone can produce a result', () => expect(deriveOverallResult([], { verdict: 'pass' })).toBe('pass'));
});

describe('photos', () => {
  it('rejects traversal, absolute and url paths', () => {
    for (const bad of ['../x.jpg', '/abs/x.jpg', 'https://evil.com/x.jpg', 'a\\b.jpg', '', 42, null]) {
      expect(isSafeStoragePath(bad)).toBe(false);
    }
    expect(isSafeStoragePath('user/123-abc.jpg')).toBe(true);
  });

  it('collects by section, dedupes and caps', () => {
    const photos = collectPhotos({
      before: ['u/1.jpg', 'u/1.jpg', '../bad.jpg'],
      after: ['u/2.jpg'],
      evidence: ['u/3.jpg', 'u/1.jpg'],
    });
    expect(photos.map((p) => `${p.section}:${p.path}`)).toEqual(['before:u/1.jpg', 'after:u/2.jpg', 'evidence:u/3.jpg', 'evidence:u/1.jpg']);
    expect(photos[2].bucket).toBe('job-evidence-photos');
    expect(collectPhotos({ before: Array.from({ length: 50 }, (_, i) => `u/${i}.jpg`), max: 5 })).toHaveLength(5);
    expect(collectPhotos({ before: 'nope' })).toEqual([]);
  });

  it('edits only touch known paths and clip captions', () => {
    const existing: ReportPhoto[] = [{ bucket: 'job-room-photos', path: 'u/1.jpg', section: 'before', caption: '', include: true }];
    const merged = mergePhotoEdits(existing, [
      { path: 'u/1.jpg', caption: 'x'.repeat(500), include: false },
      { path: 'u/forged.jpg', caption: 'hack', include: true },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].caption).toHaveLength(200);
    expect(merged[0].include).toBe(false);
    expect(mergePhotoEdits(existing, 'garbage')).toBe(existing);
  });
});

describe('sharing rules', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const base = { share_enabled: true, share_expires_at: '2026-10-20T00:00:00Z' };

  it('drafts and voided reports never share', () => {
    expect(shareState({ ...base, status: 'draft' }, now)).toBe('unpublished');
    expect(shareState({ ...base, status: 'voided' }, now)).toBe('voided');
  });
  it('published reports: active, disabled, expired', () => {
    expect(shareState({ ...base, status: 'published' }, now)).toBe('active');
    expect(shareState({ ...base, status: 'signed' }, now)).toBe('active');
    expect(shareState({ ...base, share_enabled: false, status: 'published' }, now)).toBe('disabled');
    expect(shareState({ ...base, share_expires_at: '2026-10-01T00:00:00Z', status: 'published' }, now)).toBe('expired');
    expect(shareState({ ...base, share_expires_at: null, status: 'published' }, now)).toBe('active');
  });
  it('expiry days are clamped', () => {
    expect(clampShareDays(undefined)).toBe(30);
    expect(clampShareDays(0)).toBe(30);
    expect(clampShareDays(7)).toBe(7);
    expect(clampShareDays(9999)).toBe(90);
  });
  it('detects a stale PDF', () => {
    expect(isPdfStale('2026-10-08T12:00:10Z', '2026-10-08T12:00:00Z')).toBe(true);
    expect(isPdfStale('2026-10-08T12:00:00Z', '2026-10-08T12:00:00Z')).toBe(false);
    expect(isPdfStale('2026-10-08T12:00:10Z', null)).toBe(false);
  });
});

describe('misc helpers', () => {
  it('report number is stable and readable', () => {
    expect(makeReportNumber('abcdef12-0000-0000-0000-000000000000', new Date('2026-10-08T00:00:00Z'))).toBe('IR-261008-ABCDEF');
  });
  it('uuid validation guards the public token', () => {
    expect(isUuid('3f2b8c1e-5d4a-4b7e-9c1d-2a3b4c5d6e7f')).toBe(true);
    expect(isUuid("x' or 1=1 --")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
  it('clip strips control characters and bounds length', () => {
    expect(clip('a\u0000b\r\nc', 10)).toBe('ab\nc');
    expect(clip('x'.repeat(50), 5)).toBe('xxxxx');
  });
});

describe('PDF builder', () => {
  const report: ReportFull = {
    id: 'r1',
    job_id: 'j1',
    customer_id: null,
    report_number: 'IR-261008-ABCDEF',
    title: 'HVAC report — Jane Doe',
    status: 'published',
    overall_result: 'attention',
    summary: 'Unit runs but the filter is clogged.\nRecommend replacement.',
    checklist: [
      { label: 'Test thermostat', done: true, completed_at: '2026-10-01T10:00:00Z' },
      { label: 'Replace filter', done: false, completed_at: null },
    ],
    photos: [],
    evidence: { verdict: 'needs_attention', completeness: 0.8, summary: 'Filter not visible.', safety_flag_count: 1, checked_at: '2026-10-01T10:00:00Z' },
    customer_name: 'Jane Doe',
    customer_email: null,
    customer_phone: null,
    address: '12 Main St',
    service_type: 'HVAC',
    inspector_name: 'Sam',
    inspected_at: '2026-10-01T09:00:00Z',
    created_at: '2026-10-01T09:00:00Z',
    updated_at: '2026-10-01T09:00:00Z',
    published_at: null,
    signed_at: null,
    share_enabled: true,
    share_expires_at: null,
    share_token: '3f2b8c1e-5d4a-4b7e-9c1d-2a3b4c5d6e7f',
    view_count: 0,
    last_viewed_at: null,
    pdf_path: null,
    pdf_generated_at: null,
  };

  it('produces a real PDF with no photos and with a signature block', async () => {
    const blob = await buildInspectionReportPdf({
      report,
      businessName: 'Acme HVAC',
      photos: [],
      signature: { id: 's1', status: 'sent', sent_at: null, completed_at: null, expires_at: null, signers: [{ name: 'Jane Doe', role: 'signer', status: 'pending', signed_at: null }] },
      shareUrl: 'https://example.com/inspection/x',
    });
    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBeGreaterThan(1500);
    const head = await new Promise<string>((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.readAsText(blob.slice(0, 5));
    });
    expect(head).toBe('%PDF-');
  });

  it('handles an empty checklist and a long summary across pages', async () => {
    const blob = await buildInspectionReportPdf({
      report: { ...report, checklist: [], evidence: null, summary: 'Long line. '.repeat(900) },
      businessName: null,
      photos: [],
      signature: null,
    });
    expect(blob.size).toBeGreaterThan(3000);
  });
});
