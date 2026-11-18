// src/lib/askVireek/shortcut.ts
//
// Keyboard shortcut to open the assistant: Ctrl/Cmd + "/" anywhere, or a bare "?"
// when the user is not typing. Never fires inside editable fields (except the
// modifier combo) and never steals browser/AT shortcuts.

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
}

export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
}

export function isEditableTarget(t: TargetLike | null | undefined): boolean {
  if (!t) return false;
  const tag = (t.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.isContentEditable) return true;
  const role = t.getAttribute?.('role');
  return role === 'textbox' || role === 'combobox' || role === 'searchbox';
}

export function isAssistantShortcut(e: KeyLike, target: TargetLike | null | undefined): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  if (e.key === '/' && (e.ctrlKey || e.metaKey) && !e.altKey) return true;
  if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) return !isEditableTarget(target);
  return false;
}
