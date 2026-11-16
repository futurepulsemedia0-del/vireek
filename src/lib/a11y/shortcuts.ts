export const SHORTCUT_ACTIONS = [
  'openCenter', 'toggleContrast', 'textLarger', 'textSmaller', 'readSelection',
  'stopSpeech', 'toggleFocusMode', 'openPageMap', 'resetAll',
] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];
export type ShortcutMap = Record<ShortcutAction, string>;

/** Combos use KeyboardEvent.code (layout independent): "Alt+Shift+KeyA". */
export const DEFAULT_SHORTCUTS: ShortcutMap = {
  openCenter: 'Alt+Shift+KeyA',
  toggleContrast: 'Alt+Shift+KeyC',
  textLarger: 'Alt+Shift+Equal',
  textSmaller: 'Alt+Shift+Minus',
  readSelection: 'Alt+Shift+KeyR',
  stopSpeech: 'Alt+Shift+KeyS',
  toggleFocusMode: 'Alt+Shift+KeyF',
  openPageMap: 'Alt+Shift+KeyH',
  resetAll: 'Alt+Shift+Digit0',
};

type ComboEvent = Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'code'>;
const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;
const CODE_RE = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Equal|Minus|Comma|Period|Slash|Semicolon|Quote|Backslash|BracketLeft|BracketRight|Backquote|Space|Enter|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right)|Insert|Delete)$/;

/** Browser/OS combos that must never be hijacked. */
const RESERVED = new Set([
  'Ctrl+KeyW', 'Ctrl+KeyT', 'Ctrl+KeyN', 'Ctrl+KeyR', 'Ctrl+KeyQ', 'Ctrl+KeyL', 'Ctrl+KeyD',
  'Ctrl+KeyC', 'Ctrl+KeyV', 'Ctrl+KeyX', 'Ctrl+KeyZ', 'Ctrl+KeyY', 'Ctrl+KeyA', 'Ctrl+KeyS',
  'Ctrl+KeyP', 'Ctrl+KeyF', 'Ctrl+KeyH', 'Ctrl+KeyJ', 'Ctrl+KeyU', 'Ctrl+Shift+KeyT', 'Ctrl+Shift+KeyN',
  'Alt+F4', 'Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+Home', 'Ctrl+Tab', 'Ctrl+Equal', 'Ctrl+Minus',
  'Ctrl+Digit0', 'Meta+KeyQ', 'Meta+KeyW', 'Meta+KeyT', 'Meta+KeyN', 'Meta+KeyR', 'Meta+KeyL',
  'Meta+KeyC', 'Meta+KeyV', 'Meta+KeyX', 'Meta+KeyZ', 'Meta+KeyA', 'Meta+KeyS', 'Meta+KeyP', 'Meta+KeyF',
]);

export function comboFromEvent(e: ComboEvent): string | null {
  if (!e.code || MODIFIER_CODES.test(e.code)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(e.code);
  return parts.join('+');
}

export function isValidCombo(combo: string): boolean {
  const parts = combo.split('+');
  const code = parts[parts.length - 1] ?? '';
  const mods = parts.slice(0, -1);
  if (!CODE_RE.test(code)) return false;
  if (new Set(mods).size !== mods.length) return false;
  if (!mods.every((m) => m === 'Ctrl' || m === 'Alt' || m === 'Shift' || m === 'Meta')) return false;
  if (!mods.some((m) => m === 'Ctrl' || m === 'Alt' || m === 'Meta')) return false; // never plain/Shift-only: breaks typing
  const order = ['Ctrl', 'Alt', 'Shift', 'Meta'];
  if (mods.some((m, i) => i > 0 && order.indexOf(m) < order.indexOf(mods[i - 1] ?? ''))) return false; // canonical order
  return !RESERVED.has(combo);
}

export function findConflict(map: ShortcutMap, action: ShortcutAction, combo: string): ShortcutAction | null {
  return SHORTCUT_ACTIONS.find((a) => a !== action && map[a] === combo) ?? null;
}

export function matchAction(map: ShortcutMap, combo: string): ShortcutAction | null {
  return SHORTCUT_ACTIONS.find((a) => map[a] === combo) ?? null;
}

/** Human label: "Alt+Shift+A". */
export function formatCombo(combo: string): string {
  return combo
    .split('+')
    .map((p) => p.replace(/^Key/, '').replace(/^Digit/, '').replace('Equal', '+').replace('Minus', '−').replace('Meta', '⌘'))
    .join('+');
}

/** Validates a stored map; any invalid or duplicate entry resets the whole map to defaults. */
export function sanitizeShortcuts(raw: unknown): ShortcutMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_SHORTCUTS };
  const rec = raw as Record<string, unknown>;
  const next = { ...DEFAULT_SHORTCUTS };
  for (const a of SHORTCUT_ACTIONS) {
    const v = rec[a];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !isValidCombo(v)) return { ...DEFAULT_SHORTCUTS };
    next[a] = v;
  }
  const used = SHORTCUT_ACTIONS.map((a) => next[a]);
  return new Set(used).size === used.length ? next : { ...DEFAULT_SHORTCUTS };
}
