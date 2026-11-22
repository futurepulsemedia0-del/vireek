import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthShell } from './AuthParts';

vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));

afterEach(cleanup);

function brandLink(): HTMLAnchorElement {
  const { container } = render(
    <MemoryRouter>
      <AuthShell formMark={false} side={<div />}>
        <p>form</p>
      </AuthShell>
    </MemoryRouter>,
  );
  return container.querySelector('a[href="/"]') as HTMLAnchorElement;
}

describe('AuthShell top-bar brand', () => {
  it('is the same inline SVG wordmark the dashboard header uses, with one accessible name', () => {
    const link = brandLink();
    expect(link).not.toBeNull();
    expect(link.getAttribute('aria-label')).toBe('Vireek');
    const svg = link.querySelector('svg.vrk-logo');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    // The old markup also rendered a separate accent-coloured "Vireek" text node.
    expect(link.textContent).toBe('');
  });

  it('does not use a fixed-colour <img> (it vanished on dark backgrounds)', () => {
    expect(brandLink().querySelector('img')).toBeNull();
  });

  it('every letter/dot fill comes from theme tokens, never a hard-coded hex', () => {
    const fills = Array.from(brandLink().querySelectorAll('svg.vrk-logo path')).map((p) => p.getAttribute('fill') ?? '');
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) {
      expect(f).toMatch(/^rgb\(var\(--/);
      expect(f).not.toMatch(/^#/);
    }
  });
});
