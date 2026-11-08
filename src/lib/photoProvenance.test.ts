import { describe, expect, it } from 'vitest';
import {
  accuracyClassFor, afterAttempt, evidencePhotoPath, isDue, isPermanentFailure, matchFileHash, normalizeRegions,
  queueBackoffMs, redactionTransform, sha256Hex, shouldRequestLocation, summaryCounts, summaryText, toPixelRect, trustNotes,
  QUEUE_MAX_ATTEMPTS, appendSummaryWithinLimit, photoEvidencePlainLines, photoEvidencePlainText, PHOTO_EVIDENCE_HEADING,
  type PhotoCaptureView, type QueuedCapture,
} from './photoProvenance';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

function view(over: Partial<PhotoCaptureView> = {}): PhotoCaptureView {
  return {
    id: '11111111-1111-4111-8111-111111111111', short_id: '11111111', original_sha256: H1, original_bytes: 10, original_mime: 'image/jpeg',
    capture_source: 'in_app_camera', device_captured_at: '2028-11-03T10:00:00Z', device_time_status: 'ok', server_received_at: '2028-11-03T10:00:02Z',
    time_skew_seconds: 2, offline_queued: false, status: 'unmodified', flags: [],
    location: { status: 'not_requested', accuracy_m: null, accuracy_class: 'unknown', within_job_window: false, purged: false },
    derivatives: [], verification: { chain_ok: true, commit_ok: true, location_commit_ok: null, entry_seq: 3, entry_hash: 'x', prev_hash: 'y' },
    files_erased: false, erasure_requested: false, ...over,
  };
}
function queued(over: Partial<QueuedCapture> = {}): QueuedCapture {
  return {
    id: 'c1', job_id: 'j', owner_id: 'o', source: 'in_app_camera', device_captured_at: '2028-11-03T10:00:00Z', queued_at: null, offline: false,
    location: null, original: { sha256: H1, mime: 'image/jpeg', bytes: 10 }, derivatives: [], state: 'pending', attempts: 0, next_attempt_at: 0, last_error: null, ...over,
  };
}

describe('fingerprints', () => {
  it('sha256Hex matches the known vector for "abc"', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('is sensitive to a single changed byte (tamper detection)', async () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(b));
  });
  it('builds the content-addressed path and rejects bad input', () => {
    expect(evidencePhotoPath('o', 'j', H1, 'image/jpeg')).toBe(`o/j/photo/${H1}.jpg`);
    expect(() => evidencePhotoPath('o', 'j', 'xyz', 'image/jpeg')).toThrow();
    expect(() => evidencePhotoPath('o', 'j', H1, 'application/pdf')).toThrow();
  });
});

describe('derived-hash mapping', () => {
  const c = view({ derivatives: [
    { id: 'd1', kind: 'analysis_resize', sha256: H2, parent_sha256: H1, width: 1600, height: 1200, bytes: 5, created_at: 'x', modified: false, verified: true },
  ] });
  it('maps both the original and a resized copy to the same capture (resizing does not break verification)', () => {
    expect(matchFileHash(H1, [c])).toEqual({ captureId: c.id, shortId: c.short_id, as: 'original' });
    expect(matchFileHash(H2.toUpperCase(), [c])).toEqual({ captureId: c.id, shortId: c.short_id, as: 'analysis_resize' });
  });
  it('returns null for a file that is not on record', () => {
    expect(matchFileHash('c'.repeat(64), [c])).toBeNull();
  });
});

describe('display model', () => {
  it('classifies accuracy', () => {
    expect([5, 20, 21, 100, 101, null, -1, NaN].map((n) => accuracyClassFor(n as number | null))).toEqual(['high', 'high', 'medium', 'medium', 'low', 'unknown', 'unknown', 'unknown']);
  });
  it('flags imported, offline and bad device time honestly', () => {
    const notes = trustNotes(view({ capture_source: 'gallery_import', offline_queued: true, device_time_status: 'future', status: 'imported' }));
    expect(notes).toContain('note.notFromAppCamera');
    expect(notes).toContain('note.offlineDeviceTime');
    expect(notes).toContain('note.deviceTime.future');
  });
  it('warns on clock skew only for online captures', () => {
    expect(trustNotes(view({ time_skew_seconds: 4000 }))).toContain('note.clockSkew');
    expect(trustNotes(view({ time_skew_seconds: 4000, offline_queued: true }))).not.toContain('note.clockSkew');
  });
  it('counts statuses', () => {
    const counts = summaryCounts([view(), view({ status: 'imported' }), view({ status: 'integrity_failed' }), view({ location: { status: 'recorded', accuracy_m: 5, accuracy_class: 'high', within_job_window: true, purged: false } })]);
    expect(counts).toMatchObject({ total: 4, unmodified: 2, imported: 1, integrityFailed: 1, withLocation: 1 });
  });
  it('summaryText never contains coordinates or names and always ends with the honest-limits line', () => {
    const t = (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k);
    const txt = summaryText([view({ location: { status: 'recorded', accuracy_m: 5, accuracy_class: 'high', within_job_window: true, purged: false, coordinates: { latitude: 52.1234, longitude: 13.5678 } } })], t, (i) => i);
    expect(txt).not.toContain('52.1234');
    expect(txt.split('\n').pop()).toBe('limits.summary');
  });
});

describe('location request courtesy gate', () => {
  const base = { capture_location: true, consent_required_configured: true, tracking_gate: 'allowed' as const, can_manage: false, location_retention_days: 90, photo_retention_days: 1095 };
  it('is off when settings are unknown (privacy by default)', () => expect(shouldRequestLocation(null)).toBe(false));
  it('is on only when policy, consent configuration and gate all allow it', () => {
    expect(shouldRequestLocation(base)).toBe(true);
    expect(shouldRequestLocation({ ...base, capture_location: false })).toBe(false);
    expect(shouldRequestLocation({ ...base, consent_required_configured: false })).toBe(false);
    expect(shouldRequestLocation({ ...base, tracking_gate: 'no_consent' })).toBe(false);
    expect(shouldRequestLocation({ ...base, tracking_gate: 'off_duty' })).toBe(false);
  });
});

describe('offline queue state machine', () => {
  const fixed = () => 0.5;
  it('network error keeps the photo, marks it OFFLINE, does not consume attempts, and backs off', () => {
    const next = afterAttempt(queued(), { ok: false, status: null, message: 'Failed to fetch' }, 1_000, fixed);
    expect(next).toMatchObject({ state: 'pending', offline: true, attempts: 0 });
    expect(next.queued_at).toBe(new Date(1_000).toISOString());
    expect(next.next_attempt_at).toBeGreaterThan(1_000);
  });
  it('keeps the ORIGINAL queued_at across retries', () => {
    const first = afterAttempt(queued(), { ok: false, status: null, message: 'x' }, 1_000, fixed);
    const second = afterAttempt(first, { ok: false, status: null, message: 'x' }, 9_000, fixed);
    expect(second.queued_at).toBe(first.queued_at);
  });
  it('server 5xx / 429 / expired session retry with a bounded budget, then fail', () => {
    let item = queued();
    for (let i = 0; i < QUEUE_MAX_ATTEMPTS; i++) item = afterAttempt(item, { ok: false, status: 503, message: 'down' }, i * 1000, fixed);
    expect(item.state).toBe('failed');
    expect(afterAttempt(queued(), { ok: false, status: 401, message: 'exp' }, 0, fixed).state).toBe('pending');
  });
  it('hash mismatch / forbidden stop immediately (no infinite loop)', () => {
    for (const status of [400, 403, 422]) {
      expect(isPermanentFailure(status)).toBe(true);
      expect(afterAttempt(queued(), { ok: false, status, message: 'no' }, 0).state).toBe('failed');
    }
    expect(isPermanentFailure(null)).toBe(false);
  });
  it('success completes; isDue respects the schedule', () => {
    expect(afterAttempt(queued(), { ok: true }, 0).state).toBe('done');
    expect(isDue(queued({ next_attempt_at: 100 }), 99)).toBe(false);
    expect(isDue(queued({ next_attempt_at: 100 }), 100)).toBe(true);
    expect(isDue(queued({ state: 'failed' }), 1e12)).toBe(false);
  });
  it('backoff is capped at ~15 minutes (+jitter)', () => {
    expect(queueBackoffMs(50, () => 1)).toBeLessThanOrEqual(15 * 60_000 * 1.25);
  });
});

describe('redaction geometry', () => {
  it('clamps, reorders negative sizes and drops tiny regions', () => {
    const out = normalizeRegions([
      { x: 0.9, y: 0.9, w: 0.5, h: 0.5, kind: 'person' },
      { x: 0.5, y: 0.5, w: -0.2, h: -0.2, kind: 'sensitive' },
      { x: 0.1, y: 0.1, w: 0.001, h: 0.5, kind: 'person' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].x + out[0].w).toBeLessThanOrEqual(1);
    expect(out[1]).toMatchObject({ x: 0.3, y: 0.3 });
  });
  it('converts to pixels inside the image', () => {
    expect(toPixelRect({ x: 0.5, y: 0.5, w: 0.5, h: 0.5, kind: 'person' }, 101, 101)).toEqual({ x: 50, y: 50, w: 51, h: 51 });
  });
  it('records WHAT was redacted, never WHERE', () => {
    const t = redactionTransform([{ x: 0.1, y: 0.2, w: 0.3, h: 0.3, kind: 'person' }, { x: 0, y: 0, w: 0.2, h: 0.2, kind: 'sensitive' }]);
    expect(t).toEqual({ type: 'redaction', regions: 2, people: 1, sensitive: 1, exif_stripped: true });
    expect(JSON.stringify(t)).not.toContain('0.1');
  });
});

describe('external-reader text (PDF, disputes, proposals)', () => {
  const loc = { status: 'recorded' as const, accuracy_m: 5, accuracy_class: 'high' as const, within_job_window: true, purged: false, coordinates: { latitude: 52.1234, longitude: 13.5678 } };
  it('lists status, both times, fingerprint and limits — never coordinates', () => {
    const lines = photoEvidencePlainLines([view({ location: loc }), view({ status: 'imported', capture_source: 'gallery_import' })]);
    expect(lines[0]).toBe(PHOTO_EVIDENCE_HEADING);
    expect(lines).toHaveLength(5);
    expect(lines[2]).toContain('unmodified since capture');
    expect(lines[2]).toContain('2028-11-03 10:00 UTC');
    expect(lines[2]).toContain('location accuracy high');
    expect(lines[3]).toContain('imported (not taken with the in-app camera)');
    expect(lines[4]).toContain('not that the work was done correctly');
    const text = photoEvidencePlainText([view({ location: loc })]);
    expect(text).not.toContain('52.1234');
    expect(text).not.toContain('13.5678');
  });
  it('caps the list and says how many were omitted', () => {
    const many = Array.from({ length: 35 }, () => view());
    const lines = photoEvidencePlainLines(many, 30);
    expect(lines).toHaveLength(2 + 30 + 1 + 1);
    expect(lines[32]).toBe('…and 5 more photos not listed.');
  });
  it('marks a failed integrity check loudly', () => {
    expect(photoEvidencePlainText([view({ status: 'integrity_failed' })])).toContain('INTEGRITY CHECK FAILED');
  });
  it('appends at the end and is idempotent (second insert replaces the first)', () => {
    const summary = photoEvidencePlainText([view()]);
    const once = appendSummaryWithinLimit('Customer signed the work order.', summary, 20000)!;
    expect(once.startsWith('Customer signed the work order.\n\n')).toBe(true);
    const twice = appendSummaryWithinLimit(once, summary, 20000)!;
    expect(twice).toBe(once);
  });
  it('returns null instead of truncating when it does not fit', () => {
    expect(appendSummaryWithinLimit('x'.repeat(100), photoEvidencePlainText([view()]), 150)).toBeNull();
  });
});
