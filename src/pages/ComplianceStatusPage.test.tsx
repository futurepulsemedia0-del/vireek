import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ComplianceStatusPage } from '@/pages/ComplianceStatusPage';

vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/components/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/CookieConsent', () => ({ CookieConsent: () => null }));

const fetchMock = vi.fn();
const renderPage = () =>
  render(
    <MemoryRouter>
      <ComplianceStatusPage />
    </MemoryRouter>,
  );

function fillValid() {
  fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Jane Doe' } });
  fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'jane@acme.com' } });
  fireEvent.change(screen.getByLabelText(/^company/i), { target: { value: 'Acme HVAC' } });
  fireEvent.click(screen.getByLabelText('Data Processing Agreement (DPA)'));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ComplianceStatusPage', () => {
  it('states plainly that none of the three is held', () => {
    renderPage();
    expect(screen.getByText(/does not currently hold a SOC 2 report/i)).toBeInTheDocument();
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(4); // header + 3 frameworks
    expect(within(screen.getByRole('table')).getAllByText('Not held')).toHaveLength(3);
    expect(screen.queryByText(/SOC 2 (compliant|certified|ready|aligned)/i)).not.toBeInTheDocument();
  });

  it('shows validation errors and does not submit an incomplete request', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /send request/i }));
    expect(await screen.findByText('Enter your full name.')).toBeInTheDocument();
    expect(screen.getByText('Choose at least one thing you need.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits a valid request and shows the confirmation', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    renderPage();
    fillValid();
    fireEvent.click(screen.getByRole('button', { name: /send request/i }));
    expect(await screen.findByRole('status')).toHaveTextContent('jane@acme.com');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ source: 'compliance-evidence-request', email: 'jane@acme.com' });
    fireEvent.click(screen.getByRole('button', { name: /submit another request/i }));
    expect(screen.getByRole('button', { name: /send request/i })).toBeInTheDocument();
  });

  it('shows an error with a direct email fallback and can retry', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });
    renderPage();
    fillValid();
    fireEvent.click(screen.getByRole('button', { name: /send request/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/ali@vireek\.com/);
    fireEvent.click(screen.getByRole('button', { name: /send request/i }));
    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('silently drops submissions that fill the honeypot', async () => {
    renderPage();
    fillValid();
    fireEvent.change(document.querySelector('input[name="website"]')!, { target: { value: 'http://spam' } });
    fireEvent.click(screen.getByRole('button', { name: /send request/i }));
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
