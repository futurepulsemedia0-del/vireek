import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthInput } from './AuthParts';

const base = { id: 'f', label: 'Field', icon: <span />, value: '', onChange: () => undefined };
const stubPointer = (coarse: boolean) =>
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('coarse') ? coarse : false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AuthInput mobile behaviour', () => {
  it('email fields disable auto-capitalisation/correction and use the email keyboard', () => {
    stubPointer(false);
    render(<AuthInput {...base} type="email" />);
    const el = screen.getByLabelText('Field');
    expect(el.getAttribute('inputmode')).toBe('email');
    expect(el.getAttribute('autocapitalize')).toBe('none');
    expect(el.getAttribute('autocorrect')).toBe('off');
    expect(el.getAttribute('spellcheck')).toBe('false');
  });

  it('caller-provided attributes override the email defaults', () => {
    stubPointer(false);
    render(<AuthInput {...base} type="email" inputMode="text" />);
    expect(screen.getByLabelText('Field').getAttribute('inputmode')).toBe('text');
  });

  it('does not auto-focus on touch-primary devices, but does on desktop', () => {
    stubPointer(true);
    const { unmount } = render(<AuthInput {...base} autoFocus />);
    expect(document.activeElement).not.toBe(screen.getByLabelText('Field'));
    unmount();
    stubPointer(false);
    render(<AuthInput {...base} autoFocus />);
    expect(document.activeElement).toBe(screen.getByLabelText('Field'));
  });

  it('password toggle is a 44px target', () => {
    stubPointer(false);
    render(<AuthInput {...base} type="password" showPasswordToggle />);
    expect(screen.getByRole('button', { name: /show password/i }).className).toMatch(/h-11/);
  });
});
