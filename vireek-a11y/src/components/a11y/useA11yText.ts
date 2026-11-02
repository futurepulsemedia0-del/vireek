import { useCallback } from 'react';
import { useAccessibility } from '@/contexts/AccessibilityContext';
import { translate, type A11yKey } from '@/lib/a11y/strings';

export function useA11yText() {
  const { language, rtl } = useAccessibility();
  const t = useCallback((key: A11yKey, vars?: Record<string, string | number>) => translate(language, key, vars), [language]);
  return { t, language, rtl };
}
