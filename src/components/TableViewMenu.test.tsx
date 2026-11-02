import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, o?: { defaultValue?: string; name?: string }) => (o?.defaultValue ?? _k).replace('{{name}}', o?.name ?? '') }),
}));

import { TableViewMenu } from './TableViewMenu';

const cols = [
  { key: 'customer', label: 'Customer', required: true },
  { key: 'contact', label: 'Contact' },
  { key: 'type', label: 'Type' },
];

function setup(over: Partial<Parameters<typeof TableViewMenu>[0]> = {}) {
  const fns = { onToggleColumn: vi.fn(), onMove: vi.fn(), onDensity: vi.fn(), onPageSize: vi.fn(), onReset: vi.fn() };
  render(<TableViewMenu ordered={cols} visibleKeys={['customer', 'contact']} density="comfortable" pageSize={25} sync="synced" {...fns} {...over} />);
  fireEvent.click(screen.getByRole('button', { name: /view/i }));
  return fns;
}

afterEach(cleanup);

describe('TableViewMenu', () => {
  it('opens as a dialog; required columns cannot be hidden', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Table view options' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Customer' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Contact' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Type' })).not.toBeChecked();
  });
  it('toggles and reorders columns, with boundary buttons disabled', () => {
    const f = setup();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Type' }));
    expect(f.onToggleColumn).toHaveBeenCalledWith('type');
    fireEvent.click(screen.getByRole('button', { name: 'Move Contact up' }));
    expect(f.onMove).toHaveBeenCalledWith('contact', -1);
    expect(screen.getByRole('button', { name: 'Move Customer up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Type down' })).toBeDisabled();
  });
  it('changes density and page size, resets, and reports sync state', () => {
    const f = setup();
    fireEvent.click(screen.getByRole('radio', { name: 'Compact' }));
    expect(f.onDensity).toHaveBeenCalledWith('compact');
    fireEvent.change(screen.getByLabelText(/rows per page/i), { target: { value: '50' } });
    expect(f.onPageSize).toHaveBeenCalledWith(50);
    fireEvent.click(screen.getByRole('button', { name: /reset/i }));
    expect(f.onReset).toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Saved to your account');
  });
  it('Escape closes the menu and returns focus to the trigger', () => {
    setup();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /view/i })).toHaveFocus();
  });
});
