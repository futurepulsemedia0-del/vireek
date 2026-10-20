import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const requestOtp = vi.fn();
const verifyOtp = vi.fn();
vi.mock('@/lib/homeowner/api', () => ({
  requestOtp: (...a: unknown[]) => requestOtp(...a),
  verifyOtp: (...a: unknown[]) => verifyOtp(...a),
}));
vi.mock('@/lib/appOrigin', () => ({ getPublicOrigin: () => 'https://vireek.test' }));

import { HomeSignInPage } from './HomeSignInPage';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HomeSignInPage', () => {
  it('rejects an invalid number without calling the server', async () => {
    render(<HomeSignInPage />);
    fireEvent.change(screen.getByLabelText(/mobile number/i), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid mobile number/i);
    expect(requestOtp).not.toHaveBeenCalled();
  });

  it('sends the code, then verifies automatically at 6 digits', async () => {
    requestOtp.mockResolvedValue(undefined);
    verifyOtp.mockResolvedValue(undefined);
    render(<HomeSignInPage />);
    fireEvent.change(screen.getByLabelText(/mobile number/i), { target: { value: '(555) 123-4567' } });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    await waitFor(() => expect(requestOtp).toHaveBeenCalledWith('+15551234567'));

    const code = await screen.findByLabelText(/6-digit code/i);
    fireEvent.change(code, { target: { value: '123456' } });
    await waitFor(() => expect(verifyOtp).toHaveBeenCalledWith('+15551234567', '123456'));
  });

  it('shows an error and clears the field when the code is wrong', async () => {
    requestOtp.mockResolvedValue(undefined);
    verifyOtp.mockRejectedValue(new Error('That code is incorrect or has expired.'));
    render(<HomeSignInPage />);
    fireEvent.change(screen.getByLabelText(/mobile number/i), { target: { value: '5551234567' } });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    const code = await screen.findByLabelText(/6-digit code/i);
    fireEvent.change(code, { target: { value: '000000' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect or has expired/i);
    expect((code as HTMLInputElement).value).toBe('');
  });
});
