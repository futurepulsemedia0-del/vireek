import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsiveTable, type Column } from './ResponsiveTable';

interface Row { id: string; name: string; email: string; total: string }
const rows: Row[] = [
  { id: '1', name: 'Ada', email: 'ada@example.com', total: '$10' },
  { id: '2', name: 'Bo', email: 'bo@example.com', total: '$20' },
];
const columns: Column<Row>[] = [
  { key: 'name', header: 'Name', cell: (r) => r.name, primary: true },
  { key: 'total', header: 'Total', cell: (r) => r.total, primary: true },
  { key: 'email', header: 'Email', cell: (r) => r.email },
];

function mockMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches, media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ResponsiveTable', () => {
  it('renders a semantic table on desktop', () => {
    mockMatchMedia(true);
    render(<ResponsiveTable columns={columns} rows={rows} rowKey={(r) => r.id} caption="Customers" />);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
  });

  it('renders cards with key fields and collapsed details on mobile', () => {
    mockMatchMedia(false);
    render(<ResponsiveTable columns={columns} rows={rows} rowKey={(r) => r.id} caption="Customers" />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getAllByText('Details')).toHaveLength(2);
  });

  it('fires onRowClick from a card button on mobile', () => {
    mockMatchMedia(false);
    const onRowClick = vi.fn();
    render(<ResponsiveTable columns={columns} rows={rows} rowKey={(r) => r.id} caption="Customers" onRowClick={onRowClick} />);
    fireEvent.click(screen.getAllByRole('button')[0]!);
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
  });

  it('renders the empty state when there are no rows', () => {
    mockMatchMedia(true);
    render(<ResponsiveTable columns={columns} rows={[]} rowKey={(r) => r.id} caption="Customers" emptyState={<p>Nothing here</p>} />);
    expect(screen.getByText('Nothing here')).toBeTruthy();
  });
});
