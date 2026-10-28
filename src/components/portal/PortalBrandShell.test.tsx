import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(),
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }) }) },
  },
}));

const fetchPortalBranding = vi.fn();
vi.mock('@/lib/branding', async () => {
  const actual = await vi.importActual<typeof import('@/lib/branding')>('@/lib/branding');
  return { ...actual, fetchPortalBranding: (...a: unknown[]) => fetchPortalBranding(...a) };
});

import { PortalBrandShell } from './PortalBrandShell';

const branded = (over = {}) => ({
  business_name: 'Acme HVAC',
  logo_path: 'owner/logo.png',
  primary_color: '#15803D',
  accent_color: '#65A30D',
  portal_theme: 'auto',
  portal_welcome_title: 'Welcome',
  portal_welcome_message: 'Everything in one place.',
  portal_show_powered_by: false,
  ...over,
});

const renderShell = () =>
  render(
    <PortalBrandShell token="t1" welcome>
      <main>content</main>
    </PortalBrandShell>,
  );

beforeEach(() => {
  fetchPortalBranding.mockReset();
  document.title = '';
});

describe('PortalBrandShell — no Vireek strings leak', () => {
  it('white-labeled portal: zero Vireek anywhere (text, markup, title)', async () => {
    fetchPortalBranding.mockResolvedValue(branded());
    const { container } = renderShell();
    await screen.findByAltText('Acme HVAC');
    expect(container.innerHTML).not.toMatch(/vireek/i);
    expect(document.title).not.toMatch(/vireek/i);
    expect(document.title).toContain('Acme HVAC');
  });

  it('shows the badge only when the server says it is required', async () => {
    fetchPortalBranding.mockResolvedValue(branded({ portal_show_powered_by: true }));
    renderShell();
    expect(await screen.findByText('Vireek')).toBeTruthy();
  });

  it('invalid/disabled portal renders neutral chrome with no Vireek', async () => {
    fetchPortalBranding.mockResolvedValue(null);
    const { container } = renderShell();
    await screen.findByText('content');
    expect(container.innerHTML).not.toMatch(/vireek/i);
  });

  it('while loading nothing brand-related (and no badge) is rendered', () => {
    fetchPortalBranding.mockReturnValue(new Promise(() => undefined));
    const { container } = renderShell();
    expect(container.innerHTML).not.toMatch(/vireek/i);
  });
});
