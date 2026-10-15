import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { JobHoldDialog } from './JobHoldDialog';

function setup(over: Partial<React.ComponentProps<typeof JobHoldDialog>> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(null);
  const onClose = vi.fn();
  render(<JobHoldDialog open jobLabel="Ann Lee" onSubmit={onSubmit} onClose={onClose} {...over} />);
  return { onSubmit, onClose };
}

const pick = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('JobHoldDialog', () => {
  it('renders nothing when closed', () => {
    render(<JobHoldDialog open={false} jobLabel="Ann" onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is an accessible dialog titled with the job', () => {
    setup();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Update status — Ann Lee');
  });

  it('blocks submit and shows an error when no reason is chosen', async () => {
    const { onSubmit } = setup({ initialStatus: 'on_hold' });
    fireEvent.click(screen.getByRole('button', { name: 'Update status' }));
    expect(await screen.findByText('A reason is required.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('requires a status before anything else', async () => {
    const { onSubmit } = setup();
    expect(screen.getByLabelText(/^Reason/)).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Update status' }));
    expect(await screen.findByText('Choose a status.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('only offers reasons that belong to the chosen status, and resets the reason when the status changes', () => {
    setup({ initialStatus: 'waiting_on_parts' });
    expect(screen.getByRole('option', { name: 'Part back-ordered' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Weather' })).not.toBeInTheDocument();
    pick(/^Reason/, 'part_ordered');
    pick(/^Status/, 'on_hold');
    expect((screen.getByLabelText(/^Reason/) as HTMLSelectElement).value).toBe('');
    expect(screen.getByRole('option', { name: 'Weather' })).toBeInTheDocument();
  });

  it('requires a note when the reason is "Other"', async () => {
    const { onSubmit } = setup({ initialStatus: 'on_hold' });
    pick(/^Reason/, 'other');
    fireEvent.click(screen.getByRole('button', { name: 'Update status' }));
    expect(await screen.findByText(/Add a short note/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: 'Customer is travelling' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update status' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it('submits a clean payload', async () => {
    const { onSubmit } = setup({ initialStatus: 'waiting_on_parts' });
    pick(/^Reason/, 'part_ordered');
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: '  Compressor ordered  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update status' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ status: 'waiting_on_parts', reasonCode: 'part_ordered', note: 'Compressor ordered', expectedResumeAt: null }),
    );
  });

  it('shows the SLA / reminder policy for the chosen status', () => {
    setup({ initialStatus: 'needs_follow_up' });
    expect(screen.getByTestId('policy-hint')).toHaveTextContent('Resolve within 1 day · reminder after 4 hours, then every 8 hours');
  });

  it('keeps the dialog open and shows the server message when the request fails', async () => {
    const onSubmit = vi.fn().mockResolvedValue('This job\'s time slot is now taken.');
    setup({ initialStatus: 'on_hold', onSubmit });
    pick(/^Reason/, 'weather');
    fireEvent.click(screen.getByRole('button', { name: 'Update status' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('time slot is now taken');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('survives a thrown submit handler', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('boom'));
    setup({ initialStatus: 'on_hold', onSubmit });
    pick(/^Reason/, 'weather');
    fireEvent.click(screen.getByRole('button', { name: 'Update status' }));
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update status' })).not.toBeDisabled();
  });

  it('ignores double submits while a request is in flight', async () => {
    let release: (v: null) => void = () => {};
    const onSubmit = vi.fn().mockImplementation(() => new Promise<null>((r) => (release = r)));
    setup({ initialStatus: 'on_hold', onSubmit });
    pick(/^Reason/, 'weather');
    const submit = screen.getByRole('button', { name: 'Update status' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();
    release(null);
    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  it('rejects a past expected-resume time', async () => {
    const { onSubmit } = setup({ initialStatus: 'on_hold' });
    pick(/^Reason/, 'weather');
    fireEvent.change(screen.getByLabelText(/^Expected to resume/), { target: { value: '2001-01-01T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update status' }));
    expect(await screen.findByText('Pick a time in the future.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('closes on Escape and on Cancel', () => {
    const { onClose } = setup();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('clears previous input when re-opened', () => {
    const { rerender } = render(<JobHoldDialog open jobLabel="A" initialStatus="on_hold" onSubmit={vi.fn()} onClose={vi.fn()} />);
    pick(/^Reason/, 'weather');
    rerender(<JobHoldDialog open={false} jobLabel="A" initialStatus="on_hold" onSubmit={vi.fn()} onClose={vi.fn()} />);
    rerender(<JobHoldDialog open jobLabel="B" initialStatus="on_hold" onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect((screen.getByLabelText(/^Reason/) as HTMLSelectElement).value).toBe('');
  });
});
