import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StaffTransparencyPage } from '@/pages/admin/StaffTransparencyPage';
import en from '@/locales/en/transparency.json';

vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/lib/seo', () => ({ useSEO: () => undefined }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/i18n/transparencyNamespace', () => ({
  useTransparencyT: () => ({
    language: 'en',
    t: (key: string, vars?: Record<string, unknown>) => {
      const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en);
      return typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_m, n) => String(vars?.[n] ?? '')) : key;
    },
  }),
}));

const api = vi.hoisted(() => {
  class TransparencyApiError extends Error { kind: string; rule?: string; constructor(kind: string, rule?: string) { super(kind); this.kind = kind; this.rule = rule; } }
  return { TransparencyApiError, listReports: vi.fn(), createReport: vi.fn(), refreshReport: vi.fn(), updateReport: vi.fn(), listEntries: vi.fn(), createEntry: vi.fn(), updateEntry: vi.fn() };
});
vi.mock('@/lib/transparencyApi', () => api);

const report = (over = {}) => ({
  id: 'r1', periodLabel: '2026-H1', periodStart: '2026-01-01', periodEnd: '2026-06-30', status: 'draft', suppressBelow: null,
  metrics: [{ section: 'ai_incidents', metric: 'received', dimension: '', key: '', count: 2 }], compiledAt: '2026-07-02T10:00:00Z',
  introText: '', reportingRulesText: '', correctionsText: '', counselApprovedOn: null, publishedAt: null, ...over,
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('StaffTransparencyPage', () => {
  it('blocks approval until text and a counsel date exist, and lists what is missing', async () => {
    api.listReports.mockResolvedValue([report()]);
    render(<StaffTransparencyPage />);
    expect(await screen.findByText('Write the introduction.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Mark approved' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the redaction finding in the incident form and disables saving', async () => {
    api.listReports.mockResolvedValue([]);
    api.listEntries.mockResolvedValue([]);
    render(<StaffTransparencyPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Public AI incident log' }));
    const field = await screen.findByLabelText(/What happened/);
    fireEvent.change(field, { target: { value: 'The caller jane@example.com was told a wrong cause.' } });
    await waitFor(() => expect(screen.getByText('Found: e-mail address')).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('turns a database redaction error into a readable message', async () => {
    api.listReports.mockResolvedValue([report({ introText: 'i', reportingRulesText: 'r', status: 'approved', counselApprovedOn: '2026-07-10' })]);
    api.updateReport.mockRejectedValue(new api.TransparencyApiError('gate'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<StaffTransparencyPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(en.errors.gate, 'error'));
  });
});
