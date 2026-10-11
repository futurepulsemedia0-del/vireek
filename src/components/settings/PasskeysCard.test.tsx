import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const lib = vi.hoisted(() => {
  class PasskeyError extends Error {
    kind: string;
    constructor(f: { kind: string; message: string }) {
      super(f.message);
      this.kind = f.kind;
    }
  }
  return {
    PasskeyError,
    isPasskeySupported: vi.fn(() => true),
    listPasskeys: vi.fn(),
    registerNewPasskey: vi.fn(),
    renamePasskey: vi.fn(),
    deletePasskey: vi.fn(),
  };
});
const toast = vi.hoisted(() => vi.fn());

vi.mock('@/lib/passkeys', () => lib);
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: ({ open, onConfirm, confirmLabel }: { open: boolean; onConfirm: () => void; confirmLabel?: string }) =>
    open ? <button onClick={onConfirm}>{confirmLabel}</button> : null,
}));

import { PasskeysCard } from '@/components/settings/PasskeysCard';

const row = (over = {}) => ({ id: 'p1', friendly_name: 'MacBook', created_at: '2027-03-01T00:00:00Z', last_used_at: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  lib.isPasskeySupported.mockReturnValue(true);
  lib.listPasskeys.mockResolvedValue([row()]);
});

describe('<PasskeysCard />', () => {
  it('lists passkeys', async () => {
    render(<PasskeysCard />);
    expect(await screen.findByText('MacBook')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    lib.listPasskeys.mockResolvedValue([]);
    render(<PasskeysCard />);
    expect(await screen.findByText(/No passkeys yet/i)).toBeInTheDocument();
  });

  it('hides the add button and explains when the browser lacks WebAuthn', async () => {
    lib.isPasskeySupported.mockReturnValue(false);
    render(<PasskeysCard />);
    expect(await screen.findByText(/doesn.t support passkeys/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add a passkey/i })).toBeNull();
  });

  it('adds a passkey and reloads the list', async () => {
    lib.registerNewPasskey.mockResolvedValue(row({ id: 'p2' }));
    render(<PasskeysCard />);
    await screen.findByText('MacBook');
    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));
    await waitFor(() => expect(lib.registerNewPasskey).toHaveBeenCalled());
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/added/i), 'success'));
    expect(lib.listPasskeys).toHaveBeenCalledTimes(2);
  });

  it('stays silent when the user cancels the browser prompt, but reports real errors', async () => {
    render(<PasskeysCard />);
    await screen.findByText('MacBook');
    lib.registerNewPasskey.mockRejectedValueOnce(new lib.PasskeyError({ kind: 'cancelled', message: 'cancelled' }));
    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));
    await waitFor(() => expect(lib.registerNewPasskey).toHaveBeenCalledTimes(1));
    expect(toast).not.toHaveBeenCalled();

    lib.registerNewPasskey.mockRejectedValueOnce(new lib.PasskeyError({ kind: 'limit', message: 'Too many passkeys' }));
    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Too many passkeys', 'error'));
  });

  it('renames a passkey', async () => {
    lib.renamePasskey.mockResolvedValue(undefined);
    render(<PasskeysCard />);
    await screen.findByText('MacBook');
    fireEvent.click(screen.getByRole('button', { name: /rename passkey/i }));
    fireEvent.change(screen.getByLabelText(/passkey name/i), { target: { value: 'Work laptop' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(lib.renamePasskey).toHaveBeenCalledWith('p1', 'Work laptop'));
  });

  it('removes a passkey only after confirmation', async () => {
    lib.deletePasskey.mockResolvedValue(undefined);
    render(<PasskeysCard />);
    await screen.findByText('MacBook');
    fireEvent.click(screen.getByRole('button', { name: /remove passkey/i }));
    expect(lib.deletePasskey).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove passkey' }));
    await waitFor(() => expect(lib.deletePasskey).toHaveBeenCalledWith('p1'));
  });

  it('offers a retry when loading fails', async () => {
    lib.listPasskeys.mockRejectedValueOnce(new Error('network'));
    render(<PasskeysCard />);
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    expect(await screen.findByText('MacBook')).toBeInTheDocument();
  });
});
