import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getMfaGate: vi.fn(),
  verifyTotp: vi.fn(),
  redeemRecoveryCode: vi.fn(),
  signOutToLogin: vi.fn(),
}));

vi.mock('@/lib/mfaChallenge', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mfaChallenge')>('@/lib/mfaChallenge');
  return { ...actual, ...mocks };
});
vi.mock('@/components/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { MfaChallengePage } from './MfaChallengePage';

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname}</p>;
}

function renderPage(state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/mfa', state }]}>
      <Routes>
        <Route path="/mfa" element={<MfaChallengePage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const challengeGate = { kind: 'challenge', factorId: 'f1' };
const codeInput = () => screen.getByLabelText('Authentication code');
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMfaGate.mockResolvedValue(challengeGate);
  mocks.verifyTotp.mockResolvedValue(undefined);
  mocks.redeemRecoveryCode.mockResolvedValue(undefined);
  mocks.signOutToLogin.mockResolvedValue(undefined);
});

describe('MfaChallengePage', () => {
  it('shows a loading state while it checks the session', () => {
    mocks.getMfaGate.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText(/checking your security settings/i)).toBeInTheDocument();
  });

  it('sends visitors without a session to /login', async () => {
    mocks.getMfaGate.mockResolvedValue({ kind: 'no-session' });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/login'));
  });

  it('skips the page when no second factor is needed', async () => {
    mocks.getMfaGate.mockResolvedValue({ kind: 'ok' });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/dashboard'));
  });

  it('shows a retry state when the check fails, and recovers on retry', async () => {
    mocks.getMfaGate.mockRejectedValueOnce(new Error('offline'));
    renderPage();
    expect(await screen.findByText(/couldn't verify your session/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByLabelText('Authentication code')).toBeInTheDocument();
  });

  it('auto-verifies on the sixth digit and continues to the page the user wanted', async () => {
    renderPage({ from: '/dashboard/leads' });
    type(await screen.findByLabelText('Authentication code'), '123456');
    await waitFor(() => expect(mocks.verifyTotp).toHaveBeenCalledWith('f1', '123456'));
    expect(await screen.findByText(/you're verified/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/dashboard/leads'), { timeout: 3000 });
  });

  it('ignores an unsafe "from" and falls back to the dashboard', async () => {
    renderPage({ from: '//evil.example' });
    type(await screen.findByLabelText('Authentication code'), '123456');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/dashboard'), { timeout: 3000 });
  });

  it('keeps only digits and never submits an incomplete code', async () => {
    renderPage();
    const input = await screen.findByLabelText('Authentication code');
    type(input, '12ab34');
    expect(input).toHaveValue('1234');
    expect(screen.getByRole('button', { name: /verify/i })).toBeDisabled();
    expect(mocks.verifyTotp).not.toHaveBeenCalled();
  });

  it('shows an error and clears the field after a wrong code', async () => {
    mocks.verifyTotp.mockRejectedValue(Object.assign(new Error('Invalid TOTP code entered'), { status: 400 }));
    renderPage();
    const input = await screen.findByLabelText('Authentication code');
    type(input, '000000');
    expect(await screen.findByText(/isn't right/i)).toBeInTheDocument();
    expect(input).toHaveValue('');
  });

  it('locks input for a moment after five wrong codes', async () => {
    mocks.verifyTotp.mockRejectedValue(Object.assign(new Error('Invalid TOTP code entered'), { status: 400 }));
    renderPage();
    const input = await screen.findByLabelText('Authentication code');
    for (let i = 0; i < 5; i++) {
      type(input, '000000');
      await waitFor(() => expect(mocks.verifyTotp).toHaveBeenCalledTimes(i + 1));
      await waitFor(() => expect(input).toHaveValue(''));
    }
    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument();
    expect(input).toBeDisabled();
  });

  it('redeems a recovery code and sends the person to Security settings', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /use a recovery code/i }));
    const input = await screen.findByLabelText('Recovery code');
    type(input, 'abcdefghjk');
    expect(input).toHaveValue('ABCDE-FGHJK');
    fireEvent.click(screen.getByRole('button', { name: /use recovery code/i }));
    await waitFor(() => expect(mocks.redeemRecoveryCode).toHaveBeenCalledWith('ABCDE-FGHJK'));
    expect(await screen.findByText(/recovery code accepted/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/dashboard/settings/security'), { timeout: 4000 });
  });

  it('explains an invalid or used recovery code', async () => {
    mocks.redeemRecoveryCode.mockRejectedValue(Object.assign(new Error('nope'), { status: 400 }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /use a recovery code/i }));
    type(await screen.findByLabelText('Recovery code'), 'ABCDEFGHJK');
    fireEvent.click(screen.getByRole('button', { name: /use recovery code/i }));
    expect(await screen.findByText(/already been used/i)).toBeInTheDocument();
  });

  it('can go back to the authenticator, and sign out to use a different account', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /use a recovery code/i }));
    fireEvent.click(await screen.findByRole('button', { name: /use your authenticator app/i }));
    expect(await screen.findByLabelText('Authentication code')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /different account/i }));
    await waitFor(() => expect(mocks.signOutToLogin).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/login'));
  });
});
