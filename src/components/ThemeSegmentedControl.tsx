import { useRef, type KeyboardEvent } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme, type ThemePreference } from '@/contexts/ThemeContext';
import { useDirection } from '@/hooks/useDirection';

const OPTIONS: { value: ThemePreference; icon: typeof Sun; key: string; fallback: string }[] = [
  { value: 'light', icon: Sun, key: 'light', fallback: 'Light' },
  { value: 'dark', icon: Moon, key: 'dark', fallback: 'Dark' },
  { value: 'system', icon: Monitor, key: 'system', fallback: 'System' },
];

export function ThemeSegmentedControl({ labelledBy }: { labelledBy?: string }) {
  const { preference, setThemePreference } = useTheme();
  const { t } = useTranslation('dashboard');
  const { isRtl } = useDirection();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(0, OPTIONS.findIndex((o) => o.value === preference));

  const select = (index: number) => {
    const next = (index + OPTIONS.length) % OPTIONS.length;
    setThemePreference(OPTIONS[next].value);
    refs.current[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const forward = isRtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = isRtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === forward || e.key === 'ArrowDown') {
      e.preventDefault();
      select(index + 1);
    } else if (e.key === backward || e.key === 'ArrowUp') {
      e.preventDefault();
      select(index - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      select(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      select(OPTIONS.length - 1);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      className="grid grid-cols-3 gap-1 rounded-xl border border-border bg-bg-tertiary p-1"
    >
      {OPTIONS.map((option, index) => {
        const active = index === activeIndex;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => setThemePreference(option.value)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={`focus-ring flex flex-col items-center gap-1 rounded-lg px-2 py-2 text-xs font-medium transition-colors ${
              active
                ? 'bg-bg-secondary text-text-primary shadow-sm ring-1 ring-border'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            <option.icon size={16} aria-hidden="true" />
            {t(`nav.theme.${option.key}`, { defaultValue: option.fallback })}
          </button>
        );
      })}
    </div>
  );
}
