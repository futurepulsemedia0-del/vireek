import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/components/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/CookieConsent', () => ({ CookieConsent: () => null }));
vi.mock('@/components/ui/BackButton', () => ({ BackButton: () => null }));
vi.mock('@/lib/seo', () => ({ useSEO: () => undefined }));

import { DataPromisePage } from '@/pages/DataPromisePage';
import { categoryClaims, DATA_PROMISE_SLA } from '@/lib/dataPromise';

afterEach(() => cleanup());
const renderPage = () => render(<MemoryRouter><DataPromisePage /></MemoryRouter>);

describe('/data-promise', () => {
  it('claims only categories backed by the verified-live export parts', () => {
    const byId = Object.fromEntries(categoryClaims().map((c) => [c.id, c.available]));
    expect(byId.customers).toBe(true);
    expect(byId.jobs).toBe(true);
    expect(byId.calls).toBe(true);
    expect(byId.recordings).toBe(true);
    // Supplement-only categories stay "not yet" until EXPORT_PARTS_LIVE.supplement is verified and switched on.
    expect(byId.customer_details).toBe(false);
    expect(byId.job_details).toBe(false);
    expect(byId.documents).toBe(false);
    expect(byId.accounts).toBe(false);
  });

  it('renders available and not-yet categories, the schema link and the limits', () => {
    renderPage();
    expect(screen.getByText('Customers')).toBeTruthy();
    expect(screen.getByText('Links to call recordings')).toBeTruthy();
    expect(screen.getByText('Not in the self-serve export yet')).toBeTruthy();
    expect(screen.getByText('Documents')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'machine-readable schema' }).getAttribute('href')).toBe('/data-promise/export-schema.json');
    expect(screen.getByText(/not a promise that every record/)).toBeTruthy();
  });

  it('does not invent a delivery time, and never shows placeholder text', () => {
    const { container } = renderPage();
    expect(DATA_PROMISE_SLA.assistedExportDays).toBeNull();
    expect(container.textContent).toContain('not yet published a delivery commitment');
    expect(container.textContent).not.toMatch(/TODO|\[VERIFY\]|\[COUNSEL\]|100%|everything/i);
  });
});
