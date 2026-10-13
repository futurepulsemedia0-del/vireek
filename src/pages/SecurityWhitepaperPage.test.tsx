import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SecurityWhitepaperPage } from '@/pages/SecurityWhitepaperPage';
import { SECTIONS } from '@/lib/securityWhitepaper';

const pdf = vi.hoisted(() => ({ downloadSecurityWhitepaperPdf: vi.fn() }));

vi.mock('@/lib/securityWhitepaperPdf', () => pdf);
vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/components/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/CookieConsent', () => ({ CookieConsent: () => null }));

const renderPage = () =>
  render(
    <MemoryRouter>
      <SecurityWhitepaperPage />
    </MemoryRouter>,
  );

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

describe('SecurityWhitepaperPage', () => {
  it('renders the heading, every section and the contents navigation', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    for (const s of SECTIONS) {
      expect(screen.getByRole('heading', { level: 2, name: new RegExp(s.title) })).toBeInTheDocument();
    }
    const nav = screen.getByRole('navigation', { name: 'Whitepaper contents' });
    expect(nav.querySelectorAll('a')).toHaveLength(SECTIONS.length);
  });

  it('sets the document title and restores it on unmount', () => {
    const before = document.title;
    const { unmount } = renderPage();
    expect(document.title).toBe('Security Whitepaper | Vireek');
    unmount();
    expect(document.title).toBe(before);
  });

  it('jumps to a section from the contents', () => {
    renderPage();
    const link = screen.getByRole('link', { name: /Access control|Identity and access control/ });
    fireEvent.click(link);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(link).toHaveAttribute('aria-current', 'location');
  });

  it('downloads the PDF and returns to the idle state', async () => {
    pdf.downloadSecurityWhitepaperPdf.mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /download pdf/i }));
    await waitFor(() => expect(pdf.downloadSecurityWhitepaperPdf).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: /download pdf/i })).toBeEnabled();
  });

  it('shows an error with a fallback contact when generation fails, and can retry', async () => {
    pdf.downloadSecurityWhitepaperPdf.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /download pdf/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't generate the PDF/i);
    fireEvent.click(screen.getByRole('button', { name: /download pdf/i }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(pdf.downloadSecurityWhitepaperPdf).toHaveBeenCalledTimes(2);
  });
});
