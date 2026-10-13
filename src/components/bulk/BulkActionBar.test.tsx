import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import { BulkActionBar } from './BulkActionBar';
import { BulkCheckbox } from './BulkCheckbox';
import { useBulkSelection } from '@/hooks/useBulkSelection';

const noun = { singular: 'job', plural: 'jobs' };

describe('BulkActionBar', () => {
  it('renders nothing when no rows are selected', () => {
    render(<BulkActionBar count={0} noun={noun} onClear={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.queryByRole('region', { name: /bulk actions/i })).not.toBeInTheDocument();
  });

  it('shows the count with correct pluralization', () => {
    const { rerender } = render(<BulkActionBar count={1} noun={noun} onClear={vi.fn()} />);
    expect(screen.getByTestId('bulk-count')).toHaveTextContent('1 job selected');
    rerender(<BulkActionBar count={3} noun={noun} onClear={vi.fn()} />);
    expect(screen.getByTestId('bulk-count')).toHaveTextContent('3 jobs selected');
  });

  it('fires delete, export, and clear', () => {
    const onDelete = vi.fn(), onExport = vi.fn(), onClear = vi.fn();
    render(<BulkActionBar count={2} noun={noun} onClear={onClear} onDelete={onDelete} onExport={onExport} />);
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    fireEvent.click(screen.getByRole('button', { name: /export/i }));
    fireEvent.click(screen.getByRole('button', { name: /clear selection/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('opens the status menu and reports the chosen option', () => {
    const onStatus = vi.fn();
    render(<BulkActionBar count={2} noun={noun} onClear={vi.fn()} statusOptions={[{ value: 'completed', label: 'Completed' }]} onStatus={onStatus} />);
    fireEvent.click(screen.getByRole('button', { name: /status/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Completed' }));
    expect(onStatus).toHaveBeenCalledWith({ value: 'completed', label: 'Completed' });
  });

  it('adds normalized tags', () => {
    const onTags = vi.fn();
    render(<BulkActionBar count={2} noun={noun} onClear={vi.fn()} onTags={onTags} />);
    fireEvent.click(screen.getByRole('button', { name: /tag/i }));
    fireEvent.change(screen.getByLabelText(/tags, comma separated/i), { target: { value: 'VIP, Follow Up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onTags).toHaveBeenCalledWith('add', ['vip', 'follow-up']);
  });

  it('Escape closes an open menu first, then clears the selection', () => {
    const onClear = vi.fn();
    render(<BulkActionBar count={2} noun={noun} onClear={onClear} statusOptions={[{ value: 'x', label: 'X' }]} onStatus={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /status/i }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClear).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('BulkCheckbox', () => {
  it('forwards shiftKey and does not bubble to the row', () => {
    const onToggle = vi.fn(), onRow = vi.fn();
    render(<div onClick={onRow}><BulkCheckbox state="none" label="Select Ana" onToggle={onToggle} /></div>);
    fireEvent.click(screen.getByLabelText('Select Ana'), { shiftKey: true });
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(onRow).not.toHaveBeenCalled();
  });
});

describe('useBulkSelection', () => {
  const rows = ['a', 'b', 'c', 'd'].map((id) => ({ id }));

  it('supports shift-click ranges and clearing', () => {
    const { result } = renderHook(() => useBulkSelection(rows));
    act(() => result.current.toggle('a'));
    act(() => result.current.toggle('c', true));
    expect(result.current.count).toBe(3);
    act(() => result.current.clear());
    expect(result.current.count).toBe(0);
  });

  it('prunes rows that disappear', () => {
    const { result, rerender } = renderHook(({ r }) => useBulkSelection(r), { initialProps: { r: rows } });
    act(() => result.current.toggleMany(['a', 'b']));
    rerender({ r: rows.filter((x) => x.id !== 'b') });
    expect([...result.current.selectedIds]).toEqual(['a']);
  });
});
