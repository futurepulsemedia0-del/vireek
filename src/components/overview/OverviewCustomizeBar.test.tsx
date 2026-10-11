import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { OverviewCustomizeBar } from './OverviewCustomizeBar';

const base = {
  editing: true,
  preset: 'owner' as const,
  hidden: [] as never[],
  saveState: 'idle' as const,
  onToggleEditing: vi.fn(),
  onApplyPreset: vi.fn(),
  onReset: vi.fn(),
  onShow: vi.fn(),
};

afterEach(cleanup);

describe('OverviewCustomizeBar', () => {
  it('shows only the Customize button when not editing', () => {
    const onToggleEditing = vi.fn();
    render(<OverviewCustomizeBar {...base} editing={false} onToggleEditing={onToggleEditing} />);
    fireEvent.click(screen.getByRole('button', { name: /customize/i }));
    expect(onToggleEditing).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /reset to default/i })).not.toBeInTheDocument();
  });

  it('asks for confirmation before resetting', async () => {
    const onReset = vi.fn();
    render(<OverviewCustomizeBar {...base} onReset={onReset} />);
    fireEvent.click(screen.getByRole('button', { name: /reset to default/i }));
    expect(onReset).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset layout' }));
    await waitFor(() => expect(onReset).toHaveBeenCalledOnce());
  });

  it('applies a preset only after confirmation', async () => {
    const onApplyPreset = vi.fn();
    render(<OverviewCustomizeBar {...base} onApplyPreset={onApplyPreset} />);
    fireEvent.change(screen.getByLabelText(/layout preset/i), { target: { value: 'technician' } });
    expect(onApplyPreset).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Apply preset' }));
    await waitFor(() => expect(onApplyPreset).toHaveBeenCalledWith('technician'));
  });

  it('lists hidden widgets and re-adds one on click', () => {
    const onShow = vi.fn();
    render(<OverviewCustomizeBar {...base} hidden={['kpi_calls']} onShow={onShow} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Calls this month' }));
    expect(onShow).toHaveBeenCalledWith('kpi_calls');
  });

  it('shows save status and finishes editing with Done', () => {
    const onToggleEditing = vi.fn();
    render(<OverviewCustomizeBar {...base} saveState="saved" onToggleEditing={onToggleEditing} />);
    expect(screen.getByText(/saved to your account/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    expect(onToggleEditing).toHaveBeenCalledOnce();
  });
});
