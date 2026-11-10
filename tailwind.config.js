import { tailwindTheme } from './scripts/color/tailwind-colors.mjs'
import { tailwindBorderRadius } from './scripts/design/radius-tokens.mjs'
import { Z_LAYERS, EXACT_TOKENS, invert } from './scripts/design/layout-tokens.mjs'

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  future: { hoverOnlyWhenSupported: true },
  theme: {
    extend: {
      fontFamily: {
                sans: ['var(--font-sans)'],
        display: ['var(--font-display)'],
        serif: ['var(--font-serif)'],
        mono: ['var(--font-mono)'],
      },
      zIndex: Z_LAYERS,
      spacing: { touch: '44px' },
      maxWidth: invert(EXACT_TOKENS.maxW),
      minWidth: invert(EXACT_TOKENS.maxW),
      width: { 'fluid-dialog': '92vw' },
      maxHeight: invert(EXACT_TOKENS.maxH),
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
        'display-2xl': ['clamp(2.75rem, 1.5rem + 5vw, 5rem)', { lineHeight: '1.04', letterSpacing: '-0.03em', fontWeight: '400' }],
        'display-xl': ['clamp(2.25rem, 1.4rem + 3.6vw, 3.75rem)', { lineHeight: '1.08', letterSpacing: '-0.026em', fontWeight: '420' }],
        'display-lg': ['clamp(1.875rem, 1.3rem + 2.2vw, 2.75rem)', { lineHeight: '1.12', letterSpacing: '-0.022em', fontWeight: '450' }],
        'copy-lg': ['1.125rem', { lineHeight: '1.65', letterSpacing: '-0.006em' }],
        copy: ['1rem', { lineHeight: '1.6', letterSpacing: '-0.011em' }],
        note: ['0.8125rem', { lineHeight: '1.45' }],
      },
      // Colours are GENERATED from scripts/color/palette.mjs (OKLCH source of truth) — see docs/design/COLOR_TOKENS.md.
      ...tailwindTheme,
      
      borderRadius: tailwindBorderRadius(),
      
      boxShadow: {
        sm: '0 1px 2px rgba(15,15,18,0.04)',
        md: '0 2px 8px rgba(15,15,18,0.06)',
        card: '0 1px 1px rgb(15 15 18 / 0.03), 0 6px 20px -14px rgb(15 15 18 / 0.22)',
        'card-hover': '0 10px 32px -16px rgb(15 15 18 / 0.24), 0 4px 12px -8px rgb(var(--accent-primary) / 0.14)',
        'card-dark': '0 1px 1px rgb(0 0 0 / 0.4), 0 10px 28px -16px rgb(0 0 0 / 0.7)',
        'card-hover-dark': '0 14px 38px -18px rgb(0 0 0 / 0.75), 0 4px 14px -8px rgb(var(--accent-primary) / 0.18)',
        'glow-accent': '0 12px 28px -14px rgb(var(--accent-primary) / 0.4)',
        'glow-cta': '0 12px 26px -12px rgb(var(--accent-secondary) / 0.4)',
        'elevation-1': 'var(--elevation-1)',
        'elevation-2': 'var(--elevation-2)',
        'elevation-3': 'var(--elevation-3)',
        'elevation-4': 'var(--elevation-4)',
        'ring-danger-soft': '0 0 0 3px rgb(var(--danger) / 0.12)',
        'ring-accent-soft': '0 0 0 3px rgb(var(--accent-primary) / 0.12)',
        'ring-accent-faint': '0 0 0 3px rgb(var(--accent-primary) / 0.08)',
        'glow-accent-strong': '0 10px 30px -8px rgb(var(--accent-primary) / 0.5)',
        handle: '0 0 6px rgba(0,0,0,0.5)',
        spotlight: '0 0 0 9999px rgba(0,0,0,0.45)',
        showcase: '0 30px 80px -30px rgba(0,0,0,0.65)',
      },
      // transition-interactive / transition-layout جایگزین transition-all (فقط پراپرتی‌های لازم)
      transitionProperty: {
        interactive: 'color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform',
        layout: 'color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, width, height, max-height, margin, padding, inset, gap, grid-template-rows',
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
