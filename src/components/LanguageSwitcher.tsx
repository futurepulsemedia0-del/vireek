import { useState, useRef, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Globe, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAccessibility } from '@/contexts/AccessibilityContext';
import { LANGUAGES, type LanguageCode } from '@/lib/i18n';

/* ------------------------------------------------------------------ */
/*  Site-wide language switcher.                                       */
/*                                                                      */
/*  This is the general-purpose switcher used in the Header/Footer     */
/*  for choosing the language of the whole site. It reads/writes the   */
/*  SAME language state as the Accessibility widget's language picker  */
/*  (via useAccessibility), so the two stay perfectly in sync — there  */
/*  is only one "current language" for the app.                        */
/* ------------------------------------------------------------------ */

interface LanguageSwitcherProps {
  variant?: 'header' | 'footer';
  className?: string;
}

export function LanguageSwitcher({ variant = 'header', className = '' }: LanguageSwitcherProps) {
  const { t } = useTranslation();
  const { language, setLanguage } = useAccessibility();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const current = LANGUAGES.find((l) => l.code === language) ?? LANGUAGES[0];

  const handleSelect = (code: LanguageCode) => {
    setLanguage(code);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('language.switchLanguage')}
        className={`focus-ring flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.8125rem] font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary ${className}`}
        data-variant={variant}
      >
        <Globe className="h-4 w-4" aria-hidden="true" />
        <span aria-hidden="true">{current.flag}</span>
        <span className="hidden sm:inline">{current.nativeName}</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            role="listbox"
            aria-label={t('language.switchLanguage')}
            className="absolute right-0 z-50 mt-2 max-h-80 w-56 overflow-y-auto rounded-2xl border border-border/70 bg-bg-secondary/95 p-1.5 shadow-2xl backdrop-blur-xl"
          >
            {LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                type="button"
                role="option"
                aria-selected={lang.code === language}
                onClick={() => handleSelect(lang.code)}
                className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[0.8125rem] text-text-primary transition-colors duration-150 hover:bg-bg-tertiary"
              >
                <span aria-hidden="true">{lang.flag}</span>
                <span className="flex-1">{lang.nativeName}</span>
                {lang.code === language && <Check className="h-3.5 w-3.5 text-accent" aria-hidden="true" />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
