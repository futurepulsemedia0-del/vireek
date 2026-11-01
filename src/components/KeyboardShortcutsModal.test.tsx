import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SHORTCUT_DEFS } from '@/lib/shortcuts/definitions';
import { shortcutStore } from '@/lib/shortcuts/store';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';

vi.mock('react-i18next', async () => (await import('@/test/i18nMock')).reactI18nextMock);

const press = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);

function open(onClose = vi.fn()) {
  render(<KeyboardShortcutsModal open onClose={onClose} />);
  return onClose;
}

describe('KeyboardShortcutsModal', () => {
  beforeEach(() => {
    window.localStorage.clear();
    shortcutStore.setScope('modal-test');
    shortcutStore.resetAll();
  });

  it('renders nothing when closed', () => {
    render(<KeyboardShortcutsModal open={false} onClose={() => undefined} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is a labelled modal dialog and moves focus inside it', () => {
    open();
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('lists every registered shortcut with a spoken key phrase', () => {
    open();
    expect(screen.getAllByRole('listitem')).toHaveLength(SHORTCUT_DEFS.length);
    expect(screen.getByRole('img', { name: 'Control K' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Question mark' })).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'G then C' })).toHaveLength(1);
  });

  it('closes on Escape', () => {
    const onClose = open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('records a new chord, saves it and announces success', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Go to My Jobs' }));
    expect(screen.getByText('Press the new keys… (Esc to cancel)')).toBeInTheDocument();
    press({ key: 'x', altKey: true, code: 'KeyX' });
    expect(await screen.findByText('Shortcut updated.')).toBeInTheDocument();
    expect(shortcutStore.getSnapshot()['nav.jobs']).toBe('alt+x');
    expect(screen.getByText('Customized')).toBeInTheDocument();
  });

  it('records a two-key sequence', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Go to My Jobs' }));
    press({ key: 'g' });
    press({ key: 'x' });
    expect(await screen.findByText('Shortcut updated.')).toBeInTheDocument();
    expect(shortcutStore.getSnapshot()['nav.jobs']).toBe('g x');
  });

  it('refuses a conflicting binding and names the shortcut that owns it', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Go to My Jobs' }));
    press({ key: 'g' });
    press({ key: 'o' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Already used by “Go to Overview”.');
    expect(shortcutStore.getSnapshot()['nav.jobs']).toBeUndefined();
  });

  it('refuses browser-reserved combinations', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Go to My Jobs' }));
    press({ key: 't', ctrlKey: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('reserved');
  });

  it('Escape cancels recording without closing the dialog', () => {
    const onClose = open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Go to My Jobs' }));
    press({ key: 'Escape' });
    expect(screen.queryByText('Press the new keys… (Esc to cancel)')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('turns a shortcut off, then resets it to the default', () => {
    open();
    const row = screen.getByText('Go to Calendar').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Turn off' }));
    expect(within(row).getByText('Off')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Reset shortcut for Go to Calendar' }));
    expect(within(row).queryByText('Off')).not.toBeInTheDocument();
    expect(within(row).getByRole('img', { name: 'G then C' })).toBeInTheDocument();
  });

  it('"Reset all" restores every default', () => {
    shortcutStore.setOverride('nav.jobs', 'g x');
    shortcutStore.setOverride('nav.team', null);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Reset all to defaults' }));
    expect(shortcutStore.getSnapshot()).toEqual({});
  });
});
