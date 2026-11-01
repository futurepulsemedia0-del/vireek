import { SHORTCUT_DEFS } from './definitions';
import { sanitizeOverrides, validateOverride, normalizeBinding, type OverrideCheck, type Overrides } from './registry';

/**
 * User shortcut customisations. Persisted per user in localStorage under a
 * versioned envelope. Phase 2 (preferences service) will sync this to Supabase;
 * the shape — `{ v: 1, overrides }` — is already the one to store there.
 */
const STORAGE_PREFIX = 'vireek:shortcuts';
export const SHORTCUTS_SCHEMA_VERSION = 1;

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const keyFor = (scope: string) => `${STORAGE_PREFIX}:v${SHORTCUTS_SCHEMA_VERSION}:${scope}`;

export function loadOverrides(scope: string, storage: ReadableStorage = window.localStorage): Overrides {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(keyFor(scope)) ?? 'null');
    if (!parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== SHORTCUTS_SCHEMA_VERSION) return {};
    return sanitizeOverrides(SHORTCUT_DEFS, (parsed as { overrides?: unknown }).overrides);
  } catch {
    return {};
  }
}

export function saveOverrides(scope: string, overrides: Overrides, storage: WritableStorage = window.localStorage): void {
  try {
    if (Object.keys(overrides).length === 0) storage.removeItem(keyFor(scope));
    else storage.setItem(keyFor(scope), JSON.stringify({ v: SHORTCUTS_SCHEMA_VERSION, overrides }));
  } catch {
    /* storage blocked/full: customisation is a convenience, never an error */
  }
}

type Listener = () => void;

/** Tiny external store (React `useSyncExternalStore` compatible). */
function createShortcutStore() {
  let scope = 'anon';
  let overrides: Overrides = {};
  const listeners = new Set<Listener>();
  const emit = () => listeners.forEach((l) => l());

  const onStorage = (e: StorageEvent) => {
    if (e.key === keyFor(scope)) {
      overrides = loadOverrides(scope);
      emit();
    }
  };
  let attached = false;

  return {
    getSnapshot: (): Overrides => overrides,
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      if (!attached && typeof window !== 'undefined') {
        window.addEventListener('storage', onStorage); // keeps other tabs in sync
        attached = true;
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && attached) {
          window.removeEventListener('storage', onStorage);
          attached = false;
        }
      };
    },
    setScope(next: string) {
      if (next === scope) return;
      scope = next;
      overrides = loadOverrides(scope);
      emit();
    },
    /** Validates, then persists. Returns the validation result so the UI can explain a refusal. */
    setOverride(id: string, binding: string | null): OverrideCheck {
      const check = validateOverride(SHORTCUT_DEFS, overrides, id, binding);
      if (!check.ok) return check;
      const def = SHORTCUT_DEFS.find((d) => d.id === id);
      const next: Overrides = { ...overrides };
      if (check.binding !== null && def && normalizeBinding(def.binding) === check.binding) delete next[id];
      else next[id] = check.binding;
      overrides = next;
      saveOverrides(scope, overrides);
      emit();
      return check;
    },
    reset(id: string) {
      if (!(id in overrides)) return;
      const rest: Overrides = { ...overrides };
      delete rest[id];
      overrides = rest;
      saveOverrides(scope, overrides);
      emit();
    },
    resetAll() {
      overrides = {};
      saveOverrides(scope, overrides);
      emit();
    },
  };
}

export const shortcutStore = createShortcutStore();
