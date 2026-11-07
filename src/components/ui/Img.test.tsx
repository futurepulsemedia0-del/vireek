import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Img } from './Img';

describe('<Img>', () => {
  it('renders informative images with alt, intrinsic size, lazy + async by default', () => {
    render(<Img src="/a.png" alt="Dispatch board" width={640} height={360} />);
    const el = screen.getByRole('img', { name: 'Dispatch board' });
    expect(el).toHaveAttribute('width', '640');
    expect(el).toHaveAttribute('height', '360');
    expect(el).toHaveAttribute('loading', 'lazy');
    expect(el).toHaveAttribute('decoding', 'async');
    expect(el).toHaveAttribute('fetchpriority', 'auto');
  });

  it('hides decorative images from assistive tech with an explicit empty alt', () => {
    const { container } = render(<Img src="/d.png" decorative width={8} height={8} />);
    const el = container.querySelector('img');
    expect(el).toHaveAttribute('alt', '');
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('priority switches to eager + fetchpriority=high (LCP opt-out only)', () => {
    render(<Img src="/h.png" alt="Hero" width={1200} height={600} priority />);
    const el = screen.getByRole('img', { name: 'Hero' });
    expect(el).toHaveAttribute('loading', 'eager');
    expect(el).toHaveAttribute('fetchpriority', 'high');
  });

  it('reserves space via aspect-ratio when intrinsic size is unknown', () => {
    render(<Img src="/u.jpg" alt="Job photo" aspectRatio="4 / 3" />);
    expect(screen.getByRole('img', { name: 'Job photo' }).style.aspectRatio).toBe('4 / 3');
  });

  it('keeps the box and the accessible name when the file fails to load', () => {
    const onLoadError = vi.fn();
    render(<Img src="/broken.png" alt="Job photo" width={100} height={50} onLoadError={onLoadError} />);
    fireEvent.error(screen.getByRole('img', { name: 'Job photo' }));
    expect(onLoadError).toHaveBeenCalledOnce();
    const box = screen.getByRole('img', { name: 'Job photo' });
    expect(box.tagName).toBe('SPAN');
  });

  it('rejects omitting alt AND decorative at compile time', () => {
    // @ts-expect-error — neither `alt` nor `decorative`
    render(<Img src="/x.png" width={1} height={1} />);
    // @ts-expect-error — neither `width/height` nor `aspectRatio`
    render(<Img src="/x.png" alt="x" />);
  });
});
