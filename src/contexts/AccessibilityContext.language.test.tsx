import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { AccessibilityProvider, useAccessibility } from './AccessibilityContext';

function Probe() {
  const { language, setLanguage } = useAccessibility();
  return (
    <div>
      <span data-testid="lang">{language}</span>
      <button onClick={() => setLanguage('fa')}>to-fa</button>
      <button onClick={() => setLanguage('en')}>to-en</button>
    </div>
  );
}

const root = document.documentElement;

beforeEach(async () => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  root.removeAttribute('lang');
  root.removeAttribute('dir');
  root.classList.remove('a11y-rtl');
  await i18n.changeLanguage('en');
});

describe('AccessibilityProvider language sync', () => {
  it('sets <html lang/dir> on mount', () => {
    render(<AccessibilityProvider><Probe /></AccessibilityProvider>);
    expect(root.getAttribute('lang')).toBe('en');
    expect(root.getAttribute('dir')).toBe('ltr');
  });

  it('switching to Persian flips lang, dir, storage and i18next; switching back restores ltr', async () => {
    render(<AccessibilityProvider><Probe /></AccessibilityProvider>);
    fireEvent.click(screen.getByText('to-fa'));
    expect(root.getAttribute('lang')).toBe('fa');
    expect(root.getAttribute('dir')).toBe('rtl');
    expect(localStorage.getItem('vireek-a11y-lang')).toBe('fa');
    await waitFor(() => expect(i18n.language).toBe('fa'));

    fireEvent.click(screen.getByText('to-en'));
    expect(root.getAttribute('dir')).toBe('ltr');
    expect(root.classList.contains('a11y-rtl')).toBe(false);
  });

  it('?lang= beats stored language, and an explicit choice clears it from the URL', () => {
    localStorage.setItem('vireek-a11y-lang', 'de');
    window.history.replaceState(null, '', '/pricing?lang=ar');
    render(<AccessibilityProvider><Probe /></AccessibilityProvider>);
    expect(screen.getByTestId('lang').textContent).toBe('ar');
    expect(root.getAttribute('dir')).toBe('rtl');

    fireEvent.click(screen.getByText('to-en'));
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/pricing');
  });
});
