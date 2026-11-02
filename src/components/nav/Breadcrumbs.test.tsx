import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _key }),
}));

import { Breadcrumbs } from './Breadcrumbs';

const renderAt = (path: string, props: Parameters<typeof Breadcrumbs>[0] = {}) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Breadcrumbs {...props} />
    </MemoryRouter>,
  );

afterEach(cleanup);

describe('Breadcrumbs', () => {
  it('renders a labelled nav with exactly one aria-current="page" per list', () => {
    renderAt('/dashboard/jobs');
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(2); // desktop + mobile list
    expect(screen.getAllByRole('link', { name: 'Dashboard' })[0]).toHaveAttribute('href', '/dashboard');
  });

  it('shows the entity name instead of the raw id', () => {
    const id = '3f2b8c1e-0a4d-4e8b-9c1a-1b2c3d4e5f60';
    renderAt(`/dashboard/customers/${id}`, { entityLabels: { [`/dashboard/customers/${id}`]: 'Acme Plumbing' } });
    expect(screen.getAllByText('Acme Plumbing').length).toBeGreaterThan(0);
    expect(screen.queryByText(id)).toBeNull();
  });

  it('collapses long trails on mobile and expands on demand', () => {
    renderAt('/dashboard/a/b/c/d');
    const toggle = screen.getByRole('button', { name: 'Show hidden pages in the path' });
    fireEvent.click(toggle);
    expect(screen.queryByRole('button', { name: 'Show hidden pages in the path' })).toBeNull();
  });

  it('emits BreadcrumbList JSON-LD on public pages only, with "<" escaped', () => {
    const { container, unmount } = renderAt('/blog/x', { entityLabels: { '/blog/x': 'A </script> post' } });
    const ld = container.querySelector('script[type="application/ld+json"]');
    expect(ld?.innerHTML).toContain('BreadcrumbList');
    expect(ld?.innerHTML).not.toContain('</script>');
    unmount();
    const dash = renderAt('/dashboard/jobs');
    expect(dash.container.querySelector('script[type="application/ld+json"]')).toBeNull();
  });

  it('renders nothing for the site root', () => {
    const { container } = renderAt('/');
    expect(container.querySelector('nav')).toBeNull();
  });
});
