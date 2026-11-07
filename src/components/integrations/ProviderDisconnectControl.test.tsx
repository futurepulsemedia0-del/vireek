import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const toast = vi.fn();
const invoke = vi.fn();

vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));
// The real ConfirmDialog is covered by its own tests; here we only need its open/confirm/cancel contract.
vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: (p: { open: boolean; title: string; confirmLabel?: string; consequences?: string[]; onConfirm: () => void; onCancel: () => void }) =>
    p.open ? (
      <div role="dialog" aria-label={p.title}>
        <ul>{p.consequences?.map((c) => <li key={c}>{c}</li>)}</ul>
        <button onClick={p.onConfirm}>{p.confirmLabel}</button>
        <button onClick={p.onCancel}>Cancel</button>
      </div>
    ) : null,
}));

import { ProviderDisconnectControl } from './ProviderDisconnectControl';

const setup = () => {
  const onDisconnected = vi.fn();
  render(<ProviderDisconnectControl provider="jobber" providerLabel="Jobber" consequences={['Stop syncing prices from Jobber']} onDisconnected={onDisconnected} />);
  return { onDisconnected };
};

describe('ProviderDisconnectControl', () => {
  afterEach(cleanup);
  beforeEach(() => {
    toast.mockClear();
    invoke.mockReset();
  });

  it('has an accessible name and does nothing until confirmed', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Jobber' }));
    expect(screen.getByRole('dialog', { name: 'Disconnect Jobber?' })).toBeInTheDocument();
    expect(screen.getByText('Stop syncing prices from Jobber')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('cancel closes without calling the server', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Jobber' }));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('confirm calls provider-disconnect, toasts, shows the follow-up and refreshes', async () => {
    invoke.mockResolvedValue({ data: { ok: true, revoked: null }, error: null });
    const { onDisconnected } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Jobber' }));
    fireEvent.click(screen.getByText('Yes, disconnect'));
    await waitFor(() => expect(onDisconnected).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith('provider-disconnect', { body: { provider: 'jobber', delete_imported_data: false } });
    expect(toast).toHaveBeenCalledWith('Jobber disconnected.', 'success');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('connected apps'), 'info');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the server error and does not refresh on failure (e.g. permission denied)', async () => {
    invoke.mockResolvedValue({ data: { error: "You don't have permission to manage integrations." }, error: null });
    const { onDisconnected } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Jobber' }));
    fireEvent.click(screen.getByText('Yes, disconnect'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("You don't have permission to manage integrations.", 'error'));
    expect(onDisconnected).not.toHaveBeenCalled();
  });
});
