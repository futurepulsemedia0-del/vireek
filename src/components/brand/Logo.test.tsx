import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import axe from 'axe-core';
import { Logo, type LogoVariant } from './Logo';
import { LOGO_SHAPES } from './logoPaths.generated';

afterEach(cleanup);

const VARIANTS: LogoVariant[] = ['wordmark', 'symbol', 'lockup', 'stacked', 'tile'];

describe('<Logo />', () => {
  it.each(VARIANTS)('%s exposes role=img and the accessible name "Vireek"', (variant) => {
    const { getByRole } = render(<Logo variant={variant} />);
    const svg = getByRole('img', { name: 'Vireek' });
    expect(svg.tagName.toLowerCase()).toBe('svg');
  });

  it.each(VARIANTS)('%s sets width and height so it cannot shift layout', (variant) => {
    const { container } = render(<Logo variant={variant} size={40} />);
    const svg = container.querySelector('svg')!;
    const shape = LOGO_SHAPES[variant];
    expect(svg.getAttribute('height')).toBe('40');
    expect(Number(svg.getAttribute('width'))).toBeCloseTo((40 * shape.w) / shape.h, 0);
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${shape.w} ${shape.h}`);
  });

  it('decorative logos are hidden from assistive tech and have no img role', () => {
    const { container, queryByRole } = render(<Logo decorative />);
    expect(queryByRole('img')).toBeNull();
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('auto tone uses the theme tokens (no hard-coded theme colors on letters)', () => {
    const { container } = render(<Logo variant="wordmark" />);
    const fills = [...container.querySelectorAll('path')].map((p) => p.getAttribute('fill'));
    expect(fills[0]).toContain('--accent-primary');
    expect(fills[1]).toContain('--logo-accent');
  });

  it('mono uses currentColor and white uses #FFFFFF', () => {
    const mono = render(<Logo variant="lockup" tone="mono" />).container.querySelectorAll('path');
    expect([...mono].every((p) => p.getAttribute('fill') === 'currentColor')).toBe(true);
    const white = render(<Logo variant="wordmark" tone="white" />).container.querySelectorAll('path');
    expect([...white].every((p) => p.getAttribute('fill') === '#FFFFFF')).toBe(true);
  });

  it('animated adds the pulse classes only where an accent dot exists', () => {
    const { container } = render(<Logo variant="symbol" animated />);
    expect(container.querySelector('svg')!.getAttribute('class')).toContain('vrk-logo--animated');
    expect(container.querySelector('.vrk-logo-dot')).not.toBeNull();
    expect(container.querySelector('.vrk-logo-ring')).not.toBeNull();
  });

  it('has no axe violations (accessible name present, valid ARIA)', async () => {
    const { container } = render(
      <main>
        {VARIANTS.map((v) => (
          <Logo key={v} variant={v} />
        ))}
        <a href="/" aria-label="Vireek home">
          <Logo decorative />
        </a>
      </main>,
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
