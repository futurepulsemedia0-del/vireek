import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const upload = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));
vi.mock('@/lib/propertyVision', () => ({ uploadPropertyPhoto: (...a: unknown[]) => upload(...a) }));

import {
  NAMEPLATE_KIND_OPTIONS, createFromNameplate, draftFromScan, manufactureInput, manufactureLabel, reviewReasonMessage,
  scanNameplate, warrantyBadge, type NameplateReviewReason, type NameplateScan,
} from './equipmentNameplate';
import { KIND_LABEL } from '../../supabase/functions/_shared/property-vision/nameplate';

const scan = (over: Partial<NameplateScan['fields']> = {}): Pick<NameplateScan, 'fields'> => ({
  fields: {
    plate_found: true, kind: 'furnace', make: 'Lennox', model: 'ML180', serial: '5612A12345', serial_legibility: 'clear', specs: null,
    manufacture: { date: '2019-03-01', precision: 'month', raw_text: '03/2019', problem: null }, confidence: 0.9, photo_issues: [], ...over,
  },
});

beforeEach(() => {
  invoke.mockReset();
  upload.mockReset();
});

describe('manufacture date helpers', () => {
  it('round-trips precision between the server value and the form/label', () => {
    expect(manufactureInput('2019-03-01', 'month')).toBe('2019-03');
    expect(manufactureInput('2019-01-01', 'year')).toBe('2019');
    expect(manufactureInput('2019-03-14', 'day')).toBe('2019-03-14');
    expect(manufactureInput(null, null)).toBe('');
    expect(manufactureLabel('2019-03-01', 'month')).toBe('03/2019');
    expect(manufactureLabel('2019-01-01', 'year')).toBe('2019');
    expect(manufactureLabel('2019-03-14', 'day')).toBe('03/14/2019');
    expect(manufactureLabel(undefined, undefined)).toBeNull();
  });

  it('prefills the review draft from the read', () => {
    expect(draftFromScan(scan())).toEqual({ make: 'Lennox', model: 'ML180', serial: '5612A12345', kind: 'furnace', manufactureDate: '2019-03', installDate: '' });
    expect(draftFromScan(scan({ make: null, model: null, serial: null, manufacture: { date: null, precision: null, raw_text: null, problem: null } })))
      .toMatchObject({ make: '', model: '', serial: '', manufactureDate: '' });
  });
});

describe('copy', () => {
  it('has a message for every review reason', () => {
    const reasons: NameplateReviewReason[] = ['no_plate', 'missing_make', 'missing_serial', 'serial_partial', 'serial_unreadable', 'low_confidence', 'missing_model', 'date_ambiguous', 'date_future', 'date_invalid'];
    for (const r of reasons) expect(reviewReasonMessage(r).length).toBeGreaterThan(10);
  });

  it('describes each warranty state honestly (always "likely")', () => {
    expect(warrantyBadge({ state: 'active', days_left: 900, expires_at: '2029-03-01' })).toEqual({ label: 'Likely under warranty until 2029-03-01', tone: 'success' });
    expect(warrantyBadge({ state: 'expiring', days_left: 1, expires_at: '2026-10-19' })).toEqual({ label: 'Warranty likely ends in 1 day', tone: 'warning' });
    expect(warrantyBadge({ state: 'expiring', days_left: 0, expires_at: '2026-10-18' }).label).toBe('Warranty likely ends in 0 days');
    expect(warrantyBadge({ state: 'expired', days_left: -5, expires_at: '2024-03-01' })).toEqual({ label: 'Warranty likely expired 2024-03-01', tone: 'danger' });
    expect(warrantyBadge({ state: 'unknown', days_left: null, expires_at: null })).toEqual({ label: 'Warranty status unknown', tone: 'neutral' });
  });

  it('offers exactly the equipment types the server accepts', () => {
    expect(NAMEPLATE_KIND_OPTIONS.map((o) => o.value).sort()).toEqual(Object.keys(KIND_LABEL).sort());
    for (const o of NAMEPLATE_KIND_OPTIONS) expect(o.label).toBe(KIND_LABEL[o.value]);
  });
});

describe('API', () => {
  it('uploads privately, then sends only the fields the server needs', async () => {
    const photo = { path: 'o/aa/x.jpg', sha256: 'a'.repeat(64), mime: 'image/jpeg', bytes: 10, capturedAt: 'now', latitude: 1, longitude: 2 };
    upload.mockResolvedValue(photo);
    invoke.mockResolvedValue({ data: { scan: { id: 's1' }, created: null }, error: null });
    const file = new File(['x'], 'plate.jpg', { type: 'image/jpeg' });
    const r = await scanNameplate({ file, jobId: 'job-1' });
    expect(upload).toHaveBeenCalledWith(file, null); // no GPS: it is a label photo, not a site photo
    expect(invoke).toHaveBeenCalledWith('equipment-nameplate-scan', {
      body: { jobId: 'job-1', customerId: null, autoCreate: true, capture: { path: photo.path, sha256: photo.sha256, mime: photo.mime, bytes: photo.bytes } },
    });
    expect(r.scan.id).toBe('s1');
  });

  it('sends reviewed corrections to the create action', async () => {
    invoke.mockResolvedValue({ data: { scan: { id: 's1' }, created: { equipment_id: 'e1' } }, error: null });
    await createFromNameplate('s1', { make: 'Lennox', model: '', serial: '5612A12345', kind: 'furnace', manufactureDate: '2019-03', installDate: '' });
    expect(invoke).toHaveBeenCalledWith('equipment-nameplate-scan', {
      body: { action: 'create', scanId: 's1', fields: { make: 'Lennox', model: '', serial: '5612A12345', kind: 'furnace', manufactureDate: '2019-03', installDate: '' } },
    });
  });

  it("surfaces the server's friendly message instead of the generic non-2xx text", async () => {
    invoke.mockResolvedValue({ data: null, error: { context: new Response(JSON.stringify({ error: 'Job not found.' }), { status: 404 }) } });
    await expect(createFromNameplate('s1', { make: 'x', model: '', serial: '', kind: 'other', manufactureDate: '', installDate: '' })).rejects.toThrow('Job not found.');
  });

  it('falls back to a generic message when the error has no body, and honours data.error', async () => {
    invoke.mockResolvedValue({ data: null, error: new Error('FunctionsHttpError') });
    await expect(createFromNameplate('s1', { make: 'x', model: '', serial: '', kind: 'other', manufactureDate: '', installDate: '' })).rejects.toThrow(/try again/i);
    invoke.mockResolvedValue({ data: { error: 'Nope.' }, error: null });
    await expect(createFromNameplate('s1', { make: 'x', model: '', serial: '', kind: 'other', manufactureDate: '', installDate: '' })).rejects.toThrow('Nope.');
  });

  it('does not call the server when the upload fails', async () => {
    upload.mockRejectedValue(new Error('This photo is too large even after compression. Try a smaller one.'));
    await expect(scanNameplate({ file: new File(['x'], 'p.jpg', { type: 'image/jpeg' }), jobId: 'j' })).rejects.toThrow(/too large/);
    expect(invoke).not.toHaveBeenCalled();
  });
});
