/**
 * Central keyboard-shortcut registry — PURE logic (no React, no DOM access).
 *
 * Single source of truth consumed by: the global key dispatcher, the Cmd+K
 * palette (hints), the shortcuts cheat-sheet, and tooltips.
 *
 * Binding grammar (canonical form, produced by `normalizeBinding`):
 *   - chord     "mod+shift+k", "?", "mod+/"      (one step)
 *   - sequence  "g o", "c j"                     (steps separated by a space)
 * "mod" = Cmd on macOS, Ctrl elsewhere. The literal "+" key is written "plus".
 */

export type Platform = 'mac' | 'other';
export type ShortcutCategory = 'general' | 'navigation' | 'create';
/** 'global' is always active; other contexts are activated by mounted UI. */
export type ShortcutContext = 'global' | 'dashboard';

export interface ShortcutDef {
  /** Stable id, e.g. "nav.calendar". Also the i18n key suffix. */
  id: string;
  binding: string;
  category: ShortcutCategory;
  /** English label; the UI resolves `shortcuts.items.<id>` with this as default. */
  defaultLabel: string;
  context: ShortcutContext;
  /** Navigation shortcuts: route to open. */
  href?: string;
  /** Navigation shortcuts: router state to pass. */
  state?: unknown;
  /** May fire while focus is in an input (chords with "mod" only). */
  allowInInput?: boolean;
  /** May fire while a modal dialog is open. */
  allowInDialog?: boolean;
  /** Default true. */
  customizable?: boolean;
}

export interface Step {
  key: string;
  mod: boolean;
  alt: boolean;
  shift: boolean;
}

export interface KeyEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

// ---------------------------------------------------------------------------
// Parsing / normalisation
// ---------------------------------------------------------------------------

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  ' ': 'space',
  spacebar: 'space',
  '+': 'plus',
};

const NAMED_KEYS = new Set([
  'escape', 'enter', 'tab', 'space', 'backspace', 'delete', 'plus',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'home', 'end', 'pageup', 'pagedown',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'meta', 'altgraph', 'os']);
const MAX_STEPS = 3;

/** Symbol keys (`?`, `/`, `>`…) are produced with Shift on some layouts, so Shift is not part of their identity. */
export function isShiftInsensitive(key: string): boolean {
  return key.length === 1 && !/[a-z0-9]/.test(key);
}

function normalizeKeyToken(raw: string): string | null {
  const lower = raw.toLowerCase();
  const key = KEY_ALIASES[lower] ?? lower;
  if (key.length === 1) return key === ' ' ? 'space' : key;
  return NAMED_KEYS.has(key) ? key : null;
}

function parseStep(raw: string): Step | null {
  const token = raw.trim();
  if (!token) return null;
  // Allow a trailing literal "+" key only via the "plus" alias.
  const parts = token.split('+');
  if (parts.some((p) => p.trim() === '')) return null;
  const mods = parts.slice(0, -1).map((p) => p.trim().toLowerCase());
  const key = normalizeKeyToken(parts[parts.length - 1].trim());
  if (!key) return null;
  if (mods.some((m) => m !== 'mod' && m !== 'alt' && m !== 'shift')) return null;
  if (new Set(mods).size !== mods.length) return null;
  const step: Step = { key, mod: mods.includes('mod'), alt: mods.includes('alt'), shift: mods.includes('shift') };
  if (isShiftInsensitive(key)) step.shift = false;
  return step;
}

export function parseBinding(binding: string): Step[] | null {
  if (typeof binding !== 'string') return null;
  const raw = binding.trim().split(/\s+/);
  if (raw.length === 0 || raw.length > MAX_STEPS || raw[0] === '') return null;
  const steps: Step[] = [];
  for (const r of raw) {
    const s = parseStep(r);
    if (!s) return null;
    steps.push(s);
  }
  if (steps.length > 1 && steps.some((s) => s.mod || s.alt || s.shift)) return null; // sequences are plain keys
  return steps;
}

export function stepToString(s: Step): string {
  return [s.mod ? 'mod' : '', s.alt ? 'alt' : '', s.shift ? 'shift' : '', s.key].filter(Boolean).join('+');
}

export function stepsToBinding(steps: readonly Step[]): string {
  return steps.map(stepToString).join(' ');
}

/** Canonical string, or null when invalid. */
export function normalizeBinding(binding: string): string | null {
  const steps = parseBinding(binding);
  return steps ? stepsToBinding(steps) : null;
}

// ---------------------------------------------------------------------------
// Platform + event matching
// ---------------------------------------------------------------------------

export function detectPlatform(nav?: {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}): Platform {
  const n = nav ?? (typeof navigator !== 'undefined' ? (navigator as unknown as NonNullable<typeof nav>) : undefined);
  const source = `${n?.userAgentData?.platform ?? ''} ${n?.platform ?? ''} ${n?.userAgent ?? ''}`;
  return /mac|iphone|ipad|ipod/i.test(source) ? 'mac' : 'other';
}

/** Normalised key name of an event, or null for modifier-only / dead keys. */
export function eventKeyName(e: KeyEventLike): string | null {
  if (e.altKey && e.code) {
    // On macOS Option+letter produces a different character; use the physical key.
    const letter = /^Key([A-Z])$/.exec(e.code);
    if (letter) return letter[1].toLowerCase();
    const digit = /^Digit(\d)$/.exec(e.code);
    if (digit) return digit[1];
  }
  const lower = e.key.toLowerCase();
  if (MODIFIER_KEYS.has(lower) || lower === 'dead' || lower === 'unidentified' || lower === 'process') return null;
  return KEY_ALIASES[lower] ?? lower;
}

export function stepMatches(step: Step, e: KeyEventLike, platform: Platform): boolean {
  const key = eventKeyName(e);
  if (key === null || key !== step.key) return false;
  const modDown = platform === 'mac' ? e.metaKey : e.ctrlKey;
  const otherDown = platform === 'mac' ? e.ctrlKey : e.metaKey;
  if (step.mod !== modDown) return false;
  if (otherDown) return false; // e.g. the Windows key, or Ctrl on a Mac
  if (step.alt !== e.altKey) return false;
  if (!isShiftInsensitive(step.key) && step.shift !== e.shiftKey) return false;
  return true;
}

/** Step captured from a key press (for the rebinding recorder), or null for modifier-only. */
export function stepFromEvent(e: KeyEventLike, platform: Platform): Step | null {
  const key = eventKeyName(e);
  if (key === null) return null;
  const mod = platform === 'mac' ? e.metaKey : e.ctrlKey;
  const step: Step = { key, mod, alt: e.altKey, shift: e.shiftKey };
  if (isShiftInsensitive(key)) step.shift = false;
  return step;
}

// ---------------------------------------------------------------------------
// Display: glyphs + screen-reader text
// ---------------------------------------------------------------------------

export interface KeyLabel {
  /** What is drawn inside the <kbd>. */
  glyph: string;
  /** Spoken form ("Command", "Question mark"). */
  word: string;
}

const KEY_WORDS: Record<string, string> = {
  '?': 'Question mark', '/': 'Slash', '>': 'Greater than', '@': 'At sign', '#': 'Hash',
  ',': 'Comma', '.': 'Period', ';': 'Semicolon', "'": 'Apostrophe', '[': 'Left bracket', ']': 'Right bracket',
  '-': 'Minus', '=': 'Equals', '\\': 'Backslash', '`': 'Backtick', plus: 'Plus',
};

const NAMED_GLYPHS: Record<string, KeyLabel> = {
  escape: { glyph: 'Esc', word: 'Escape' },
  enter: { glyph: '↵', word: 'Enter' },
  tab: { glyph: 'Tab', word: 'Tab' },
  space: { glyph: 'Space', word: 'Space' },
  backspace: { glyph: '⌫', word: 'Backspace' },
  delete: { glyph: 'Del', word: 'Delete' },
  arrowup: { glyph: '↑', word: 'Up arrow' },
  arrowdown: { glyph: '↓', word: 'Down arrow' },
  arrowleft: { glyph: '←', word: 'Left arrow' },
  arrowright: { glyph: '→', word: 'Right arrow' },
  home: { glyph: 'Home', word: 'Home' },
  end: { glyph: 'End', word: 'End' },
  pageup: { glyph: 'PgUp', word: 'Page up' },
  pagedown: { glyph: 'PgDn', word: 'Page down' },
  plus: { glyph: '+', word: 'Plus' },
};

export function formatStep(step: Step, platform: Platform): KeyLabel[] {
  const out: KeyLabel[] = [];
  if (step.mod) out.push(platform === 'mac' ? { glyph: '⌘', word: 'Command' } : { glyph: 'Ctrl', word: 'Control' });
  if (step.alt) out.push(platform === 'mac' ? { glyph: '⌥', word: 'Option' } : { glyph: 'Alt', word: 'Alt' });
  if (step.shift) out.push(platform === 'mac' ? { glyph: '⇧', word: 'Shift' } : { glyph: 'Shift', word: 'Shift' });
  const named = NAMED_GLYPHS[step.key];
  if (named) out.push(named);
  else if (/^f\d{1,2}$/.test(step.key)) out.push({ glyph: step.key.toUpperCase(), word: step.key.toUpperCase() });
  else out.push({ glyph: step.key.toUpperCase(), word: KEY_WORDS[step.key] ?? step.key.toUpperCase() });
  return out;
}

/** Each inner array is one step (a chord); multiple steps form a sequence. */
export function formatBinding(binding: string, platform: Platform): KeyLabel[][] {
  const steps = parseBinding(binding);
  return steps ? steps.map((s) => formatStep(s, platform)) : [];
}

/** "Command Shift K", "G then O" — for aria-label / screen readers. */
export function speakBinding(binding: string, platform: Platform, thenWord = 'then'): string {
  return formatBinding(binding, platform)
    .map((step) => step.map((k) => k.word).join(' '))
    .join(` ${thenWord} `);
}

// ---------------------------------------------------------------------------
// Resolution, overrides, conflicts
// ---------------------------------------------------------------------------

/** id -> custom binding; `null` = disabled by the user. Absent = default. */
export type Overrides = Record<string, string | null>;

export interface ResolvedShortcut {
  def: ShortcutDef;
  binding: string;
  steps: Step[];
  overridden: boolean;
}

export function resolveShortcuts(defs: readonly ShortcutDef[], overrides: Overrides): ResolvedShortcut[] {
  const out: ResolvedShortcut[] = [];
  for (const def of defs) {
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, def.id) && def.customizable !== false;
    const raw = hasOverride ? overrides[def.id] : def.binding;
    if (raw === null) continue; // disabled
    const binding = normalizeBinding(raw) ?? normalizeBinding(def.binding);
    const steps = binding ? parseBinding(binding) : null;
    if (!binding || !steps) continue;
    out.push({ def, binding, steps, overridden: hasOverride && binding !== normalizeBinding(def.binding) });
  }
  return out;
}

export function contextsOverlap(a: ShortcutContext, b: ShortcutContext): boolean {
  return a === b || a === 'global' || b === 'global';
}

const stepsEqual = (a: Step, b: Step) => a.key === b.key && a.mod === b.mod && a.alt === b.alt && a.shift === b.shift;

export type ConflictKind = 'duplicate' | 'shadow';
export interface Conflict {
  kind: ConflictKind;
  /** For 'shadow': the shorter binding that swallows the longer one's first key(s). */
  a: string;
  b: string;
  binding: string;
}

export function detectConflicts(resolved: readonly ResolvedShortcut[]): Conflict[] {
  const out: Conflict[] = [];
  for (let i = 0; i < resolved.length; i += 1) {
    for (let j = i + 1; j < resolved.length; j += 1) {
      const x = resolved[i];
      const y = resolved[j];
      if (!contextsOverlap(x.def.context, y.def.context)) continue;
      if (x.binding === y.binding) {
        out.push({ kind: 'duplicate', a: x.def.id, b: y.def.id, binding: x.binding });
        continue;
      }
      const [short, long] = x.steps.length <= y.steps.length ? [x, y] : [y, x];
      if (short.steps.length < long.steps.length && short.steps.every((s, k) => stepsEqual(s, long.steps[k]))) {
        out.push({ kind: 'shadow', a: short.def.id, b: long.def.id, binding: short.binding });
      }
    }
  }
  return out;
}

/** Browser / OS / page-local keys we refuse to rebind onto. */
const RESERVED = new Set([
  'mod+t', 'mod+w', 'mod+n', 'mod+r', 'mod+l', 'mod+q', 'mod+p', 'mod+s', 'mod+f', 'mod+d',
  'mod+shift+t', 'mod+shift+n', 'mod+shift+w', 'mod+tab', 'mod+h', 'mod+m',
  'alt+f4', 'f5', 'f11', 'f12',
  '/', 'escape', 'tab', 'enter', 'space',
]);

export function isReservedBinding(binding: string): boolean {
  const n = normalizeBinding(binding);
  return n !== null && RESERVED.has(n);
}

export type OverrideCheck =
  | { ok: true; binding: string | null }
  | { ok: false; reason: 'unknown' | 'not_customizable' | 'invalid' | 'reserved' | 'conflict'; with?: string };

export function validateOverride(
  defs: readonly ShortcutDef[],
  current: Overrides,
  id: string,
  binding: string | null,
): OverrideCheck {
  const def = defs.find((d) => d.id === id);
  if (!def) return { ok: false, reason: 'unknown' };
  if (def.customizable === false) return { ok: false, reason: 'not_customizable' };
  if (binding === null) return { ok: true, binding: null };
  const normalized = normalizeBinding(binding);
  if (!normalized) return { ok: false, reason: 'invalid' };
  if (isReservedBinding(normalized)) return { ok: false, reason: 'reserved' };
  const next = resolveShortcuts(defs, { ...current, [id]: normalized });
  const hit = detectConflicts(next).find((c) => c.a === id || c.b === id);
  if (hit) return { ok: false, reason: 'conflict', with: hit.a === id ? hit.b : hit.a };
  return { ok: true, binding: normalized };
}

/**
 * Cleans untrusted persisted data: unknown ids, unparsable/reserved bindings
 * and any override that would create a conflict are dropped (defaults win).
 */
export function sanitizeOverrides(defs: readonly ShortcutDef[], raw: unknown): Overrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const byId = new Map(defs.map((d) => [d.id, d] as const));
  const clean: Overrides = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const def = byId.get(id);
    if (!def || def.customizable === false) continue;
    if (value === null) {
      clean[id] = null;
      continue;
    }
    if (typeof value !== 'string') continue;
    const n = normalizeBinding(value);
    if (!n || isReservedBinding(n) || n === normalizeBinding(def.binding)) continue;
    clean[id] = n;
  }
  for (;;) {
    const conflicts = detectConflicts(resolveShortcuts(defs, clean));
    const culprit = conflicts
      .flatMap((c) => [c.a, c.b])
      .find((id) => typeof clean[id] === 'string');
    if (!culprit) return clean;
    delete clean[culprit];
  }
}

// ---------------------------------------------------------------------------
// Matcher (stateful sequence buffer, time injected => deterministic tests)
// ---------------------------------------------------------------------------

export const SEQUENCE_TIMEOUT_MS = 800;

export interface MatchInput {
  event: KeyEventLike & { repeat?: boolean; isComposing?: boolean };
  /** Focus is in an input/textarea/select/contenteditable/textbox. */
  typing: boolean;
  /** A modal dialog (aria-modal) is open. */
  dialogOpen: boolean;
  contexts: ReadonlySet<ShortcutContext>;
  now: number;
}

export function createMatcher(opts: {
  platform: Platform;
  timeoutMs?: number;
  /** Only shortcuts for which this returns true can fire (i.e. a handler is registered). */
  canFire?: (id: string) => boolean;
}) {
  const timeout = opts.timeoutMs ?? SEQUENCE_TIMEOUT_MS;
  let buffer: KeyEventLike[] = [];
  let lastAt = 0;

  const snapshot = (e: KeyEventLike): KeyEventLike => ({
    key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey,
  });

  return {
    reset() {
      buffer = [];
    },
    match(shortcuts: readonly ResolvedShortcut[], input: MatchInput): ResolvedShortcut | null {
      const { event, typing, dialogOpen, contexts, now } = input;
      if (event.isComposing || event.repeat) return null;
      if (eventKeyName(event) === null) return null; // bare modifier: keep the buffer

      const eligible = shortcuts.filter((s) => {
        const ctx = s.def.context;
        if (ctx !== 'global' && !contexts.has(ctx)) return false;
        if (dialogOpen && !s.def.allowInDialog) return false;
        if (typing && !(s.def.allowInInput && s.steps.length === 1 && s.steps[0].mod)) return false;
        return opts.canFire ? opts.canFire(s.def.id) : true;
      });

      // Single-step chords.
      for (const s of eligible) {
        if (s.steps.length === 1 && stepMatches(s.steps[0], event, opts.platform)) {
          buffer = [];
          return s;
        }
      }

      // Sequences are only fed by plain keys outside typing contexts.
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      if (typing || !plain) {
        buffer = [];
        return null;
      }
      if (now - lastAt > timeout) buffer = [];
      lastAt = now;
      buffer = [...buffer, snapshot(event)].slice(-MAX_STEPS);

      for (const s of eligible) {
        const n = s.steps.length;
        if (n < 2 || buffer.length < n) continue;
        const tail = buffer.slice(-n);
        if (s.steps.every((step, i) => stepMatches(step, tail[i], opts.platform))) {
          buffer = [];
          return s;
        }
      }
      return null;
    },
  };
}

/** True for elements where typing happens. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  const role = target.getAttribute('role');
  return role === 'textbox' || role === 'combobox' || role === 'searchbox';
}
