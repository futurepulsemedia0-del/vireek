import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { TransparencyPage } from '@/pages/TransparencyPage';

vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/components/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/CookieConsent', () => ({ CookieConsent: () => null }));
vi.mock('@/components/ui/BackButton', () => ({ BackButton: () => null }));
vi.mock('@/components/EmptyState', () => ({ EmptyState: ({ title }: { title: string }) => <p>{title}</p> }));
vi.mock('@/lib/seo', () => ({ useSEO: () => undefined }));

const api = vi.hoisted(() => ({ fetchPublicReports: vi.fn(), fetchPublicIncidentLog: vi.fn() }));
vi.mock('@/lib/transparencyApi', () => api);

const report = {
  periodLabel: '2026-H1', periodStart: '2026-01-01', periodEnd: '2026-06-30', publishedAt: '2026-08-01T00:00:00Z', counselApprovedOn: '2026-07-20',
  suppressBelow: 5, introText: 'Intro paragraph.', reportingRulesText: 'Counts under 5 are shown as "< 5".', correctionsText: null,
  metrics: [
    { section: 'legal_requests', metric: 'received', dimension: '', key: '', count: null, suppressed: true },
    { section: 'legal_requests', metric: 'received', dimension: 'request_type', key: 'subpoena', count: 12 },
    { section: 'outages', metric: 'resolved_minutes', dimension: 'impact', key: 'major', count: 125 },
  ],
};
const incident = {
  publicRef: 'PIL-2026-0001', incidentType: 'wrong_diagnosis', severity: 'low', occurredOn: '2026-02-10', title: 'Wrong cause suggested',
  whatHappened: 'The assistant suggested a wrong cause.', impact: 'One caller misinformed.', whatWeDid: 'Fixed the prompt.', correctionNote: null, publishedAt: '2026-03-01T00:00:00Z',
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('TransparencyPage', () => {
  it('says plainly when nothing is published', async () => {
    api.fetchPublicReports.mockResolvedValue([]);
    api.fetchPublicIncidentLog.mockResolvedValue([]);
    render(<TransparencyPage />);
    expect(await screen.findByText('No transparency report has been published yet.')).toBeTruthy();
    expect(await screen.findByText('No incidents have been published.')).toBeTruthy();
  });

  it('renders a report with suppression and the incident log', async () => {
    api.fetchPublicReports.mockResolvedValue([report]);
    api.fetchPublicIncidentLog.mockResolvedValue([incident]);
    render(<TransparencyPage />);
    expect(await screen.findByText('Report 2026-H1')).toBeTruthy();
    expect(screen.getByText('< 5')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('2 h 5 min')).toBeTruthy();
    expect(screen.getByText('Wrong cause suggested')).toBeTruthy();
    expect(screen.getByText(/PIL-2026-0001/)).toBeTruthy();
  });

  it('shows an error without leaking details when loading fails', async () => {
    api.fetchPublicReports.mockRejectedValue(new Error('secret db detail'));
    api.fetchPublicIncidentLog.mockResolvedValue([]);
    render(<TransparencyPage />);
    await waitFor(() => expect(screen.getByText(/reports could not be loaded/)).toBeTruthy());
    expect(screen.queryByText(/secret db detail/)).toBeNull();
  });
});
