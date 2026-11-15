import type { Decorator, Preview } from '@storybook/react-vite';
import { useLayoutEffect, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { applyDocumentLanguage } from '@/lib/languageSync';
import { storybookI18n } from './i18n';
import '../src/index.css';

type Theme = 'light' | 'dark';
type Direction = 'ltr' | 'rtl';

function Shell({ theme, direction, children }: { theme: Theme; direction: Direction; children: ReactNode }) {
  useLayoutEffect(() => {
    // Same switches the app uses: <html class="dark"> (ThemeContext) and lang/dir/a11y-rtl (languageSync).
    document.documentElement.classList.toggle('dark', theme === 'dark');
    const code = direction === 'rtl' ? 'fa' : 'en';
    applyDocumentLanguage(code);
    void storybookI18n.changeLanguage(code);
  }, [theme, direction]);

  return <I18nextProvider i18n={storybookI18n}>{children}</I18nextProvider>;
}

const withVireekShell: Decorator = (Story, context) => (
  <Shell
    theme={context.globals.theme === 'dark' ? 'dark' : 'light'}
    direction={context.globals.direction === 'rtl' ? 'rtl' : 'ltr'}
  >
    <Story />
  </Shell>
);

const preview: Preview = {
  decorators: [withVireekShell],
  initialGlobals: { theme: 'light', direction: 'ltr' },
  globalTypes: {
    theme: {
      description: 'Colour theme (toggles the "dark" class on <html>)',
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        dynamicTitle: true,
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
        ],
      },
    },
    direction: {
      description: 'Text direction (LTR = English, RTL = Persian)',
      toolbar: {
        title: 'Direction',
        icon: 'transfer',
        dynamicTitle: true,
        items: [
          { value: 'ltr', title: 'LTR · English' },
          { value: 'rtl', title: 'RTL · فارسی' },
        ],
      },
    },
  },
  parameters: {
    layout: 'padded',
    // 'todo' = violations are listed in the Accessibility panel but do not fail anything yet.
    a11y: { test: 'todo' },
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
  },
};

export default preview;
