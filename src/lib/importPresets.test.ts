import { describe, expect, it } from 'vitest';
import { autoMap, detectPreset, isMappingComplete } from '@/lib/importPresets';
import { decodeText, detectDelimiter, matrixToTable, parseDelimited, readImportFile, rowErrorsToCsv, tableToCsv, uniqueHeaders, ImportFileError } from '@/lib/importFile';

describe('autoMap + presets', () => {
  it('maps a Jobber-style client export (first/last name, split address)', () => {
    const headers = ['First name', 'Last name', 'Business name', 'Phone number', 'Email', 'Street 1', 'City', 'State/Province', 'ZIP/Postal code', 'Client tags'];
    const { mapping } = autoMap(headers, 'customers', 'jobber');
    expect(mapping).toMatchObject({ first_name: 'First name', last_name: 'Last name', company: 'Business name', phone: 'Phone number', email: 'Email', address: 'Street 1', city: 'City', state: 'State/Province', zip: 'ZIP/Postal code' });
    expect(mapping.name).toBeUndefined(); // "First name" must not be claimed as the full name
    expect(isMappingComplete('customers', mapping)).toBe(true);
    expect(detectPreset(headers)).toBe('jobber');
  });

  it('maps ServiceTitan-style job columns and links customers by ID', () => {
    const headers = ['Job Number', 'Customer ID', 'Customer Name', 'Job Type', 'Status', 'Scheduled Date', 'Invoice Total', 'Location Address'];
    const { mapping } = autoMap(headers, 'jobs', 'service_titan');
    expect(mapping).toMatchObject({ external_id: 'Job Number', customer_external_id: 'Customer ID', customer_name: 'Customer Name', service_type: 'Job Type', job_status: 'Status', scheduled_datetime: 'Scheduled Date', invoice_amount: 'Invoice Total', address: 'Location Address' });
  });

  it('never maps one column to two fields and reports an incomplete mapping', () => {
    const { mapping } = autoMap(['Foo', 'Bar'], 'customers', 'csv');
    expect(Object.keys(mapping)).toHaveLength(0);
    expect(isMappingComplete('customers', mapping)).toBe(false);
    const used = Object.values(autoMap(['Name', 'Phone', 'ID'], 'customers', 'csv').mapping);
    expect(new Set(used).size).toBe(used.length);
  });
});

describe('file parsing', () => {
  it('detects delimiters and parses quoted newlines/quotes', () => {
    const text = 'Name;Note\n"Ana ""A"" P";"line1\nline2"\nBo;ok';
    expect(detectDelimiter(text)).toBe(';');
    const rows = parseDelimited(text, ';');
    expect(rows[1]).toEqual(['Ana "A" P', 'line1\nline2']);
    expect(rows).toHaveLength(3);
  });

  it('makes headers unique, drops blank trailing columns/rows and pads short rows', () => {
    expect(uniqueHeaders(['Name', 'name', ''])).toEqual(['Name', 'name (2)', 'Column 3']);
    const { headers, rows } = matrixToTable([['Name', 'Phone', '', ''], ['Ana', '555'], ['', '', '', ''], ['Bo', '556', '', 'x']]);
    expect(headers).toEqual(['Name', 'Phone']);
    expect(rows).toEqual([['Ana', '555'], ['Bo', '556']]);
  });

  it('rejects empty files, header-only files and oversized row counts with friendly errors', () => {
    expect(() => matrixToTable([])).toThrow(ImportFileError);
    expect(() => matrixToTable([['Name']])).toThrow(/no data rows/);
    expect(() => matrixToTable([['Name'], ...Array.from({ length: 5001 }, () => ['x'])])).toThrow(/5,000/);
  });

  it('decodes UTF-8 BOM and Windows-1252 text', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]).buffer)).toBe('A');
    expect(decodeText(new Uint8Array([0x4a, 0x6f, 0x73, 0xe9]).buffer)).toBe('José');
  });

  it('round-trips through canonical CSV and reads a real File', async () => {
    const csv = tableToCsv(['Name', 'Note'], [['Ana', 'a, "b"'], ['Bo', 'line\nbreak']]);
    const file = new File(['\uFEFF' + csv], 'customers.csv', { type: 'text/csv' });
    const table = await readImportFile(file);
    expect(table.rows).toEqual([['Ana', 'a, "b"'], ['Bo', 'line\nbreak']]);
    await expect(readImportFile(new File(['x'], 'old.xls'))).rejects.toThrow(/\.xlsx/);
    await expect(readImportFile(new File(['x'], 'photo.png'))).rejects.toThrow(ImportFileError);
  });
});

describe('failed-row export', () => {
  it('neutralizes spreadsheet formulas and keeps the reason', () => {
    const csv = rowErrorsToCsv([{ row_number: 4, raw_row: { Name: '=HYPERLINK("x")', Phone: '555' }, error_message: 'Missing name' }]);
    expect(csv.split('\n')[1]).toContain("'=HYPERLINK");
    expect(csv).toContain('Missing name');
  });
});
