import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Keyboard, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import { PRODUCTIVITY_NS } from '@/i18n/productivityLocales';
import { SHORTCUT_DEFS } from '@/lib/shortcuts/definitions';
import {
  speakBinding,
  stepFromEvent,
  stepsToBinding,
  type OverrideCheck,
  type ShortcutCategory,
  type ShortcutDef,
  type Step,
} from '@/lib/shortcuts/registry';
import { shortcutStore } from '@/lib/shortcuts/store';
import { usePlatform, useResolvedShortcuts, useShortcutOverrides } from '@/lib/shortcuts/useShortcuts';
import { KeyCaps } from '@/components/shortcuts/ShortcutHint';

interface KeyboardShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

const CATEGORY_ORDER: readonly ShortcutCategory[] = ['general', 'navigation', 'create'];
const SEQUENCE_RECORD_MS = 900;
const CATEGORY_LABELS: Record<ShortcutCategory, string> = { general: 'General', navigation: 'Navigation', create: 'Create' };

type Message = { tone: 'ok' | 'error'; text: string };

const ERROR_DEFAULTS: Record<Extract<OverrideCheck, { ok: false }>['reason'], string> = {
  invalid: 'That key combination is not supported.',
  reserved: 'That combination is reserved by your browser or this page.',
  conflict: 'Already used by “{{other}}”.',
  not_customizable: 'This shortcut cannot be changed.',
  unknown: 'Unknown shortcut.',
};

/**
 * Cheat-sheet AND rebinding UI. Reads everything from the central registry
 * (`@/lib/shortcuts`) — it never lists keys itself, so it can never drift from
 * what the dispatcher actually does.
 */
export function KeyboardShortcutsModal({ open, onClose }: KeyboardShortcutsModalProps) {
  const { t } = useTranslation(PRODUCTIVITY_NS);
  const reduceMotion = useReducedMotion();
  const platform = usePlatform();
  const resolved = useResolvedShortcuts();
  const overrides = useShortcutOverrides();
  const titleId = useId();
  const descId = useId();

  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  // Keep the latest `t` for the (long-lived) key recorder without restarting it.
  const tRef = useRef(t);
  tRef.current = t;

  const trapRef = useFocusTrap(open);
  useEscapeToClose(open && recordingId === null, onClose);

  useEffect(() => {
    if (!open) {
      setRecordingId(null);
      setMessage(null);
    }
  }, [open]);

  const labelFor = useCallback(
    (def: ShortcutDef) => t(`shortcuts.items.${def.id}`, { defaultValue: def.defaultLabel }),
    [t],
  );

  const errorText = useCallback(
    (res: Extract<OverrideCheck, { ok: false }>): string => {
      const other = res.with ? SHORTCUT_DEFS.find((d) => d.id === res.with) : undefined;
      return t(`shortcuts.error.${res.reason}`, {
        other: other ? labelFor(other) : '',
        defaultValue: ERROR_DEFAULTS[res.reason],
      });
    },
    [t, labelFor],
  );

  // --- key recorder (capture phase so no app shortcut can fire while recording)
  useEffect(() => {
    if (!recordingId) return undefined;
    const id = recordingId;
    let buffer: Step[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (steps: Step[]) => {
      if (timer) clearTimeout(timer);
      const res = shortcutStore.setOverride(id, stepsToBinding(steps));
      setMessage(
        res.ok
          ? { tone: 'ok', text: tRef.current('shortcuts.saved', { defaultValue: 'Shortcut updated.' }) }
          : { tone: 'error', text: errorText(res) },
      );
      setRecordingId(null);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        if (timer) clearTimeout(timer);
        setRecordingId(null);
        return;
      }
      const step = stepFromEvent(e, platform);
      if (!step) return; // bare modifier: wait for the real key
      if (step.mod || step.alt) {
        finish([step]);
        return;
      }
      buffer = [...buffer, step];
      if (timer) clearTimeout(timer);
      if (buffer.length >= 2) finish(buffer);
      else timer = setTimeout(() => finish(buffer), SEQUENCE_RECORD_MS);
    };

    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (timer) clearTimeout(timer);
    };
  }, [recordingId, platform, errorText]);

  const motionDuration = reduceMotion ? 0 : 0.2;
  const hasOverrides = Object.keys(overrides).length > 0;
  const helpBinding = resolved.find((s) => s.def.id === 'help.shortcuts');

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    defs: SHORTCUT_DEFS.filter((d) => d.category === category),
  })).filter((g) => g.defs.length > 0);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="shortcuts-backdrop"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={onClose}
        >
          <motion.div
            ref={trapRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descId}
            tabIndex={-1}
            initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: motionDuration, ease: [0.16, 1, 0.3, 1] }}
            className="max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                    <Keyboard size={20} aria-hidden="true" />
                  </span>
                  <div>
                    <h2 id={titleId} className="text-base font-semibold text-text-primary">
                      {t('shortcuts.title', { defaultValue: 'Keyboard shortcuts' })}
                    </h2>
                    <p id={descId} className="mt-0.5 text-sm text-text-secondary">
                      {t('shortcuts.subtitle', { defaultValue: 'Move around the dashboard without touching your mouse.' })}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="focus-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                  aria-label={t('shortcuts.close', { defaultValue: 'Close' })}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>

              <p className="sr-only">
                {t('shortcuts.srSummary', {
                  count: resolved.length,
                  defaultValue: '{{count}} keyboard shortcuts.',
                })}
              </p>
              <p className="mt-4 text-xs text-text-secondary">
                {t('shortcuts.customHint', {
                  defaultValue:
                    'Click Edit to change a shortcut. Shortcuts never fire while you are typing in a field.',
                })}
              </p>

              {message && (
                <p
                  role={message.tone === 'error' ? 'alert' : 'status'}
                  className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
                    message.tone === 'error'
                      ? 'border-danger/30 bg-danger/10 text-danger'
                      : 'border-border bg-bg-tertiary text-text-primary'
                  }`}
                >
                  {message.text}
                </p>
              )}

              <div className="mt-5 space-y-5">
                {grouped.map(({ category, defs }) => (
                  <section key={category} aria-label={t(`shortcuts.categories.${category}`, { defaultValue: CATEGORY_LABELS[category] })}>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary/70">
                      {t(`shortcuts.categories.${category}`, { defaultValue: CATEGORY_LABELS[category] })}
                    </h3>
                    <ul className="space-y-1.5">
                      {defs.map((def) => {
                        const current = resolved.find((s) => s.def.id === def.id);
                        const disabled = !current;
                        const isRecording = recordingId === def.id;
                        const customized = def.id in overrides;
                        const label = labelFor(def);
                        return (
                          <li
                            key={def.id}
                            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-border bg-bg-primary px-3 py-2.5"
                          >
                            <span className="min-w-0 flex-1 text-sm text-text-primary">
                              {label}
                              {customized && (
                                <span className="ms-2 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                                  {t('shortcuts.customized', { defaultValue: 'Customized' })}
                                </span>
                              )}
                            </span>

                            {isRecording ? (
                              <span className="text-xs font-medium text-accent" role="status">
                                {t('shortcuts.recording', { defaultValue: 'Press the new keys… (Esc to cancel)' })}
                              </span>
                            ) : current ? (
                              <KeyCaps binding={current.binding} platform={platform} />
                            ) : (
                              <span className="text-xs text-text-secondary">
                                {t('shortcuts.disabled', { defaultValue: 'Off' })}
                              </span>
                            )}

                            {def.customizable !== false && (
                              <span className="flex items-center gap-1">
                                {isRecording ? (
                                  <button
                                    type="button"
                                    onClick={() => setRecordingId(null)}
                                    className="focus-ring rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-bg-tertiary"
                                  >
                                    {t('shortcuts.cancel', { defaultValue: 'Cancel' })}
                                  </button>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setMessage(null);
                                        setRecordingId(def.id);
                                      }}
                                      aria-label={t('shortcuts.editAria', { action: label, defaultValue: 'Edit shortcut for {{action}}' })}
                                      className="focus-ring rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-bg-tertiary"
                                    >
                                      {t('shortcuts.edit', { defaultValue: 'Edit' })}
                                    </button>
                                    {!disabled && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          shortcutStore.setOverride(def.id, null);
                                          setMessage(null);
                                        }}
                                        className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                                      >
                                        {t('shortcuts.disable', { defaultValue: 'Turn off' })}
                                      </button>
                                    )}
                                    {customized && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          shortcutStore.reset(def.id);
                                          setMessage(null);
                                        }}
                                        aria-label={t('shortcuts.resetAria', { action: label, defaultValue: 'Reset shortcut for {{action}}' })}
                                        className="focus-ring flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                                      >
                                        <RotateCcw size={13} aria-hidden="true" />
                                      </button>
                                    )}
                                  </>
                                )}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>

              <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                {helpBinding ? (
                  <p className="text-xs text-text-secondary/80">
                    {t('shortcuts.reopen', {
                      keys: speakBinding(helpBinding.binding, platform, t('shortcuts.then', { defaultValue: 'then' })),
                      defaultValue: 'Press {{keys}} anytime to reopen this panel.',
                    })}
                  </p>
                ) : (
                  <span />
                )}
                {hasOverrides && (
                  <button
                    type="button"
                    onClick={() => {
                      shortcutStore.resetAll();
                      setMessage(null);
                    }}
                    className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary"
                  >
                    {t('shortcuts.resetAll', { defaultValue: 'Reset all to defaults' })}
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
