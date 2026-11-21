import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandLoader, type BrandLoaderVariant } from '@/components/loading/BrandLoader';

const q = (c: HTMLElement, sel: string) => c.querySelectorAll(sel);

describe('BrandLoader', () => {
  it('is decorative by default and announces only when labelled', () => {
    const { container, rerender } = render(<BrandLoader />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<BrandLoader label="Loading" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
  });

  it('always draws the V and exactly one orange dot', () => {
    const variants: BrandLoaderVariant[] = ['thread', 'fill', 'signal', 'network', 'pulse'];
    for (const v of variants) {
      const { container, unmount } = render(<BrandLoader variant={v} />);
      expect(q(container, '.vrk-v__nd')).toHaveLength(1);
      expect(container.querySelector('svg')).toHaveClass(`vrk-v--${v}`);
      unmount();
    }
  });

  it('draws variant-specific parts', () => {
    const signal = render(<BrandLoader variant="signal" />);
    expect(q(signal.container, '.vrk-v__rg')).toHaveLength(3);
    signal.unmount();
    const net = render(<BrandLoader variant="network" />);
    expect(q(net.container, '.vrk-v__sat')).toHaveLength(4);
    expect(q(net.container, '.vrk-v__lk')).toHaveLength(4);
    net.unmount();
    const pulse = render(<BrandLoader variant="pulse" />);
    expect(q(pulse.container, '.vrk-v__tr')).toHaveLength(1);
    expect(q(pulse.container, '.vrk-v__pl')).toHaveLength(1);
  });

  it('fill: determinate only with a real number, clamped to 0–100', () => {
    const { container, rerender } = render(<BrandLoader variant="fill" progress={40} />);
    const path = () => container.querySelector('.vrk-v__m') as SVGPathElement;
    expect(container.querySelector('svg')).toHaveClass('vrk-v--det');
    expect(Number(path().getAttribute('stroke-dashoffset'))).toBeCloseTo(0.6);
    rerender(<BrandLoader variant="fill" progress={250} />);
    expect(Number(path().getAttribute('stroke-dashoffset'))).toBe(0);
    expect(container.querySelector('svg')).toHaveClass('vrk-v--done');
    rerender(<BrandLoader variant="fill" progress={-5} />);
    expect(path().getAttribute('opacity')).toBe('0');
    rerender(<BrandLoader variant="fill" progress={null} />);
    expect(container.querySelector('svg')).not.toHaveClass('vrk-v--det');
    expect(path().getAttribute('stroke-dashoffset')).toBeNull();
  });

  it('ignores progress on non-fill variants', () => {
    const { container } = render(<BrandLoader variant="signal" progress={50} />);
    expect(container.querySelector('svg')).not.toHaveClass('vrk-v--det');
  });
});
