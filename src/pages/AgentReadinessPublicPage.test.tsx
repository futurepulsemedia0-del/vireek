import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentReadinessPublicPage } from '@/pages/AgentReadinessPublicPage';

const calls: unknown[][] = [];
let impl: () => Promise<unknown> = async () => undefined;
vi.mock('@/lib/agentReadiness', () => ({ runPublicCheck: (...a: unknown[]) => { calls.push(a); return impl(); } }));
vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/components/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/CookieConsent', () => ({ CookieConsent: () => null }));
vi.mock('@/lib/seo', () => ({ useSEO: () => undefined }));

const done = {
  ok: true, host: 'acme.com', score: 40, coverage: 0.2,
  subscores: [{ id: 'website', score: 40, measuredChecks: 8, totalChecks: 8 }],
  checks: [{ ruleId: 'site_jsonld_business', subscore: 'website', status: 'fail', points: 0, max: 22, evidence: { k: 'lb_missing' } }],
  topFixes: [{ ruleId: 'site_jsonld_business', lost: 22, evidence: { k: 'lb_missing' } }],
};
const renderPage = () => render(<MemoryRouter><AgentReadinessPublicPage /></MemoryRouter>);

describe('AgentReadinessPublicPage', () => {
  beforeEach(() => { calls.length = 0; });
  it('disables submit until a URL is entered, then shows score and top fixes', async () => {
    impl = async () => done;
    renderPage();
    const button = screen.getByRole('button', { name: /check my website/i });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText(/website address/i), { target: { value: 'acme.com' } });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('img', { name: /40 \/ 100/ })).toBeTruthy());
    expect(screen.getAllByText(/LocalBusiness structured data/i).length).toBeGreaterThan(0);
    expect(calls).toEqual([['acme.com', '']]);
  });
  it('shows a translated, accessible error for a rate limit', async () => {
    impl = async () => ({ ok: false, code: 'rate_limited' });
    renderPage();
    fireEvent.change(screen.getByLabelText(/website address/i), { target: { value: 'acme.com' } });
    fireEvent.click(screen.getByRole('button', { name: /check my website/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/too many checks/i);
  });
  it('shows a network error when the call throws', async () => {
    impl = () => Promise.reject(new Error('x'));
    renderPage();
    fireEvent.change(screen.getByLabelText(/website address/i), { target: { value: 'acme.com' } });
    fireEvent.click(screen.getByRole('button', { name: /check my website/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not connect/i);
  });
});
