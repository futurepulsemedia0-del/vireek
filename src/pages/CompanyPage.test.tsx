import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/components/Header', () => ({ Header: () => <header /> }));
vi.mock('@/components/Footer', () => ({ Footer: () => <footer /> }));
vi.mock('@/components/CookieConsent', () => ({ CookieConsent: () => null }));
vi.mock('@/components/ui/BackButton', () => ({ BackButton: () => null }));
vi.mock('@/pages/NotFoundPage', () => ({ NotFoundPage: () => <div data-testid="not-found" /> }));
vi.mock('@/lib/seo', () => ({ useSEO: vi.fn() }));

import { CompanyPage } from './CompanyPage';
import { useSEO } from '@/lib/seo';

const view = () => render(<MemoryRouter initialEntries={['/legal/company']}><CompanyPage /></MemoryRouter>);
afterEach(() => vi.unstubAllEnvs());

describe('CompanyPage', () => {
  it('flag OFF: behaves like an unknown route', () => {
    view();
    expect(screen.getByTestId('not-found')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });
  it('flag ON + parent: product, contact and "Part of" row, with a linked parent', () => {
    vi.stubEnv('VITE_PLATFORM_ENDORSEMENT_ENABLED', 'true');
    vi.stubEnv('VITE_PLATFORM_PARENT_NAME', 'Acme Group');
    vi.stubEnv('VITE_PLATFORM_PARENT_URL', 'https://acme.example');
    view();
    expect(screen.getByRole('heading', { level: 1, name: /company information/i })).toBeInTheDocument();
    expect(screen.getByText(/Vireek — AI voice receptionist/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Part of Acme Group' })).toHaveAttribute('href', 'https://acme.example/');
    // LEGAL_ENTITY is intentionally blank in the repo -> honest "being finalised" state, never invented data
    expect(screen.getByRole('status')).toHaveTextContent(/being finalised/i);
    expect(useSEO).toHaveBeenCalledWith(expect.objectContaining({ canonical: 'https://vireek.com/legal/company' }));
  });
  it('flag ON + parent null: page renders without a parent row and without errors', () => {
    vi.stubEnv('VITE_PLATFORM_ENDORSEMENT_ENABLED', 'true');
    view();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByText(/Part of/)).toBeNull();
  });
});
