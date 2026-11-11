import { describe, expect, it } from 'vitest';
import { createCsvAdapter } from './csv.ts';

const csv = 'ID,Name\n1,A\n2,B\n\n3,"C, Inc"\n';
describe('csv adapter', () => {
  it('pages with an opaque cursor and reports spreadsheet row numbers', async () => {
    const a = createCsvAdapter({ customers: csv });
    const p1 = await a.read('customers', null, 2);
    expect(p1.records.map((r) => r.position)).toEqual([2, 3]);
    expect(p1.nextCursor).toBe('2');
    const p2 = await a.read('customers', p1.nextCursor, 2);
    expect(p2.records[0].data.Name).toBe('C, Inc');
    expect(p2.nextCursor).toBeNull();
  });
  it('strips a UTF-8 BOM and exposes columns', () => {
    const a = createCsvAdapter({ customers: '\uFEFFID,Name\n1,A\n' });
    expect(a.columns('customers')).toEqual(['ID', 'Name']);
  });
  it('rejects duplicate/unnamed headers, empty files, bad cursors and unknown entities', async () => {
    const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code?: string }).code; } return 'none'; };
    expect(code(() => createCsvAdapter({ c: 'A,A\n1,2\n' }))).toBe('SOURCE_INVALID');
    expect(code(() => createCsvAdapter({ c: 'A,\n1,2\n' }))).toBe('SOURCE_INVALID');
    expect(code(() => createCsvAdapter({ c: '' }))).toBe('SOURCE_INVALID');
    const a = createCsvAdapter({ c: 'A\n1\n' });
    let err = 'none'; try { await a.read('c', 'x1', 5); } catch (e) { err = (e as { code?: string }).code ?? ''; }
    expect(err).toBe('SOURCE_INVALID');
    err = 'none'; try { await a.read('zzz', null, 5); } catch (e) { err = (e as { code?: string }).code ?? ''; }
    expect(err).toBe('SOURCE_INVALID');
  });
  it('fingerprints the snapshot: same content equal, any change different', () => {
    const f = (t: string) => createCsvAdapter({ c: t }).fingerprint();
    expect(f('A\n1\n')).toBe(f('A\n1\n'));
    expect(f('A\n1\n') === f('A\n2\n')).toBe(false);
  });
});
