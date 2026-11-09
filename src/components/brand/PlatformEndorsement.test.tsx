import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EndorsementStructuredData, PlatformEndorsement } from './PlatformEndorsement';

afterEach(() => {
  vi.unstubAllEnvs();
  document.head.querySelectorAll('#vireek-parent-org-ld').forEach((n) => n.remove());
});

describe('PlatformEndorsement', () => {
  it('renders nothing when OFF', () => {
    const { container } = render(<PlatformEndorsement />);
    expect(container).toBeEmptyDOMElement();
  });
  it('renders nothing when ON but parent is null', () => {
    vi.stubEnv('VITE_PLATFORM_ENDORSEMENT_ENABLED', 'true');
    const { container } = render(<PlatformEndorsement />);
    expect(container).toBeEmptyDOMElement();
  });
  it('renders the line, linking the parent only for a valid https URL', () => {
    vi.stubEnv('VITE_PLATFORM_ENDORSEMENT_ENABLED', 'true');
    vi.stubEnv('VITE_PLATFORM_PARENT_NAME', 'Acme Group');
    vi.stubEnv('VITE_PLATFORM_PARENT_URL', 'https://acme.example');
    render(<PlatformEndorsement />);
    expect(screen.getByTestId('platform-endorsement')).toHaveTextContent('Part of Acme Group');
    expect(screen.getByRole('link', { name: 'Acme Group' })).toHaveAttribute('href', 'https://acme.example/');
  });
});

describe('EndorsementStructuredData', () => {
  it('injects nothing when OFF', () => {
    render(<EndorsementStructuredData />);
    expect(document.getElementById('vireek-parent-org-ld')).toBeNull();
  });
  it('injects parentOrganization JSON-LD when ON, and cleans up on unmount', () => {
    vi.stubEnv('VITE_PLATFORM_ENDORSEMENT_ENABLED', 'true');
    vi.stubEnv('VITE_PLATFORM_PARENT_NAME', 'Acme Group');
    const { unmount } = render(<EndorsementStructuredData />);
    const el = document.getElementById('vireek-parent-org-ld');
    expect(el).not.toBeNull();
    expect(JSON.parse(el!.textContent ?? '{}').parentOrganization.name).toBe('Acme Group');
    unmount();
    expect(document.getElementById('vireek-parent-org-ld')).toBeNull();
  });
});
