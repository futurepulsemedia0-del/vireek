import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Phone } from 'lucide-react';
import { Icon } from './Icon';

describe('Icon', () => {
  it('is decorative by default: aria-hidden, not focusable, token class', () => {
    const { container } = render(<Icon icon={Phone} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(svg).toHaveClass('icon-sm');
    expect(svg).not.toHaveAttribute('role');
  });
  it('is announced when it has a label', () => {
    render(<Icon icon={Phone} size="lg" label="Phone" />);
    const img = screen.getByRole('img', { name: 'Phone' });
    expect(img).toHaveClass('icon-lg');
    expect(img).not.toHaveAttribute('aria-hidden');
  });
  it('keeps caller classes and renders the matching pixel size attribute as a no-CSS fallback', () => {
    const { container } = render(<Icon icon={Phone} size="micro" className="text-accent" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('icon-micro', 'text-accent');
    expect(svg).toHaveAttribute('width', '12');
  });
});
