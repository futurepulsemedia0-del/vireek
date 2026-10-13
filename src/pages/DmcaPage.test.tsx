import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('@/components/Header', () => ({ Header: () => <header /> }));
vi.mock('@/components/Footer', () => ({ Footer: () => <footer /> }));
vi.mock('@/components/CookieConsent', () => ({ CookieConsent: () => null }));
vi.mock('@/components/ui/BackButton', () => ({ BackButton: () => null }));
vi.mock('@/lib/seo', () => ({ useSEO: vi.fn() }));
vi.mock('framer-motion', () => ({
  motion: { div: ({ children }: { children?: React.ReactNode }) => <div>{children}</div> },
}));

import { DmcaPage } from './DmcaPage';
import { useSEO } from '@/lib/seo';

describe('DmcaPage', () => {
  it('renders the procedure, the form and the designated agent', () => {
    render(
      <MemoryRouter initialEntries={['/dmca']}>
        <DmcaPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: /dmca & copyright complaints/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /what a copyright notice must include/i })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: /copyright notice form/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /designated copyright agent/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /@vireek\.com/i })).toHaveAttribute('href', expect.stringContaining('DMCA%20notice'));
  });

  it('registers the canonical URL', () => {
    render(
      <MemoryRouter>
        <DmcaPage />
      </MemoryRouter>,
    );
    expect(useSEO).toHaveBeenCalledWith(expect.objectContaining({ canonical: 'https://vireek.com/dmca' }));
  });

  it('?type=counter opens the counter-notification form', () => {
    render(
      <MemoryRouter initialEntries={['/dmca?type=counter']}>
        <DmcaPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /submit counter-notification/i })).toBeInTheDocument();
  });
});
