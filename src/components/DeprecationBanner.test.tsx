import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DeprecationBanner } from './DeprecationBanner';
import type { DeprecationEntry } from '../../supabase/functions/_shared/lifecycle/deprecations';

const mocks = vi.hoisted(() => ({ auth: {} as Record<string, unknown>, lang: 'en' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/i18n/lifecycleNamespace', () => ({ LIFECYCLE_NS: 'lifecycle' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
    i18n: { language: mocks.lang },
  }),
}));

const NOW = new Date('2026-11-19T10:00:00Z');

function entry(over: Partial<DeprecationEntry> = {}): DeprecationEntry {
  return {
    id: 'legacy-export',
    kind: 'feature',
    noticeClass: 'stable',
    title: 'Legacy export',
    summary: 'Use the new export instead.',
    owner: 'compliance',
    announcedAt: '2026-11-01',
    sunsetAt: '2027-03-01',
    dataExport: { holdsCustomerData: false },
    banner: { enabled: true },
    ...over,
  };
}

function setAuth(extra: Record<string, unknown> = {}) {
  mocks.auth = { user: { id: 'u1' }, isOwner: true, profileLoading: false, ...extra };
}

function show(entries: readonly DeprecationEntry[], path = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <DeprecationBanner entries={entries} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.lang = 'en';
  setAuth();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('DeprecationBanner', () => {
  it('renders nothing for the real (empty) registry', () => {
    const { container } = render(
      <MemoryRouter>
        <DeprecationBanner />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the profile loads, without a user, or when no entry qualifies', () => {
    setAuth({ profileLoading: true });
    expect(show([entry()]).container).toBeEmptyDOMElement();
    setAuth({ user: null });
    expect(show([entry()]).container).toBeEmptyDOMElement();
    setAuth();
    expect(show([entry({ banner: { enabled: false } })]).container).toBeEmptyDOMElement();
    expect(show([entry({ removedAt: '2026-11-18' })]).container).toBeEmptyDOMElement();
  });

  it('shows the title, summary, an ISO removal date in a LTR <time>, and the days left', () => {
    show([entry()]);
    expect(screen.getByRole('region', { name: 'regionLabel' })).toBeInTheDocument();
    expect(screen.getByText(/headline/)).toHaveTextContent('Legacy export');
    expect(screen.getByText('Use the new export instead.')).toBeInTheDocument();
    const time = screen.getByText('2027-03-01');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', '2027-03-01');
    expect(time).toHaveAttribute('dir', 'ltr');
    expect(screen.getByTestId('deprecation-legacy-export')).toHaveTextContent('daysLeft {"count":102}');
  });

  it('uses the language override when the registry has one, English otherwise', () => {
    const e = entry({ messages: { es: { title: 'Exportación antigua', summary: 'Usa la nueva exportación.' } } });
    mocks.lang = 'es-MX';
    show([e]);
    expect(screen.getByText(/headline/)).toHaveTextContent('Exportación antigua');
    expect(screen.getByText('Usa la nueva exportación.')).toBeInTheDocument();
  });

  it('links: export route only when customer data is held; replacement route; migration guide opens safely', () => {
    show([
      entry({
        dataExport: { holdsCustomerData: true, exportRoute: '/dashboard/exports' },
        replacement: { label: 'New export', route: '/dashboard/exports/new' },
        migrationUrl: 'https://vireek.com/docs/migrate',
      }),
    ]);
    expect(screen.getByRole('link', { name: 'exportData' })).toHaveAttribute('href', '/dashboard/exports');
    expect(screen.getByRole('link', { name: /replacement/ })).toHaveAttribute('href', '/dashboard/exports/new');
    const guide = screen.getByRole('link', { name: 'migrationGuide' });
    expect(guide).toHaveAttribute('href', 'https://vireek.com/docs/migrate');
    expect(guide).toHaveAttribute('target', '_blank');
    expect(guide).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows no export link when no customer data is held', () => {
    show([entry({ dataExport: { holdsCustomerData: false, exportRoute: '/dashboard/exports' } })]);
    expect(screen.queryByRole('link', { name: 'exportData' })).toBeNull();
  });

  it('never renders an unsafe link even if the registry is wrong', () => {
    show([
      entry({
        replacement: { label: 'Bad', url: 'javascript:alert(1)' },
        migrationUrl: 'http://vireek.com/insecure',
        dataExport: { holdsCustomerData: true, exportRoute: '//evil.com' },
      }),
    ]);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('dismiss hides the entry, remembers it on this device, and keeps the others', () => {
    const second = entry({ id: 'other-thing', title: 'Other thing', sunsetAt: '2027-05-01' });
    const { unmount } = show([entry(), second]);
    fireEvent.click(screen.getAllByRole('button', { name: /dismiss/ })[0]);
    expect(screen.queryByTestId('deprecation-legacy-export')).toBeNull();
    expect(screen.getByTestId('deprecation-other-thing')).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('vireek-deprecation-dismissed-v1:u1') as string)).toEqual(['legacy-export']);
    unmount();
    show([entry(), second]);
    expect(screen.queryByTestId('deprecation-legacy-export')).toBeNull();
    expect(screen.getByTestId('deprecation-other-thing')).toBeInTheDocument();
  });

  it('the last 14 days cannot be dismissed, and an earlier dismissal no longer hides it', () => {
    window.localStorage.setItem('vireek-deprecation-dismissed-v1:u1', JSON.stringify(['legacy-export']));
    show([entry({ sunsetAt: '2026-12-03' })]); // 14 days left
    expect(screen.getByTestId('deprecation-legacy-export')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss/ })).toBeNull();
  });

  it('survives corrupt or unavailable storage', () => {
    window.localStorage.setItem('vireek-deprecation-dismissed-v1:u1', '{not json');
    show([entry()]);
    expect(screen.getByTestId('deprecation-legacy-export')).toBeInTheDocument();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    fireEvent.click(screen.getByRole('button', { name: /dismiss/ }));
    expect(screen.queryByTestId('deprecation-legacy-export')).toBeNull(); // hidden for this session even if it cannot persist
    spy.mockRestore();
  });

  it('owner-only entries are hidden from non-owners; route-scoped entries only show on their routes', () => {
    setAuth({ isOwner: false });
    expect(show([entry({ banner: { enabled: true, audience: 'owner' } })]).container).toBeEmptyDOMElement();
    setAuth({ isOwner: true });
    const scoped = entry({ banner: { enabled: true, routePrefixes: ['/dashboard/exports'] } });
    expect(show([scoped], '/dashboard/jobs').container).toBeEmptyDOMElement();
    show([scoped], '/dashboard/exports');
    expect(screen.getByTestId('deprecation-legacy-export')).toBeInTheDocument();
  });

  it('at most two notices, most urgent first', () => {
    show([
      entry({ id: 'c', sunsetAt: '2027-09-01' }),
      entry({ id: 'a', sunsetAt: '2027-03-01' }),
      entry({ id: 'b', sunsetAt: '2027-05-01' }),
    ]);
    const shown = screen.getAllByTestId(/^deprecation-/).map((n) => n.getAttribute('data-testid'));
    expect(shown).toEqual(['deprecation-a', 'deprecation-b']);
  });

  it('after the sunset date (not yet removed) it says so instead of counting down', () => {
    show([entry({ noticeClass: 'forced', forcedReason: 'Vendor shut down', sunsetAt: '2026-11-10' })]);
    expect(screen.getByTestId('deprecation-legacy-export')).toHaveTextContent('sunsetPassed');
  });
});
