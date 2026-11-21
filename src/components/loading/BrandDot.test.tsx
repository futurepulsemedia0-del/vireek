import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandDot } from '@/components/loading/BrandDot';

describe('BrandDot', () => {
  it('draws one orange dot with three signal rings', () => {
    const { container } = render(<BrandDot />);
    expect(container.querySelectorAll('.vrk-v__nd')).toHaveLength(1);
    expect(container.querySelectorAll('.vrk-v__rg')).toHaveLength(3);
    expect(container.querySelector('svg')).toHaveClass('vrk-v--signal', 'vrk-v--dot');
  });

  it('is decorative by default and announces only when labelled', () => {
    const { container, rerender } = render(<BrandDot />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<BrandDot label="Refreshing" />);
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing');
  });

  it('never renders below 12px', () => {
    const { container } = render(<BrandDot size={4} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '12');
    expect(container.querySelector('svg')).toHaveAttribute('height', '12');
  });
});
