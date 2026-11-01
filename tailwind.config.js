import { tailwindTheme } from './scripts/color/tailwind-colors.mjs'
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  future: { hoverOnlyWhenSupported: true },
  theme: {
    extend: {
      fontFamily: {
        display: ['"Sora"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      transitionDuration: { fast: '120ms', base: '180ms', slow: '280ms' },
      transitionTimingFunction: { 'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)' },
      letterSpacing: {
        tightest: '-0.045em',
      },
      fontSize: {
        // Was referenced sitewide via eyebrowClass()/sectionHeadingClass() but
        // never defined, so every section-label kicker silently fell back to
        // the browser default size instead of the intended small-caps label.
        eyebrow: ['0.75rem', { lineHeight: '1.4', letterSpacing: '0.02em' }],
      },
      
      ...tailwindTheme,

      borderRadius: {
        full: '9999px',
        md: '12px',
      },
      boxShadow: {
        sm: '0 1px 2px rgba(15,15,18,0.04)',
        md: '0 2px 8px rgba(15,15,18,0.06)',
        card: '0 1px 1px rgb(15 15 18 / 0.03), 0 6px 20px -14px rgb(15 15 18 / 0.22)',
        'card-hover': '0 10px 32px -16px rgb(15 15 18 / 0.24), 0 4px 12px -8px rgb(var(--accent-primary) / 0.14)',
        'card-dark': '0 1px 1px rgb(0 0 0 / 0.4), 0 10px 28px -16px rgb(0 0 0 / 0.7)',
        'card-hover-dark': '0 14px 38px -18px rgb(0 0 0 / 0.75), 0 4px 14px -8px rgb(var(--accent-primary) / 0.18)',
        'glow-accent': '0 12px 28px -14px rgb(var(--accent-primary) / 0.4)',
        'glow-cta': '0 12px 26px -12px rgb(var(--accent-secondary) / 0.4)',
      },
      keyframes: {
        // نوار حرکتی راست‌به‌چپ و بی‌درز برای Live AI Activity Stream.
        // ترک، محتوا را دقیقاً دو بار پشت‌سرهم رندر می‌کند، پس ترنسلیت -50%
        // بدون هیچ پرش/درزی حلقه می‌شود.
        marquee: {
          '0%': { transform: 'translateX(0%)' },
          '100%': { transform: 'translateX(-50%)' },
        },
      },
      animation: {
        marquee: 'marquee 138s linear infinite',
      },
    },
  },
  plugins: [],
}
