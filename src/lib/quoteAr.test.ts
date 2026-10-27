import { describe, expect, it } from 'vitest';
import {
  buildModelPath,
  cmToMm,
  compareScale,
  describeArEngagement,
  detectPlatform,
  formatDimensions,
  formatLength,
  friendlyArError,
  inchesToMm,
  metersToDimensions,
  modelSubtitle,
  optionLabel,
  optionRefs,
  parseLengthInput,
  validateDimensions,
  validateModelFiles,
} from '@/lib/quoteAr';
import { isUuid, parseEventBody, previewMatchesOption } from '../../supabase/functions/_shared/quote-ar/engine';

const OWNER = '3f2c9a52-7a6e-4c58-9d0b-2a1f6c3e8b10';
const PREVIEW = '5b4d0c20-3e6f-4081-8cbd-2e3f4a5b6c7d';

describe('validateModelFiles', () => {
  it('requires a .glb and accepts an optional .usdz', () => {
    expect(validateModelFiles(null, null)).toEqual({ ok: false, code: 'GLB_REQUIRED' });
    expect(validateModelFiles({ fileName: 'furnace.obj', sizeBytes: 10 }, null)).toEqual({ ok: false, code: 'GLB_TYPE' });
    expect(validateModelFiles({ fileName: 'Furnace.GLB', sizeBytes: 10 }, null)).toEqual({ ok: true });
    expect(validateModelFiles({ fileName: 'a.glb', sizeBytes: 10 }, { fileName: 'a.usdz', sizeBytes: 10 })).toEqual({ ok: true });
    expect(validateModelFiles({ fileName: 'a.glb', sizeBytes: 10 }, { fileName: 'a.zip', sizeBytes: 10 })).toEqual({ ok: false, code: 'USDZ_TYPE' });
  });

  it('rejects empty and oversized files', () => {
    expect(validateModelFiles({ fileName: 'a.glb', sizeBytes: 0 }, null)).toEqual({ ok: false, code: 'FILE_EMPTY' });
    expect(validateModelFiles({ fileName: 'a.glb', sizeBytes: 40 * 1024 * 1024 + 1 }, null)).toEqual({ ok: false, code: 'FILE_TOO_LARGE' });
  });
});

describe('buildModelPath', () => {
  it('produces exactly the shape the SQL path check accepts', () => {
    const glb = buildModelPath(OWNER, '9c1d2e3f-aaaa-bbbb-cccc-111122223333', 'glb');
    const sql = new RegExp(`^${OWNER}/[A-Za-z0-9._-]{1,120}[.]glb$`);
    expect(glb).toMatch(sql);
    expect(buildModelPath(OWNER, '../../etc/passwd', 'usdz')).toMatch(new RegExp(`^${OWNER}/[A-Za-z0-9._-]{1,120}[.]usdz$`));
  });
});

describe('dimensions + units', () => {
  it('validates real-world sizes and clearance', () => {
    expect(validateDimensions({ widthMm: 600, depthMm: 700, heightMm: 1400 }, 600)).toEqual({ ok: true });
    expect(validateDimensions({ widthMm: 5, depthMm: 700, heightMm: 1400 })).toEqual({ ok: false, code: 'INVALID_DIMENSIONS' });
    expect(validateDimensions({ widthMm: 600.5, depthMm: 700, heightMm: 1400 })).toEqual({ ok: false, code: 'INVALID_DIMENSIONS' });
    expect(validateDimensions({ widthMm: 600, depthMm: 700, heightMm: 1400 }, 3001)).toEqual({ ok: false, code: 'INVALID_CLEARANCE' });
  });

  it('converts and formats lengths without float noise', () => {
    expect(inchesToMm(24)).toBe(610);
    expect(cmToMm(61)).toBe(610);
    expect(formatLength(610, 'in')).toBe('24 in');
    expect(formatLength(610, 'cm')).toBe('61 cm');
    expect(formatLength(1372, 'in')).toBe('54 in');
    expect(formatDimensions({ widthMm: 610, depthMm: 711, heightMm: 1372 }, 'in')).toBe('W 24 in × D 28 in × H 54 in');
  });

  it('parses typed input in the chosen unit', () => {
    expect(parseLengthInput('24', 'in')).toBe(610);
    expect(parseLengthInput('61,5', 'cm')).toBe(615);
    expect(parseLengthInput('', 'in')).toBeNull();
    expect(parseLengthInput('abc', 'cm')).toBeNull();
    expect(parseLengthInput('-3', 'in')).toBeNull();
  });
});

describe('compareScale (the wrong-size guard)', () => {
  const declared = { widthMm: 610, depthMm: 711, heightMm: 1372 };

  it('passes a model that matches, even when rotated', () => {
    expect(compareScale(declared, metersToDimensions(0.61, 1.372, 0.711)).ok).toBe(true);
    expect(compareScale(declared, { widthMm: 711, depthMm: 610, heightMm: 1372 }).ok).toBe(true);
  });

  it('flags a model exported in the wrong units', () => {
    const tiny = compareScale(declared, { widthMm: 1, depthMm: 1, heightMm: 1 });
    const huge = compareScale(declared, { widthMm: 610000, depthMm: 711000, heightMm: 1372000 });
    expect(tiny.ok).toBe(false);
    expect(huge.ok).toBe(false);
  });

  it('flags a model that is 15% off but tolerates small drift', () => {
    expect(compareScale(declared, { widthMm: 700, depthMm: 818, heightMm: 1578 }).ok).toBe(false);
    expect(compareScale(declared, { widthMm: 620, depthMm: 720, heightMm: 1385 }).ok).toBe(true);
  });
});

describe('platform + events', () => {
  it('detects the AR platform', () => {
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('ios');
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios'); // iPadOS
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('desktop');
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('android');
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('desktop');
    expect(detectPlatform('')).toBe('other');
  });

  it('parses and rejects event bodies', () => {
    expect(isUuid(PREVIEW)).toBe(true);
    expect(parseEventBody({ preview_id: PREVIEW, event: 'ar_launched', platform: 'ios' })).toEqual({
      ok: true,
      previewId: PREVIEW,
      event: 'ar_launched',
      platform: 'ios',
    });
    expect(parseEventBody({ preview_id: PREVIEW, event: 'viewed', platform: 'toaster' })).toMatchObject({ ok: true, platform: null });
    expect(parseEventBody({ preview_id: PREVIEW, event: 'hacked' })).toEqual({ ok: false, error: 'INVALID_EVENT' });
    expect(parseEventBody({ preview_id: 'nope', event: 'viewed' })).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(parseEventBody(null)).toEqual({ ok: false, error: 'NOT_FOUND' });
  });
});

describe('option helpers + copy', () => {
  it('extracts option refs defensively', () => {
    expect(optionRefs(null)).toEqual([]);
    expect(optionRefs([{ id: 'a', name: ' Good ' }, { id: 'b', tier: 'best' }, { name: 'no id' }, 7])).toEqual([
      { id: 'a', name: 'Good' },
      { id: 'b', name: 'best' },
    ]);
  });

  it('labels option scope', () => {
    const refs = [{ id: 'a', name: 'Better' }];
    expect(optionLabel(null, refs)).toBe('All options');
    expect(optionLabel('a', refs)).toBe('Better');
    expect(optionLabel('gone', refs)).toBe('Removed option');
    expect(previewMatchesOption(null, 'a')).toBe(true);
    expect(previewMatchesOption('a', 'b')).toBe(false);
  });

  it('describes engagement and subtitles', () => {
    expect(describeArEngagement({ view_count: 0, ar_launch_count: 0 })).toEqual({ label: 'Not opened yet', tone: 'neutral' });
    expect(describeArEngagement({ view_count: 3, ar_launch_count: 0 })).toEqual({ label: 'Viewed ×3', tone: 'warning' });
    expect(describeArEngagement({ view_count: 3, ar_launch_count: 2 })).toEqual({ label: 'Tried in AR ×2', tone: 'success' });
    expect(modelSubtitle({ brand: 'Carrier', model_number: '24ACC6' })).toBe('Carrier · 24ACC6');
    expect(modelSubtitle({ brand: null, model_number: null })).toBe('');
  });

  it('maps stable server codes to friendly copy', () => {
    expect(friendlyArError('PREVIEW_LIMIT')).toMatch(/6 AR previews/);
    expect(friendlyArError('error: QUOTE_CLOSED (raised by rpc)')).toMatch(/answered/);
    expect(friendlyArError('totally unknown')).toMatch(/try again/i);
    expect(friendlyArError(null, 'fallback')).toBe('fallback');
  });
});
