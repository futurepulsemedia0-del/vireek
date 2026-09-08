import { useEffect } from 'react';

type KeyHandler = (e: KeyboardEvent) => void;

interface ShortcutOptions {
  key: string;
  handler: KeyHandler;
  metaKey?: boolean;
  ctrlKey?: boolean;
  enabled?: boolean;
}

export function useKeyboardShortcut({ key, handler, metaKey, ctrlKey, enabled = true }: ShortcutOptions) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        if (key !== 'Escape') return;
      }
      if (metaKey && !e.metaKey) return;
      if (ctrlKey && !e.ctrlKey) return;
      if (e.key.toLowerCase() === key.toLowerCase()) {
        e.preventDefault();
        handler(e);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [key, handler, metaKey, ctrlKey, enabled]);
}
