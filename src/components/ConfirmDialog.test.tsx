import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog (integration)', () => {
  it('renders nothing when closed', () => {
    render(<ConfirmDialog open={false} title="Delete job" description="This cannot be undone." onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows title and description, and is announced as an alertdialog with both linked', () => {
    render(<ConfirmDialog open title="Delete job" description="This cannot be undone." onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Delete job');
    expect(dialog).toHaveAccessibleDescription('This cannot be undone.');
  });

  it('disables confirm until the exact confirm phrase is typed', () => {
    render(
      <ConfirmDialog
        open
        title="Delete job"
        description="Type to confirm."
        confirmPhrase="delete this job"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const confirmButton = screen.getByRole('button', { name: /yes, delete this/i });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('delete this job'), { target: { value: 'delete this job' } });
    expect(confirmButton).toBeEnabled();
  });

  it('calls onConfirm when confirmed and onCancel when the cancel button is clicked', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="Delete job" description="Sure?" onConfirm={onConfirm} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: /yes, delete this/i }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Escape is pressed', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="Delete job" description="Sure?" onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('moves initial focus into the dialog', async () => {
    render(<ConfirmDialog open title="Delete job" description="Sure?" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alertdialog')).toContainElement(document.activeElement as HTMLElement));
  });
});
