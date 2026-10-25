import { describe, expect, it } from 'vitest';
import {
  buildAuditBundle, buildCsv, csvCell, deliveryRate, driftReasonText, exportFileName, formatOffset,
  needsAttention, normalizeSummary, rangeBounds, shortHash, EMPTY_SUMMARY, type LedgerRow,
} from './aiDisclosureLedger';

const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  id: 'r1', vapi_call_id: 'vc1', call_id: 'c1', version_id: 'v1', language: 'en', selection_reason: 'default_fallback',
  disclosure_text: 'This call is answered by an AI, "really".', disclosure_sha256: 'a'.repeat(64), status: 'delivered',
  matched_via: 'planned', delivered_at: '2027-01-01T10:00:01.500Z', offset_seconds: 1.5, transcript_char_offset: 4,
  matched_turn_index: 0, match_score: 1, evidence_excerpt: 'Hello\nthere', transcript_sha256: 'b'.repeat(64),
  detected_language: null, language_mismatch: false, call_started_at: '2027-01-01T10:00:00.000Z', call_duration_seconds: 90,
  alerted_at: null, created_at: '2027-01-01T10:01:30.000Z', ...over,
});

describe('csvCell', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('x\ny')).toBe('"x\ny"');
  });
  it('neutralises formula injection', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@a')).toBe("'@a");
  });
  it('renders null, booleans and numbers', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(false)).toBe('false');
    expect(csvCell(0)).toBe('0');
  });
});

describe('buildCsv', () => {
  it('starts with a BOM, has one header and one line per row (CRLF)', () => {
    const csv = buildCsv([row(), row({ vapi_call_id: 'vc2', status: 'missing' })]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.trimEnd().split('\r\n')).toHaveLength(3);
    expect(csv).toContain('vapi_call_id');
    expect(csv).toContain('"This call is answered by an AI, ""really""."');
  });
});

describe('summary helpers', () => {
  it('computes delivery rate over verifiable calls only', () => {
    expect(deliveryRate({ ...EMPTY_SUMMARY, delivered: 9, missing: 1, not_applicable: 5, no_transcript: 3 })).toBe(0.9);
    expect(deliveryRate(EMPTY_SUMMARY)).toBeNull();
  });
  it('counts what needs attention', () => {
    expect(needsAttention({ ...EMPTY_SUMMARY, missing: 2, late: 1, partial: 1, delivered: 9 })).toBe(4);
  });
  it('normalises junk RPC output to zeros', () => {
    expect(normalizeSummary(null)).toEqual(EMPTY_SUMMARY);
    expect(normalizeSummary({ total: 'x', delivered: 3 }).delivered).toBe(3);
  });
});

describe('formatting', () => {
  it('formats offsets and hashes', () => {
    expect(formatOffset(1.5)).toBe('00:01.5');
    expect(formatOffset(125.25)).toBe('02:05.3');
    expect(formatOffset(null)).toBe('—');
    expect(shortHash('a'.repeat(64))).toBe('aaaaaaaa…aaaaaa');
  });
  it('builds sane ranges and file names', () => {
    const now = new Date('2027-01-31T12:00:00Z');
    expect(rangeBounds('7d', now).from).toBe('2027-01-24T12:00:00.000Z');
    expect(exportFileName('csv', '30d', now)).toBe('vireek-ai-disclosure-audit-30d-2027-01-31.csv');
  });
  it('explains drift reasons in plain language', () => {
    expect(driftReasonText('disclosure_missing')).toContain('doesn');
    expect(driftReasonText('first_message_mode_assistant-waits-for-user')).toContain('waits');
    expect(driftReasonText(null)).toBe('');
  });
});

describe('buildAuditBundle', () => {
  it('includes metadata, versions, drift history and a tamper-evident hash of the calls', async () => {
    const rows = [row()];
    const b = await buildAuditBundle({
      range: { from: 'a', to: 'b' }, summary: { ...EMPTY_SUMMARY, total: 1, delivered: 1 }, versions: [], drift: [], rows,
      now: new Date('2027-02-01T00:00:00Z'),
    });
    expect(b.report).toBe('vireek.ai_disclosure_audit');
    expect(b.delivery_rate).toBe(1);
    expect(b.calls_sha256).toHaveLength(64);
    expect(b.generated_at).toBe('2027-02-01T00:00:00.000Z');
  });
});
