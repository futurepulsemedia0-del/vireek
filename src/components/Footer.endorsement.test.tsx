import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/components/CurrencySwitcher', () => ({ CurrencySwitcher: () => null }));
vi.mock('@/components/LanguageSwitcher', () => ({ LanguageSwitcher: () => null }));
vi.mock('framer-motion', () => ({
  motion: new Proxy({}, { get: () => ({ children }: { children?: React.ReactNode }) => <div>{children}</div> }),
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import { Footer } from './Footer';

const renderAt = (path: string) => render(<MemoryRouter initialEntries={[path]}><Footer /></MemoryRouter>);

afterEach(() => vi.unstubAllEnvs());

function enable() {
  vi.stubEnv('VITE_PLATFORM_ENDORSEMENT_ENABLED', 'true');
  vi.stubEnv('VITE_PLATFORM_PARENT_NAME', 'Acme Group');
}

describe('Footer endorsement', () => {
  it('flag OFF: DOM is identical on every path (no endorsement, no company link)', () => {
    const off = renderAt('/pricing').container.innerHTML;
    expect(off).not.toMatch(/Part of|legal\/company|Company information/);
  });
  it('flag ON: shows the line and company link on a platform page', () => {
    enable();
    renderAt('/pricing');
    expect(screen.getByTestId('platform-endorsement')).toHaveTextContent('Part of Acme Group');
    expect(screen.getByRole('link', { name: 'Company information' })).toHaveAttribute('href', '/legal/company');
  });
  it('flag ON: never shows on tenant-facing pages that reuse the Footer', () => {
    enable();
    for (const p of ['/quote/abc', '/book/acme', '/sign/t', '/portal/t/history', '/review/t', '/track/t']) {
      const { container, unmount } = renderAt(p);
      expect(container.innerHTML, p).not.toMatch(/Part of Acme|legal\/company/);
      unmount();
    }
  });
  it('flag ON + parent null: renders nothing extra, no errors', () => {
    vi.stubEnv('VITE_PLATFORM_ENDORSEMENT_ENABLED', 'true');
    const { container } = renderAt('/pricing');
    expect(container.innerHTML).not.toMatch(/Part of|Company information/);
  });
});
