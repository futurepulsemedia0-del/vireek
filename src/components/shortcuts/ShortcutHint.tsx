import { useTranslation } from 'react-i18next';
import { PRODUCTIVITY_NS } from '@/i18n/productivityLocales';
import { formatBinding, speakBinding, type Platform } from '@/lib/shortcuts/registry';
import { usePlatform, useShortcutBinding } from '@/lib/shortcuts/useShortcuts';

interface KeyCapsProps {
  binding: string;
  platform: Platform;
  className?: string;
}

/**
 * Renders a binding as key caps (⌘ ⇧ K / Ctrl Shift K / G then O).
 * Visually `dir="ltr"` even in RTL layouts (keys are physical, not text), and
 * announced as one phrase ("Command Shift K") instead of letter by letter.
 */
export function KeyCaps({ binding, platform, className = '' }: KeyCapsProps) {
  const { t } = useTranslation(PRODUCTIVITY_NS);
  const then = t('shortcuts.then', { defaultValue: 'then' });
  const steps = formatBinding(binding, platform);
  if (steps.length === 0) return null;
  return (
    <span
      dir="ltr"
      role="img"
      aria-label={speakBinding(binding, platform, then)}
      className={`inline-flex shrink-0 items-center gap-1 ${className}`}
    >
      {steps.map((step, i) => (
        <span key={i} className="inline-flex items-center gap-1" aria-hidden="true">
          {i > 0 && <span className="text-[10px] text-text-secondary/60">{then}</span>}
          {step.map((k, j) => (
            <kbd
              key={j}
              className="flex h-6 min-w-[1.5rem] items-center justify-center rounded-md border border-border bg-bg-tertiary px-1.5 text-xs font-medium text-text-primary shadow-sm"
            >
              {k.glyph}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

/** Live hint for a registered shortcut id; renders nothing if the user turned it off. */
export function ShortcutHint({ id, className }: { id: string; className?: string }) {
  const platform = usePlatform();
  const resolved = useShortcutBinding(id);
  if (!resolved) return null;
  return <KeyCaps binding={resolved.binding} platform={platform} className={className} />;
}
