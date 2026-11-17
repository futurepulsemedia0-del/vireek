import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import { AccessibilityProvider } from '@/contexts/AccessibilityContext';
import { AccessibilityWidget } from './AccessibilityWidget';
import { openAccessibilityCenter, openAskData } from '@/lib/uiEvents';

function renderWidget() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AccessibilityProvider>
        <AccessibilityWidget />
      </AccessibilityProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('data-a11y-open');
  await i18n.changeLanguage('en');
});

describe('AccessibilityWidget (no floating launcher)', () => {
  it('renders no floating launcher button', () => {
    renderWidget();
    expect(screen.queryByRole('button', { name: /accessibility center/i })).toBeNull();
    expect(document.querySelector('[data-floating-launcher]')).toBeNull();
  });

  it('opens on the open event and flags the document', async () => {
    renderWidget();
    act(() => openAccessibilityCenter());
    expect(await screen.findByRole('dialog', { name: 'Accessibility Center' })).toBeTruthy();
    expect(document.documentElement.getAttribute('data-a11y-open')).toBe('true');
  });

  it('Escape closes it and returns focus to the element that opened it', async () => {
    renderWidget();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    act(() => openAccessibilityCenter());
    await screen.findByRole('dialog', { name: 'Accessibility Center' });
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 2000 });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    trigger.remove();
  });

  it('closes when the Ask-your-data panel is requested (no stacked panels)', async () => {
    renderWidget();
    act(() => openAccessibilityCenter());
    await screen.findByRole('dialog', { name: 'Accessibility Center' });
    act(() => openAskData());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 2000 });
  });
});
