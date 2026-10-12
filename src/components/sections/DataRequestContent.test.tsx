import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DataRequestContent } from '@/components/sections/DataRequestContent';
import { DsarApiError, submitDsar } from '@/lib/dsarApi';

vi.mock('@/lib/dsarApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dsarApi')>();
  return { ...actual, submitDsar: vi.fn(), verifyDsar: vi.fn(), resendDsarCode: vi.fn() };
});

const submitMock = vi.mocked(submitDsar);

function renderForm() {
  return render(
    <MemoryRouter>
      <DataRequestContent />
    </MemoryRouter>,
  );
}

function fillValidForm() {
  fireEvent.click(screen.getByRole('radio', { name: /access my data/i }));
  fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Jane Doe' } });
  fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'jane@example.com' } });
  fireEvent.click(screen.getByRole('radio', { name: /have \(or had\) a vireek account/i }));
  fireEvent.click(screen.getByLabelText(/i confirm this request/i));
}

describe('DataRequestContent', () => {
  beforeEach(() => submitMock.mockReset());

  it('offers access, delete and correct as request types', () => {
    renderForm();
    expect(screen.getByRole('radio', { name: /access my data/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /delete my data/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /correct my data/i })).toBeInTheDocument();
  });

  it('blocks an empty submission and never calls the API', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: /verify my email/i }));
    expect(await screen.findByText(/please fix \d+ fields? below/i)).toBeInTheDocument();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('submits a valid form (honeypot empty) and moves to code entry', async () => {
    submitMock.mockResolvedValue({ requestId: 'req-1', reference: 'DSR-TEST', resendAfterSeconds: 45 });
    renderForm();
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: /verify my email/i }));

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock.mock.calls[0][1]).toBe('');
    expect(await screen.findByText(/we sent a 6-digit code/i)).toBeInTheDocument();
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
  });

  it('shows server-side errors and stays on the form', async () => {
    submitMock.mockRejectedValue(new DsarApiError('Too many attempts.', 'rate_limited', 429));
    renderForm();
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: /verify my email/i }));
    expect(await screen.findByText('Too many attempts.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /verify my email/i })).toBeInTheDocument();
  });
});
