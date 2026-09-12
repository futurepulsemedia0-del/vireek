import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Keyboard } from 'lucide-react';
import type { Shortcut } from '@/lib/keyboardShortcuts';

interface KeyboardShortcutsModalProps {
  open: boolean;
  onClose: () => void;
  shortcuts: Shortcut[];
}

// ============================================================
// Renders a single key or chord visually, e.g. "mod+k" -> ⌘ K
// ============================================================

function KeyCap({ label }: { label: string }) {
  return (
    <kbd className="flex h-6 min-w-[1.5rem] items-center justify-center rounded-md border border-border bg-bg-tertiary px-1.5 text-xs font-medium text-text-primary shadow-sm">
      {label}
    </kbd>
  );
}

function isMac() {
  return typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

function renderKeys(shortcut: Shortcut) {
  if (shortcut.type === 'sequence') {
    return (
      <div className="flex items-center gap-1">
        {shortcut.keys.map((k, i) => (
          <span key={i} className="flex items-center gap-1">
            <KeyCap label={k.toUpperCase()} />
            {i < shortcut.keys.length - 1 && (
              <span className="text-xs text-text-secondary/60">then</span>
            )}
          </span>
        ))}
      </div>
    );
  }

  const parts = shortcut.combo.split('+').map((p) => p.trim());
  return (
    <div className="flex items-center gap-1">
      {parts.map((p, i) => {
        let label = p;
        if (p.toLowerCase() === 'mod') label = isMac() ? '⌘' : 'Ctrl';
        else if (p.toLowerCase() === 'shift') label = '⇧';
        else if (p.toLowerCase() === 'alt') label = isMac() ? '⌥' : 'Alt';
        else label = p.toUpperCase();
        return <KeyCap key={i} label={label} />;
      })}
    </div>
  );
}

// ============================================================
// Modal
// ============================================================

export function KeyboardShortcutsModal({ open, onClose, shortcuts }: KeyboardShortcutsModalProps) {
  useEffect(() => {
    if (!open) return;
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [open, onClose]);

  const grouped = shortcuts.reduce<Record<string, Shortcut[]>>((acc, s) => {
    (acc[s.category] ??= []).push(s);
    return acc;
  }, {});

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <Keyboard size={20} />
                </span>
                <div>
                  <h2 className="text-base font-semibold text-text-primary">Keyboard shortcuts</h2>
                  <p className="mt-0.5 text-sm text-text-secondary">Move around the dashboard without touching your mouse.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="focus-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mt-6 space-y-5">
              {Object.entries(grouped).map(([category, items]) => (
                <div key={category}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary/70">
                    {category}
                  </h3>
                  <div className="space-y-1.5">
                    {items.map((s, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between gap-4 rounded-xl border border-border bg-bg-primary px-3 py-2.5"
                      >
                        <span className="text-sm text-text-primary">{s.description}</span>
                        {renderKeys(s)}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <p className="mt-6 text-center text-xs text-text-secondary/60">
              Press <KeyCap label="?" /> anytime to reopen this panel.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
