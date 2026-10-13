import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ServerErrorView, type IncidentReporter } from './ServerErrorView';

const ID = 'INC-7K3Q-9XMD';
const reporter = (over: Partial<IncidentReporter> = {}): IncidentReporter => ({ enabled: true, send: vi.fn().mockResolvedValue(undefined), ...over });

describe('ServerErrorView', () => {
  it('shows the incident id and recovery actions', () => {
    render(<ServerErrorView incidentId={ID} reporter={reporter()} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/something went wrong/i);
    expect(screen.getByTestId('incident-id')).toHaveTextContent(ID);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go to dashboard/i })).toBeInTheDocument();
  });

  it('falls back to a prefilled support email when reporting is not configured', () => {
    render(<ServerErrorView incidentId={ID} reporter={reporter({ enabled: false })} />);
    expect(screen.queryByRole('button', { name: /report this problem/i })).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: /email support about this/i });
    expect(link.getAttribute('href')).toContain('mailto:');
    expect(decodeURIComponent(link.getAttribute('href') ?? '')).toContain(ID);
  });

  it('sends a report linked to the incident and confirms it', async () => {
    const r = reporter();
    render(<ServerErrorView incidentId={ID} eventId="evt1" reporter={r} />);
    fireEvent.click(screen.getByRole('button', { name: /report this problem/i }));
    fireEvent.change(screen.getByLabelText(/what were you doing/i), { target: { value: 'Saving a job' } });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/your report was sent/i));
    expect(r.send).toHaveBeenCalledWith({ incidentId: ID, eventId: 'evt1', message: 'Saving a job', email: null });
  });

  it('blocks an invalid email without sending', () => {
    const r = reporter();
    render(<ServerErrorView incidentId={ID} reporter={r} />);
    fireEvent.click(screen.getByRole('button', { name: /report this problem/i }));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));
    expect(r.send).not.toHaveBeenCalled();
    expect(screen.getByText(/doesn.t look right/i)).toBeInTheDocument();
  });

  it('shows the failure, keeps the form and still offers email', async () => {
    const r = reporter({ send: vi.fn().mockRejectedValue(new Error('Could not send the report.')) });
    render(<ServerErrorView incidentId={ID} reporter={r} />);
    fireEvent.click(screen.getByRole('button', { name: /report this problem/i }));
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not send the report/i));
    expect(screen.getByRole('button', { name: /send report/i })).toBeEnabled();
    expect(screen.getByRole('link', { name: /email support/i })).toBeInTheDocument();
  });

  it('explains a stale-deploy chunk error instead of a generic failure', () => {
    render(<ServerErrorView incidentId={ID} error={new Error('Failed to fetch dynamically imported module: /a.js')} reporter={reporter()} />);
    expect(screen.getByText(/was just updated/i)).toBeInTheDocument();
  });
});
