import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import i18n from '@/i18n';
import { AccessibilityProvider } from '@/contexts/AccessibilityContext';
import { LanguagePreferences } from '@/components/settings/LanguagePreferences';

function renderIt() {
  return render(
    <AccessibilityProvider>
      <LanguagePreferences />
    </AccessibilityProvider>,
  );
}

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  await i18n.changeLanguage('en');
  document.documentElement.removeAttribute('dir');
  document.documentElement.removeAttribute('lang');
});

describe('LanguagePreferences', () => {
  it('lists all nine languages as a radio group with native names', () => {
    renderIt();
    expect(screen.getAllByRole('radio')).toHaveLength(9);
    expect(screen.getByRole('radio', { name: /فارسی/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /العربية/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /English/ })).toBeChecked();
  });

  it('switches to Persian: sets dir=rtl, lang=fa, loads strings and re-formats the preview', async () => {
    renderIt();

    fireEvent.click(screen.getByRole('radio', { name: /فارسی/ }));

    await waitFor(() => expect(document.documentElement.getAttribute('dir')).toBe('rtl'));
    expect(document.documentElement.getAttribute('lang')).toBe('fa');
    expect(i18n.language).toBe('fa');
    // lazy-loaded dashboard bundle arrives and the heading re-renders in Persian
    expect(await screen.findByRole('heading', { name: 'زبان و منطقه' })).toBeInTheDocument();
    // Persian digits in the currency / number preview
    expect(document.body.textContent).toMatch(/[۰-۹]/);
    expect(screen.getByText(/آینه‌ای شده/)).toBeInTheDocument();
  });

  it('switches back to English and restores ltr', async () => {
    renderIt();
    fireEvent.click(screen.getByRole('radio', { name: /العربية/ }));
    await waitFor(() => expect(document.documentElement.getAttribute('dir')).toBe('rtl'));

    fireEvent.click(screen.getByRole('radio', { name: /English/ }));
    await waitFor(() => expect(document.documentElement.getAttribute('dir')).toBe('ltr'));
    expect(await screen.findByRole('heading', { name: 'Language & region' })).toBeInTheDocument();
    expect(document.documentElement.classList.contains('a11y-rtl')).toBe(false);
  });

  it('persists the choice for the next visit', async () => {
    renderIt();
    fireEvent.click(screen.getByRole('radio', { name: /Deutsch/ }));
    await waitFor(() => expect(i18n.language).toBe('de'));
    expect(localStorage.getItem('vireek-a11y-lang')).toBe('de');
    expect(await screen.findByRole('heading', { name: 'Sprache & Region' })).toBeInTheDocument();
  });
});
