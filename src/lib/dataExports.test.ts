import { describe, it, expect } from 'vitest';
import {
  EXPORT_DATASETS,
  FORMAT_ROW_CAP,
  applyExportFilters,
  buildCsv,
  buildExportFile,
  buildPdf,
  buildXlsx,
  colLetter,
  crc32,
  exportFileName,
  exportStoragePath,
  isExportExpired,
  neutralizeFormula,
  sanitizeSearch,
  toWinAnsi,
  validateExportRequest,
  type FilterableQuery,
} from '../../supabase/functions/_shared/exports/engine';

const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');

const invoiceRow = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  invoice_number: 'INV-1',
  created_at: '2026-10-01T10:15:00Z',
  customer_name: 'Ada Lovelace',
  customer_email: 'ada@example.com',
  status: 'paid',
  due_date: '2026-11-01',
  line_items: [
    { quantity: 2, unit_price_cents: 12550 },
    { quantity: 1, unit_price_cents: 999 },
  ],
  tax_percent: 8.5,
  sent_at: null,
  paid_at: '2026-10-05T09:00:00Z',
  payment_method: 'card',
  ...over,
});

describe('validateExportRequest', () => {
  it('accepts a valid request and normalises filters', () => {
    const r = validateExportRequest({
      dataset: 'calls',
      format: 'pdf',
      filters: { status: 'booked', dateFrom: '2026-01-01', dateTo: '2026-01-31', search: ' ann ' },
    });
    expect(r).toEqual({
      ok: true,
      value: {
        dataset: 'calls',
        format: 'pdf',
        filters: { status: 'booked', dateFrom: '2026-01-01', dateTo: '2026-01-31', search: 'ann' },
      },
    });
  });

  it('rejects unknown datasets and formats (no arbitrary tables)', () => {
    expect(validateExportRequest({ dataset: 'profiles', format: 'csv' }).ok).toBe(false);
    expect(validateExportRequest({ dataset: 'calls', format: 'docx' }).ok).toBe(false);
    expect(validateExportRequest(null).ok).toBe(false);
  });

  it('rejects bad dates, reversed ranges and wrong-dataset statuses', () => {
    expect(validateExportRequest({ dataset: 'leads', format: 'csv', filters: { dateFrom: '2026-02-30' } }).ok).toBe(false);
    expect(
      validateExportRequest({ dataset: 'leads', format: 'csv', filters: { dateFrom: '2026-03-02', dateTo: '2026-03-01' } }).ok,
    ).toBe(false);
    expect(validateExportRequest({ dataset: 'leads', format: 'csv', filters: { status: 'booked' } }).ok).toBe(false);
    expect(validateExportRequest({ dataset: 'leads', format: 'csv', filters: { status: 'won' } }).ok).toBe(true);
  });

  it('treats status "all" and empty values as no filter', () => {
    const r = validateExportRequest({ dataset: 'jobs', format: 'csv', filters: { status: 'all', dateFrom: '', search: '' } });
    expect(r).toEqual({ ok: true, value: { dataset: 'jobs', format: 'csv', filters: {} } });
  });

  it('strips characters that could break a PostgREST or() filter', () => {
    expect(sanitizeSearch('a,b(c)%*"x')).toBe('a b c x');
    expect(sanitizeSearch('x'.repeat(500)).length).toBe(100);
  });
});

describe('applyExportFilters', () => {
  function recorder() {
    const calls: [string, ...unknown[]][] = [];
    const q: FilterableQuery = {
      eq: (c, v) => (calls.push(['eq', c, v]), q),
      gte: (c, v) => (calls.push(['gte', c, v]), q),
      lte: (c, v) => (calls.push(['lte', c, v]), q),
      or: (f) => (calls.push(['or', f]), q),
    };
    return { q, calls };
  }

  it('ALWAYS scopes to the account owner id first', () => {
    const { q, calls } = recorder();
    applyExportFilters(q, EXPORT_DATASETS.calls, {}, 'owner-1');
    expect(calls).toEqual([['eq', 'user_id', 'owner-1']]);
  });

  it('applies inclusive UTC date bounds, status and search', () => {
    const { q, calls } = recorder();
    applyExportFilters(q, EXPORT_DATASETS.leads, { dateFrom: '2026-01-01', dateTo: '2026-01-31', status: 'won', search: 'ann' }, 'o');
    expect(calls).toContainEqual(['gte', 'created_at', '2026-01-01T00:00:00.000Z']);
    expect(calls).toContainEqual(['lte', 'created_at', '2026-01-31T23:59:59.999Z']);
    expect(calls).toContainEqual(['eq', 'stage', 'won']);
    expect(calls).toContainEqual(['or', 'name.ilike.%ann%,phone.ilike.%ann%,email.ilike.%ann%,service_interested.ilike.%ann%']);
  });
});

describe('CSV', () => {
  it('starts with a UTF-8 BOM, uses CRLF and labels datetimes as UTC', () => {
    const bytes = buildCsv(EXPORT_DATASETS.invoices, [invoiceRow()]);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const text = dec(bytes);
    expect(text).toContain('Created (UTC)');
    expect(text.split('\r\n')[1]).toContain('2026-10-01 10:15');
  });

  it('computes invoice subtotal / tax / total from line items', () => {
    const line = dec(buildCsv(EXPORT_DATASETS.invoices, [invoiceRow()])).split('\r\n')[1];
    expect(line).toContain('260.99,22.18,283.17');
  });

  it('neutralises formula injection but keeps phone numbers readable', () => {
    expect(neutralizeFormula('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(neutralizeFormula('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(neutralizeFormula('+1 (555) 010-0100')).toBe('+1 (555) 010-0100');
    expect(neutralizeFormula('hello')).toBe('hello');
  });

  it('escapes commas, quotes and newlines and preserves non-Latin text', () => {
    const text = dec(buildCsv(EXPORT_DATASETS.invoices, [invoiceRow({ customer_name: 'Doe, "Jo"\nسلام' })]));
    expect(text).toContain('"Doe, ""Jo""\nسلام"');
  });
});

describe('XLSX', () => {
  function readZip(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = bytes.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    const count = view.getUint16(eocd + 10, true);
    let off = view.getUint32(eocd + 16, true);
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < count; i++) {
      expect(view.getUint32(off, true)).toBe(0x02014b50);
      const crc = view.getUint32(off + 16, true);
      const size = view.getUint32(off + 24, true);
      const nameLen = view.getUint16(off + 28, true);
      const local = view.getUint32(off + 42, true);
      const name = dec(bytes.slice(off + 46, off + 46 + nameLen));
      const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.slice(dataStart, dataStart + size);
      expect(crc32(data)).toBe(crc);
      files[name] = data;
      off += 46 + nameLen;
    }
    return files;
  }

  it('produces a structurally valid OOXML package with correct CRCs', () => {
    const files = readZip(buildXlsx(EXPORT_DATASETS.invoices, [invoiceRow()], new Date('2026-10-08T00:00:00Z')));
    expect(Object.keys(files).sort()).toEqual(
      ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'].sort(),
    );
    const sheet = dec(files['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('<autoFilter ref="A1:L2"/>');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<v>283.17</v>');
  });

  it('writes strings inline (never as formulas) and escapes XML', () => {
    const files = readZip(buildXlsx(EXPORT_DATASETS.invoices, [invoiceRow({ customer_name: '=1+1 <b>&' })]));
    const sheet = dec(files['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('=1+1 &lt;b&gt;&amp;');
    expect(sheet).not.toContain('<f>');
  });

  it('maps column indexes to spreadsheet letters', () => {
    expect([colLetter(0), colLetter(25), colLetter(26), colLetter(701), colLetter(702)]).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA']);
  });
});

describe('PDF', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => invoiceRow({ id: `i${i}`, invoice_number: `INV-${i}` }));
  const meta = { title: 'Invoices export', subtitle: 'No filters', generatedAt: new Date('2026-10-08T00:00:00Z') };

  it('is a well-formed PDF with a correct xref offset', () => {
    const text = latin1(buildPdf(EXPORT_DATASETS.invoices, many(5), meta));
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const xrefPos = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
    expect(text.slice(xrefPos, xrefPos + 4)).toBe('xref');
  });

  it('paginates and repeats headers', () => {
    const text = latin1(buildPdf(EXPORT_DATASETS.invoices, many(120), meta));
    const pages = Number(/\/Count (\d+)/.exec(text)?.[1]);
    expect(pages).toBeGreaterThan(1);
    expect(text).toContain(`Page ${pages} of ${pages}`);
  });

  it('renders a friendly empty state', () => {
    expect(latin1(buildPdf(EXPORT_DATASETS.invoices, [], meta))).toContain('No rows matched these filters.');
  });

  it('maps unsupported scripts to "?" instead of corrupting the file', () => {
    expect(toWinAnsi('Zoë – “ok” سلام')).toBe('Zo\u00eb \u0096 \u0093ok\u0094 ????');
  });
});

describe('dispatch & helpers', () => {
  it('buildExportFile routes by format', () => {
    const req = { dataset: 'invoices' as const, filters: {} };
    expect(Array.from(buildExportFile({ ...req, format: 'csv' }, [invoiceRow()]).slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(latin1(buildExportFile({ ...req, format: 'pdf' }, [invoiceRow()]).slice(0, 5))).toBe('%PDF-');
    expect(latin1(buildExportFile({ ...req, format: 'xlsx' }, [invoiceRow()]).slice(0, 2))).toBe('PK');
  });

  it('keeps sensible row caps (pdf < xlsx < csv)', () => {
    expect(FORMAT_ROW_CAP.pdf).toBeLessThan(FORMAT_ROW_CAP.xlsx);
    expect(FORMAT_ROW_CAP.xlsx).toBeLessThan(FORMAT_ROW_CAP.csv);
  });

  it('never exports call transcripts', () => {
    expect(EXPORT_DATASETS.calls.select).not.toContain('transcript');
    expect(EXPORT_DATASETS.calls.select).not.toContain('recording_url');
  });

  it('builds tenant-scoped storage paths and stable file names', () => {
    expect(exportStoragePath('owner', 'job', 'pdf')).toBe('owner/job.pdf');
    expect(exportFileName('calls', 'xlsx', new Date('2026-10-08T09:05:00Z'))).toBe('vireek-calls-20261008-0905.xlsx');
  });

  it('detects expiry', () => {
    const now = Date.parse('2026-10-08T00:00:00Z');
    expect(isExportExpired('2026-10-07T00:00:00Z', now)).toBe(true);
    expect(isExportExpired('2026-10-09T00:00:00Z', now)).toBe(false);
    expect(isExportExpired(null, now)).toBe(false);
  });
});
