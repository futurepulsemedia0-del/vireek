import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k }),
}));
vi.mock('@/lib/a11y/announcer', () => ({ announce: vi.fn() }));

const auth = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signOut: vi.fn().mockResolvedValue({ error: null }),
  getAuthenticatorAssuranceLevel: vi.fn(),
  listFactors: vi.fn(),
  challengeAndVerify: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: auth.signInWithPassword,
      signOut: auth.signOut,
      mfa: {
        getAuthenticatorAssuranceLevel: auth.getAuthenticatorAssuranceLevel,
        listFactors: auth.listFactors,
        challengeAndVerify: auth.challengeAndVerify,
      },
    },
  },
}));

import { reauthGate } from '@/lib/session/reauthGate';
import { ReauthModal } from './ReauthModal';

const root = document.createElement('div');
root.id = 'root';

function open(): Promise<boolean> {
  let p!: Promise<boolean>;
  act(() => {
    p = reauthGate.request('expired');
  });
  return p;
}
const fill = (email: string, password: string) => {
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  if (email) fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in and continue' }));
};

beforeEach(() => {
  document.body.appendChild(root);
  reauthGate.setEnabled(true);
  reauthGate.rememberEmail('me@example.com');
  reauthGate.rememberUser('user-1');
  auth.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } });
  render(
    <MemoryRouter>
      <ReauthModal />
    </MemoryRouter>,
    { container: root.appendChild(document.createElement('div')) },
  );
});
afterEach(() => {
  cleanup();
  root.remove();
  vi.clearAllMocks();
  if (reauthGate.isOpen()) reauthGate.resolve(false);
});

describe('ReauthModal', () => {
  it('is hidden until requested, then is an accessible modal dialog with a prefilled read-only email', async () => {
    expect(screen.queryByRole('dialog')).toBeNull();
    const result = open();
    const dialog = await screen.findByRole('dialog', { name: 'Your session expired' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('Email')).toHaveValue('me@example.com');
    expect(screen.getByLabelText('Email')).toHaveAttribute('readonly');
    expect(document.getElementById('root')).toHaveAttribute('inert');
    act(() => reauthGate.resolve(false));
    await expect(result).resolves.toBe(false);
    expect(document.getElementById('root')).not.toHaveAttribute('inert');
  });

  it('resolves true after a successful sign-in as the SAME user', async () => {
    auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    const result = open();
    await screen.findByRole('dialog');
    fill('', 'correct horse');
    await expect(result).resolves.toBe(true);
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'me@example.com', password: 'correct horse' });
  });

  it('shows an error and stays open on bad credentials', async () => {
    auth.signInWithPassword.mockResolvedValue({ data: { user: null }, error: new Error('Invalid login') });
    void open();
    await screen.findByRole('dialog');
    fill('', 'nope');
    expect(await screen.findByRole('alert')).toHaveTextContent('not correct');
    expect(reauthGate.isOpen()).toBe(true);
  });

  it('asks for the authenticator code when MFA is required', async () => {
    auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    auth.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' } });
    auth.listFactors.mockResolvedValue({ data: { totp: [{ id: 'f1' }] }, error: null });
    auth.challengeAndVerify.mockResolvedValue({ error: null });
    const result = open();
    await screen.findByRole('dialog');
    fill('', 'pw');
    const code = await screen.findByLabelText('Authenticator code');
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and continue' }));
    await expect(result).resolves.toBe(true);
    expect(auth.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'f1', code: '123456' });
  });

  it('never keeps the previous user\'s page when a DIFFERENT account signs in', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'someone-else' } }, error: null });
    const result = open();
    await screen.findByRole('dialog');
    fill('', 'pw');
    await expect(result).resolves.toBe(false);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/dashboard'));
    vi.unstubAllGlobals();
  });

  it('"Leave without signing in" signs out locally and dismisses', async () => {
    const result = open();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Leave without signing in' }));
    await expect(result).resolves.toBe(false);
    await waitFor(() => expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' }));
  });
});
