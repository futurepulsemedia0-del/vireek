import { applyThemeColor } from '@/lib/themeColor';
import { createContext, useContext, useEffect, useRef, useState, ReactNode, useCallback } from 'react';

export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';

interface ThemeContextValue {
  theme: Theme;
  preference: ThemePreference;
  setThemePreference: (pref: ThemePreference) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);
const STORAGE_KEY = 'vireek-theme';
// Written ONLY on an explicit user choice. Legacy builds auto-saved 'system' on every
// mount, so a stored 'system' without this marker is NOT an explicit choice.
const EXPLICIT_KEY = 'vireek-theme-explicit';

function getSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    if (stored === 'system' && localStorage.getItem(EXPLICIT_KEY) === '1') return 'system';
  } catch {
    /* storage unavailable (private mode / blocked) → default */
  }
  return 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(readStoredPreference);
  const [theme, setTheme] = useState<Theme>(() =>
    preference === 'system' ? getSystemTheme() : preference
  );
  const animateRef = useRef(false);

  useEffect(() => {
    const resolved = preference === 'system' ? getSystemTheme() : preference;
    const root = document.documentElement;
    setTheme(resolved);
    if (animateRef.current) {
      animateRef.current = false;
      root.classList.add('vrk-theme-transition');
      window.setTimeout(() => root.classList.remove('vrk-theme-transition'), 220);
    }
    root.classList.toggle('dark', resolved === 'dark');
    applyThemeColor(resolved);
  }, [preference]);

  useEffect(() => {
    if (preference !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      const resolved = getSystemTheme();
      setTheme(resolved);
      document.documentElement.classList.toggle('dark', resolved === 'dark');
      applyThemeColor(resolved);
    };
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, [preference]);

  const setThemePreference = useCallback(
    (pref: ThemePreference) => {
      if (pref !== preference) animateRef.current = true;
      setPreference(pref);
      try {
        localStorage.setItem(STORAGE_KEY, pref);
        localStorage.setItem(EXPLICIT_KEY, '1');
      } catch {
        /* non-critical */
      }
    },
    [preference]
  );

  const toggleTheme = useCallback(() => {
    setThemePreference(theme === 'light' ? 'dark' : 'light');
  }, [setThemePreference, theme]);

  return (
    <ThemeContext.Provider value={{ theme, preference, setThemePreference, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
}
