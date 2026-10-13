import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

import { DmcaForm } from './DmcaForm';

const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: /^submit (notice|counter-notification)/i }));

function fillTakedown() {
  type(/full legal name/i, 'Jane Author');
  type(/email address/i, 'jane@example.com');
  type(/mailing address/i, '1 Main St, Springfield, IL 62701, USA');
  type(/describe the copyrighted work/i, 'My photograph "Harbor at Dawn", published in 2022.');
  type(/where is the infringing material/i, 'https://vireek.com/community/post-1');
  screen.getAllByRole('checkbox').forEach((c) => fireEvent.click(c));
  type(/electronic signature/i, 'Jane Author');
}

beforeEach(() => rpc.mockReset());

describe('DmcaForm', () => {
  it('shows validation errors, a summary alert, and focuses the first invalid field', async () => {
    render(<DmcaForm />);
    submit();
    expect(await screen.findByText(/please fix \d+ fields? highlighted below/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/full legal name/i)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/full legal name/i)).toHaveFocus();
    expect(screen.getByText(/confirm every statement/i)).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('clears a field error once the user edits that field', () => {
    render(<DmcaForm />);
    submit();
    expect(screen.getByLabelText(/email address/i)).toHaveAttribute('aria-invalid', 'true');
    type(/email address/i, 'jane@example.com');
    expect(screen.getByLabelText(/email address/i)).toHaveAttribute('aria-invalid', 'false');
  });

  it('submits a valid takedown and shows the reference number', async () => {
    rpc.mockResolvedValue({ data: { ok: true, reference: 'DMCA-2026-000042' }, error: null });
    render(<DmcaForm />);
    fillTakedown();
    submit();
    expect(await screen.findByText('DMCA-2026-000042')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/your notice has been received/i);
    expect(rpc).toHaveBeenCalledTimes(1);
    const payload = rpc.mock.calls[0][1].p_payload;
    expect(payload).toMatchObject({ notice_type: 'takedown', full_name: 'Jane Author', capacity: 'owner', website: '' });
    expect(payload.urls).toEqual(['https://vireek.com/community/post-1']);
  });

  it('lets the user submit another notice after success', async () => {
    rpc.mockResolvedValue({ data: { ok: true, reference: 'DMCA-2026-000001' }, error: null });
    render(<DmcaForm />);
    fillTakedown();
    submit();
    fireEvent.click(await screen.findByRole('button', { name: /submit another notice/i }));
    expect(screen.getByLabelText(/full legal name/i)).toHaveValue('');
  });

  it('shows a submitting state and blocks double submits', async () => {
    let resolve!: (v: unknown) => void;
    rpc.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<DmcaForm />);
    fillTakedown();
    submit();
    const busy = await screen.findByRole('button', { name: /submitting/i });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(rpc).toHaveBeenCalledTimes(1);
    resolve({ data: { ok: true, reference: 'DMCA-2026-000002' }, error: null });
    expect(await screen.findByText('DMCA-2026-000002')).toBeInTheDocument();
  });

  it('keeps what the user typed and shows a helpful error when the server is unavailable', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    render(<DmcaForm />);
    fillTakedown();
    submit();
    expect(await screen.findByText(/couldn.t send your notice/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /@vireek\.com/i })).toHaveAttribute('href', expect.stringContaining('mailto:'));
    expect(screen.getByLabelText(/full legal name/i)).toHaveValue('Jane Author');
  });

  it('shows the rate-limit message', async () => {
    rpc.mockResolvedValue({ data: { ok: false, error: 'rate_limited' }, error: null });
    render(<DmcaForm />);
    fillTakedown();
    submit();
    expect(await screen.findByText(/several notices recently/i)).toBeInTheDocument();
  });

  it('switches to the counter-notification layout, requiring a phone and different statements', () => {
    render(<DmcaForm />);
    fireEvent.click(screen.getByRole('button', { name: /submit a counter-notification/i }));
    expect(screen.getByRole('button', { name: /submit counter-notification/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/reference number of the original notice/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/link to the original work/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    submit();
    expect(screen.getByText(/phone number is required/i)).toBeInTheDocument();
  });

  it('preserves contact details but resets statements when switching type', () => {
    render(<DmcaForm />);
    type(/full legal name/i, 'Jane Author');
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByRole('button', { name: /submit a counter-notification/i }));
    expect(screen.getByLabelText(/full legal name/i)).toHaveValue('Jane Author');
    screen.getAllByRole('checkbox').forEach((c) => expect(c).not.toBeChecked());
  });

  it('opens on the counter-notification layout when asked', () => {
    render(<DmcaForm initialType="counter" />);
    expect(screen.getByRole('button', { name: /submit counter-notification/i })).toBeInTheDocument();
  });

  it('hides the honeypot from assistive tech and sends it through untouched', () => {
    const { container } = render(<DmcaForm />);
    const hp = container.querySelector('input[name="website"]') as HTMLInputElement;
    expect(hp.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(hp.tabIndex).toBe(-1);
  });

  it('does not call the backend when a bot fills nothing valid', async () => {
    render(<DmcaForm />);
    submit();
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(rpc).not.toHaveBeenCalled();
  });
});
