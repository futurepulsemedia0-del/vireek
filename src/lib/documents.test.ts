import { describe, expect, it } from 'vitest';
import {
  MAX_DOCUMENT_BYTES,
  buildStoragePath,
  daysUntil,
  describeExpiry,
  expirySortKey,
  filterDocuments,
  formatFileSize,
  getExpiryState,
  parseDateOnly,
  resolveMimeType,
  sanitizeFileName,
  summarizeDocuments,
  validateDocumentFile,
  validateDocumentInput,
  type DocumentInput,
  type DocumentRecord,
} from './documents';

// Fixed "today": 15 Jun 2026, mid-afternoon local time.
const NOW = new Date(2026, 5, 15, 15, 30, 0);

function doc(overrides: Partial<DocumentRecord>): DocumentRecord {
  return {
    id: 'd1',
    user_id: 'owner-1',
    customer_id: null,
    title: 'Doc',
    category: 'license',
    reference_number: null,
    issuer: null,
    issued_on: null,
    expires_on: null,
    alert_days: 30,
    notes: null,
    current_version_id: null,
    version_count: 0,
    current_file_name: null,
    current_file_size: null,
    current_mime_type: null,
    last_alert_stage: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('date handling', () => {
  it('parses date-only strings as local calendar dates', () => {
    const d = parseDateOnly('2026-06-15');
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(5);
    expect(d?.getDate()).toBe(15);
  });

  it('rejects empty / malformed input', () => {
    expect(parseDateOnly(null)).toBeNull();
    expect(parseDateOnly('')).toBeNull();
    expect(parseDateOnly('15/06/2026')).toBeNull();
  });

  it('counts whole calendar days regardless of time of day', () => {
    expect(daysUntil('2026-06-15', NOW)).toBe(0);
    expect(daysUntil('2026-06-16', NOW)).toBe(1);
    expect(daysUntil('2026-06-14', NOW)).toBe(-1);
    expect(daysUntil('2026-07-15', NOW)).toBe(30);
    expect(daysUntil(null, NOW)).toBeNull();
  });
});

describe('expiry state', () => {
  it('is "none" without an expiry date', () => {
    expect(getExpiryState(null, 30, NOW)).toBe('none');
  });

  it('is "expired" only once the date has fully passed', () => {
    expect(getExpiryState('2026-06-14', 30, NOW)).toBe('expired');
    expect(getExpiryState('2026-06-15', 30, NOW)).toBe('expiring'); // expires today = still valid today
  });

  it('opens the alert window exactly alert_days before expiry', () => {
    expect(getExpiryState('2026-07-15', 30, NOW)).toBe('expiring'); // 30 days out
    expect(getExpiryState('2026-07-16', 30, NOW)).toBe('valid'); // 31 days out
    expect(getExpiryState('2026-06-22', 7, NOW)).toBe('expiring');
    expect(getExpiryState('2026-06-23', 7, NOW)).toBe('valid');
  });

  it('describes expiry in plain language', () => {
    expect(describeExpiry(null, NOW)).toBe('No expiry date');
    expect(describeExpiry('2026-06-15', NOW)).toBe('Expires today');
    expect(describeExpiry('2026-06-16', NOW)).toBe('Expires tomorrow');
    expect(describeExpiry('2026-06-25', NOW)).toBe('Expires in 10 days');
    expect(describeExpiry('2026-06-14', NOW)).toBe('Expired 1 day ago');
    expect(describeExpiry('2026-06-10', NOW)).toBe('Expired 5 days ago');
  });

  it('sorts the most urgent first and undated last', () => {
    const list = [
      doc({ id: 'none' }),
      doc({ id: 'later', expires_on: '2026-09-01' }),
      doc({ id: 'expired', expires_on: '2026-05-01' }),
      doc({ id: 'soon', expires_on: '2026-06-20' }),
    ];
    const ids = [...list]
      .sort((a, b) => expirySortKey(a, NOW) - expirySortKey(b, NOW))
      .map((d) => d.id);
    expect(ids).toEqual(['expired', 'soon', 'later', 'none']);
  });
});

describe('file validation', () => {
  const pdf = { name: 'license.pdf', type: 'application/pdf', size: 1024 };

  it('accepts supported files', () => {
    expect(validateDocumentFile(pdf)).toBeNull();
    expect(validateDocumentFile({ name: 'a.docx', type: '', size: 10 })).toBeNull(); // empty type → falls back to extension
  });

  it('rejects empty, oversized and unsupported files', () => {
    expect(validateDocumentFile({ ...pdf, size: 0 })).toMatch(/empty/i);
    expect(validateDocumentFile({ ...pdf, size: MAX_DOCUMENT_BYTES + 1 })).toMatch(/25/);
    expect(
      validateDocumentFile({ name: 'run.exe', type: 'application/x-msdownload', size: 10 }),
    ).toMatch(/unsupported/i);
    expect(validateDocumentFile({ name: 'noext', type: '', size: 10 })).toMatch(/unsupported/i);
  });

  it('rejects unsupported extensions even when the browser reports an allowed type', () => {
    expect(resolveMimeType({ name: 'x.exe', type: 'application/pdf' })).toBeNull();
    expect(resolveMimeType({ name: 'scan', type: 'image/jpeg' })).toBe('image/jpeg'); // some Android cameras omit the extension
    expect(resolveMimeType({ name: 'a.PDF', type: '' })).toBe('application/pdf');
  });

  it('formats sizes', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatFileSize(null)).toBe('—');
  });
});

describe('storage paths', () => {
  it('produces ASCII-safe names and keeps the extension', () => {
    expect(sanitizeFileName('My License (final).PDF')).toBe('My_License_final.pdf');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\temp\\contract v2.docx')).toBe('contract_v2.docx');
  });

  it('never returns an empty name (e.g. non-Latin file names)', () => {
    const out = sanitizeFileName('گواهینامه.pdf');
    expect(out).toMatch(/^file\.pdf$/);
    expect(sanitizeFileName('???')).toBe('file');
  });

  it('caps very long names', () => {
    expect(sanitizeFileName(`${'a'.repeat(300)}.pdf`).length).toBeLessThanOrEqual(91);
  });

  it('scopes every path under the ACCOUNT OWNER folder', () => {
    const path = buildStoragePath('owner-1', 'doc-9', 'ver-3', 'Policy 2026.pdf');
    expect(path).toBe('owner-1/doc-9/ver-3-Policy_2026.pdf');
    expect(path.split('/')[0]).toBe('owner-1');
  });
});

describe('input validation', () => {
  const base: DocumentInput = {
    title: 'GL policy',
    category: 'insurance',
    reference_number: '',
    issuer: '',
    issued_on: '',
    expires_on: '',
    alert_days: 30,
    notes: '',
    customer_id: null,
  };

  it('requires a title', () => {
    expect(validateDocumentInput({ ...base, title: '   ' })).toMatch(/title/i);
    expect(validateDocumentInput(base)).toBeNull();
  });

  it('rejects an expiry before the issue date', () => {
    expect(
      validateDocumentInput({ ...base, issued_on: '2026-06-10', expires_on: '2026-06-09' }),
    ).toMatch(/before/i);
    expect(
      validateDocumentInput({ ...base, issued_on: '2026-06-10', expires_on: '2026-06-10' }),
    ).toBeNull();
  });
});

describe('filtering & summary', () => {
  const list = [
    doc({
      id: 'a',
      title: 'Contractor License',
      category: 'license',
      expires_on: '2026-06-01',
      reference_number: 'LIC-77',
    }),
    doc({
      id: 'b',
      title: 'GL Insurance',
      category: 'insurance',
      expires_on: '2026-06-30',
      issuer: 'Acme Mutual',
    }),
    doc({
      id: 'c',
      title: 'Service Agreement',
      category: 'contract',
      expires_on: '2027-01-01',
      customer_id: 'cust-1',
      customer: { id: 'cust-1', name: 'Jane Smith' },
    }),
    doc({ id: 'd', title: 'Misc note', category: 'other' }),
  ];
  const all = { category: 'all', state: 'all', customerId: 'all', query: '' } as const;

  it('summarises by expiry state', () => {
    expect(summarizeDocuments(list, NOW)).toEqual({
      total: 4,
      expired: 1,
      expiring: 1,
      valid: 1,
      none: 1,
    });
  });

  it('filters by category, state and customer', () => {
    expect(filterDocuments(list, { ...all, category: 'insurance' }, NOW).map((d) => d.id)).toEqual([
      'b',
    ]);
    expect(filterDocuments(list, { ...all, state: 'expired' }, NOW).map((d) => d.id)).toEqual([
      'a',
    ]);
    expect(filterDocuments(list, { ...all, customerId: 'cust-1' }, NOW).map((d) => d.id)).toEqual([
      'c',
    ]);
  });

  it('searches title, reference, issuer and customer name case-insensitively', () => {
    expect(filterDocuments(list, { ...all, query: 'lic-77' }, NOW).map((d) => d.id)).toEqual(['a']);
    expect(filterDocuments(list, { ...all, query: 'ACME' }, NOW).map((d) => d.id)).toEqual(['b']);
    expect(filterDocuments(list, { ...all, query: 'jane' }, NOW).map((d) => d.id)).toEqual(['c']);
    expect(filterDocuments(list, { ...all, query: 'zzz' }, NOW)).toEqual([]);
  });
});
