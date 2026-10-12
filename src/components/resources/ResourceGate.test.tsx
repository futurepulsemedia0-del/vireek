import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ResourceGate } from './ResourceGate';

const { captureResourceLead, writeUnlock } = vi.hoisted(() => ({
  captureResourceLead: vi.fn(),
  writeUnlock: vi.fn(),
}));

vi.mock('@/lib/resourceLeads', () => ({ captureResourceLead, writeUnlock }));

function setup() {
  const onUnlocked = vi.fn();
  const utils = render(
    <MemoryRouter>
      <ResourceGate resourceSlug="missed-call-text-back-scripts" resourceTitle="Text-Back Scripts" onUnlocked={onUnlocked} />
    </MemoryRouter>,
  );
  return { onUnlocked, ...utils };
}

const emailInput = () => screen.getByLabelText(/email address/i);
const submit = () => fireEvent.click(screen.getByRole('button', { name: /unlock free access/i }));

describe('ResourceGate', () => {
  beforeEach(() => {
    captureResourceLead.mockReset();
    writeUnlock.mockReset();
  });

  it('rejects an invalid email without calling the server', async () => {
    const { onUnlocked } = setup();
    fireEvent.change(emailInput(), { target: { value: 'not-an-email' } });
    submit();
    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();
    expect(captureResourceLead).not.toHaveBeenCalled();
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it('captures the lead, remembers the unlock and reveals the resource', async () => {
    captureResourceLead.mockResolvedValue({ ok: true });
    const { onUnlocked } = setup();
    fireEvent.change(emailInput(), { target: { value: 'you@company.com' } });
    submit();
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(captureResourceLead).toHaveBeenCalledWith('you@company.com', 'missed-call-text-back-scripts');
    expect(writeUnlock).toHaveBeenCalledTimes(1);
  });

  it('shows a friendly error and stays locked when the server rejects', async () => {
    captureResourceLead.mockResolvedValue({ ok: false, reason: 'rate_limited' });
    const { onUnlocked } = setup();
    fireEvent.change(emailInput(), { target: { value: 'you@company.com' } });
    submit();
    expect(await screen.findByText(/too many requests/i)).toBeInTheDocument();
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(writeUnlock).not.toHaveBeenCalled();
  });

  it('ignores bot submissions that fill the honeypot', async () => {
    const { onUnlocked, container } = setup();
    fireEvent.change(emailInput(), { target: { value: 'bot@spam.com' } });
    const honeypot = container.querySelector('input[name="company"]') as HTMLInputElement;
    fireEvent.change(honeypot, { target: { value: 'Acme' } });
    submit();
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
    expect(captureResourceLead).not.toHaveBeenCalled();
    expect(writeUnlock).not.toHaveBeenCalled();
  });
});
